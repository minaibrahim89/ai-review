import * as vscode from 'vscode';
import { DiffFile } from '../../diff/types';
import { AIProvider, Chapter, ReviewContext, StoryNarrative } from '../types';
import { OrderingEngine } from '../orderingEngine';
import {
  buildComparisonSummaryPromptSnippet,
  createCombinedAbortSignal,
  formatDiffsForPrompt,
  isCancellationError,
  parseProviderStoryResponse,
  ReviewCancelledError,
  throwIfCancelled,
} from './responseParser';

export class GeminiProvider implements AIProvider {
  public readonly id = 'gemini';
  public readonly displayName = 'Google Gemini';

  constructor(private context: vscode.ExtensionContext) {}

  public async isAvailable(): Promise<boolean> {
    const key = await this.getApiKey();
    return !!key;
  }

  private async getApiKey(): Promise<string | undefined> {
    // 1. SecretStorage
    const secret = await this.context.secrets.get('gitStory.geminiApiKey');
    if (secret) return secret;

    // 2. Settings configuration
    const config = vscode.workspace.getConfiguration('gitStory');
    const configKey = config.get<string>('geminiApiKey');
    if (configKey) return configKey;

    // 3. Environment variable
    if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;

    return undefined;
  }

  public async generateStory(files: DiffFile[], ctx: ReviewContext): Promise<StoryNarrative> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Google Gemini API Key is missing. Configure it via command "Git Story: Configure AI Provider & API Key".');
    }

    const config = vscode.workspace.getConfiguration('gitStory');
    const model = config.get<string>('geminiModel') || 'gemini-3.8-flash';

    // First use OrderingEngine as topological baseline
    const orderedNodes = OrderingEngine.orderFiles(files);
    const diffSummaries = formatDiffsForPrompt(orderedNodes);

    const intentionBlock = ctx.intention?.promptContext ? `\n\n${ctx.intention.promptContext}` : '';
    const repoDefensesBlock = ctx.repoDefenses?.promptContext ? `\n\n${ctx.repoDefenses.promptContext}` : '';

    const baseDesc = ctx.comparison?.base.label ? `${ctx.comparison.base.label} (${ctx.comparison.base.shortHash})` : ctx.comparison?.base.shortHash;
    const targetDesc = ctx.comparison?.target.label ? `${ctx.comparison.target.label} (${ctx.comparison.target.shortHash})` : ctx.comparison?.target.shortHash;
    const targetLabel = ctx.comparison
      ? `comparison ${baseDesc} ("${ctx.comparison.base.subject}") -> ${targetDesc} ("${ctx.comparison.target.subject}")`
      : `uncommitted Git changes`;

    const systemPrompt = `You are a principal engineer conducting a structured code review walkthrough.
Your task is to organize these Git changes (${targetLabel}) into an optimal, logical review sequence (foundations/contracts first, then business logic, then API endpoints, UI, and tests/configuration), so the reviewer can understand the changes in a clear, logical progression.

CRITICAL INSTRUCTIONS:
1. Do NOT write fiction, novel-like prose, or dramatized story text.
2. Do NOT use book metaphors, "chapters", "prologues", "acts", or phrases like "In Chapter 1, we...".
3. Instead, guide the reviewer through each changed file in a logical technical sequence. Explain why each file changed, how it connects to and builds upon preceding changes in this sequence, and what specifically needs attention.
4. For each file/step, highlight real potential issues: bugs, race conditions, edge cases, missing null/error handling, security vulnerabilities, or performance regressions with exact line numbers where possible.
5. CROSS-CHECK REPOSITORY DEFENSES: Before proposing any warning, bug, or suggestion, cross-check whether the concern is already handled in surrounding code, imported modules, middleware, or existing validators in the repository. If error handling, input validation, null checking, rate limiting, or authentication is already addressed, DO NOT suggest it as an issue.
6. When referring to code elements in the narrative, keyPoints, or issues (such as variable names, function names, types, class names, file paths, parameters, or short code snippets), ALWAYS format them in markdown backticks (e.g. \`SessionService\`, \`validateToken()\`, \`userId\`, \`redis.get()\`) so they stand out distinctly as code.
7. Provide a suggested conventional commit message.

Return strictly valid JSON with this schema:
{
  "title": "A concise, professional technical summary title for the changeset",
  "synopsis": "A 1-2 paragraph architectural overview explaining the overarching intent and impact of these changes",
  "suggestedCommitMessage": "feat(scope): conventional commit message with bullet points",
  "chapters": [
    {
      "filePath": "relative/path/to/file",
      "title": "Concise technical title for this step (e.g. Session Model Definition, Redis Fallback Cache Handler)",
      "role": "Architectural layer/role (e.g. Data Contract & Schema, Core Business Logic, UI Component, Unit Test)",
      "summary": "Brief 1-line technical summary of changes",
      "narrative": "A cohesive, professional technical explanation of why this file changed, how it builds on earlier changes in this sequence, and what the reviewer should verify.",
      "keyPoints": ["Key change or design decision 1", "Key change or design decision 2"],
      "issues": [
        {
          "id": "iss-1",
          "severity": "warning | security | suggestion | bug | perf",
          "severityLevel": "critical | high | medium | low | info",
          "title": "Concise issue title",
          "description": "Detailed explanation of why this is a concern and how to improve it",
          "lineNumber": 42,
          "suggestion": "Specific code fix or check"
        }
      ]
    }
  ]
}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const comparisonSummarySnippet = buildComparisonSummaryPromptSnippet(ctx);

    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: `${systemPrompt}${comparisonSummarySnippet}${intentionBlock}${repoDefensesBlock}\n\nRepository: ${ctx.repoName}\n${ctx.comparison ? `Comparison: ${ctx.comparison.base.shortHash} -> ${ctx.comparison.target.shortHash}` : `Branch: ${ctx.branch || 'main'}`}\n\nDiff Content:\n${diffSummaries}` }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      }
    };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      throwIfCancelled(ctx.signal);
      const { signal, cleanup } = createCombinedAbortSignal(ctx.signal, 60000);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal,
        });

        if (!response.ok) {
          const errText = await response.text();
          const retryable = response.status === 429 || response.status >= 500;
          lastError = new Error(`Gemini API error (${response.status}): ${errText}`);
          if (retryable && attempt === 0 && !ctx.signal?.aborted) {
            if (typeof setTimeout === 'function') {
              await new Promise(resolve => setTimeout(resolve, 800));
            }
            throwIfCancelled(ctx.signal);
            continue;
          }
          throw lastError;
        }

        const data: any = await response.json();
        const textOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textOutput) {
          throw new Error('Gemini returned an empty response.');
        }

        return parseProviderStoryResponse(textOutput, files, ctx, 'Review Story');
      } catch (err: any) {
        if (isCancellationError(err, ctx.signal)) {
          throw new ReviewCancelledError();
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === 0 && (err instanceof SyntaxError || /empty response|valid JSON/i.test(lastError.message))) {
          continue;
        }
        throw lastError;
      } finally {
        cleanup();
      }
    }

    throw lastError || new Error('Gemini request failed.');
  }

  public async askQuestion(question: string, chapter: Chapter, diffSnippet: string): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) return 'Gemini API key is not configured.';

    const config = vscode.workspace.getConfiguration('gitStory');
    const model = config.get<string>('geminiModel') || 'gemini-3.8-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const prompt = `You are assisting a developer reviewing file "${chapter.filePath}" (${chapter.role}).
Review Walkthrough Context: ${chapter.narrative}

Diff snippet:
${diffSnippet}

Reviewer Question:
${question}

Answer concisely, focusing on technical correctness, safety, and code design. Keep the tone friendly and direct.`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 }
      })
    });

    if (!response.ok) {
      return `Error querying Gemini: ${response.statusText}`;
    }

    const data: any = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
  }
}
