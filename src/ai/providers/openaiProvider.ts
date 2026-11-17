import * as vscode from 'vscode';
import { DiffFile } from '../../diff/types';
import { AIProvider, Chapter, ReviewContext, StoryNarrative } from '../types';
import { OrderingEngine } from '../orderingEngine';
import { formatDiffsForPrompt, parseProviderStoryResponse } from './responseParser';

export class OpenAIProvider implements AIProvider {
  public readonly id: string;
  public readonly displayName: string;

  constructor(private context: vscode.ExtensionContext, private isOllama: boolean = false) {
    this.id = isOllama ? 'ollama' : 'openai';
    this.displayName = isOllama ? 'Ollama (Local LLM)' : 'OpenAI / Compatible';
  }

  public async isAvailable(): Promise<boolean> {
    if (this.isOllama) {
      try {
        const config = vscode.workspace.getConfiguration('gitStory');
        const endpoint = config.get<string>('ollamaEndpoint') || 'http://localhost:11434';
        const res = await fetch(`${endpoint}/api/tags`, { method: 'GET' });
        return res.ok;
      } catch {
        return false;
      }
    }
    const key = await this.getApiKey();
    return !!key;
  }

  private async getApiKey(): Promise<string | undefined> {
    if (this.isOllama) return 'ollama'; // not needed for local Ollama
    const secret = await this.context.secrets.get('gitStory.openaiApiKey');
    if (secret) return secret;
    const config = vscode.workspace.getConfiguration('gitStory');
    const configKey = config.get<string>('openaiApiKey');
    if (configKey) return configKey;
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
    return undefined;
  }

  public async generateStory(files: DiffFile[], ctx: ReviewContext): Promise<StoryNarrative> {
    const config = vscode.workspace.getConfiguration('gitStory');
    let baseUrl = this.isOllama
      ? (config.get<string>('ollamaEndpoint') || 'http://localhost:11434') + '/v1'
      : (config.get<string>('openaiBaseUrl') || 'https://api.openai.com/v1');

    const model = this.isOllama
      ? (config.get<string>('ollamaModel') || 'llama3.2')
      : (config.get<string>('openaiModel') || 'gpt-6-luna');

    const apiKey = await this.getApiKey() || (this.isOllama ? 'ollama' : '');

    const orderedNodes = OrderingEngine.orderFiles(files);
    const diffSummaries = formatDiffsForPrompt(orderedNodes);

    const intentionBlock = ctx.intention?.promptContext ? `\n\n${ctx.intention.promptContext}` : '';
    const repoDefensesBlock = ctx.repoDefenses?.promptContext ? `\n\n${ctx.repoDefenses.promptContext}` : '';

    const baseDesc = ctx.comparison?.base.label ? `${ctx.comparison.base.label} (${ctx.comparison.base.shortHash})` : ctx.comparison?.base.shortHash;
    const targetDesc = ctx.comparison?.target.label ? `${ctx.comparison.target.label} (${ctx.comparison.target.shortHash})` : ctx.comparison?.target.shortHash;
    const targetLabel = ctx.comparison
      ? `comparison ${baseDesc} ("${ctx.comparison.base.subject}") -> ${targetDesc} ("${ctx.comparison.target.subject}")`
      : `uncommitted Git changes`;

    const prompt = `You are a principal engineer conducting a structured code review walkthrough.
Organize these Git changes (${targetLabel}) into an optimal, logical review sequence (data contracts/schemas first, then business logic, then API endpoints, UI, and tests/config).

CRITICAL INSTRUCTIONS:
1. Do NOT write fiction, novel-like prose, or dramatized story text.
2. Do NOT use book metaphors, "chapters", "prologues", "acts", or phrases like "In Chapter 1, we...".
3. Instead, guide the reviewer through each changed file in a logical technical sequence. Explain why each file changed, how it connects to and builds upon preceding changes in this sequence, and what specifically needs attention.
4. For each file/step, highlight real potential issues: bugs, race conditions, edge cases, missing null/error handling, security vulnerabilities, or performance regressions with exact line numbers where possible.
5. CROSS-CHECK REPOSITORY DEFENSES: Before proposing any warning, bug, or suggestion, cross-check whether the concern is already handled in surrounding code, imported modules, middleware, or existing validators in the repository. If error handling, input validation, null checking, rate limiting, or authentication is already addressed, DO NOT suggest it as an issue.
6. When referring to code elements in the narrative, keyPoints, or issues (such as variable names, function names, types, class names, file paths, parameters, or short code snippets), ALWAYS format them in markdown backticks (e.g. \`SessionService\`, \`validateToken()\`, \`userId\`, \`redis.get()\`) so they stand out distinctly as code.
7. Provide a suggested conventional commit message.

Respond strictly in valid JSON:
{
  "title": "A concise, professional technical summary title for the changeset",
  "synopsis": "A 1-2 paragraph architectural overview explaining the overarching intent and impact of these changes",
  "suggestedCommitMessage": "feat(scope): conventional commit message with bullet points",
  "chapters": [
    {
      "filePath": "relative/file/path",
      "title": "Concise technical title for this step (e.g. Session Model Definition, Redis Fallback Cache Handler)",
      "role": "Architectural layer/role (e.g. Data Contract & Schema, Core Business Logic, UI Component, Unit Test)",
      "summary": "Brief 1-line technical summary of changes",
      "narrative": "A cohesive, professional technical explanation of why this file changed, how it builds on earlier changes in this sequence, and what the reviewer should verify.",
      "keyPoints": ["Key change 1", "Key change 2"],
      "issues": [
        {
          "id": "iss-1",
          "severity": "warning | security | suggestion | bug | perf",
          "severityLevel": "critical | high | medium | low | info",
          "title": "Issue title",
          "description": "Explanation",
          "lineNumber": 15,
          "suggestion": "Fix"
        }
      ]
    }
  ]
}
${intentionBlock}
${repoDefensesBlock}

Repository: ${ctx.repoName}
${ctx.comparison ? `Comparison: ${ctx.comparison.base.shortHash} -> ${ctx.comparison.target.shortHash}` : `Branch: ${ctx.branch || 'main'}`}
Diffs:
${diffSummaries}`;

    let useJsonMode = !this.isOllama;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const body: Record<string, unknown> = {
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
        };
        if (useJsonMode) {
          body.response_format = { type: 'json_object' };
        }

        const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(60000)
          : undefined;
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });

        if (!res.ok) {
          const err = await res.text();
          // Some OpenAI-compatible endpoints reject response_format: json_object with HTTP 400
          if (res.status === 400 && useJsonMode && /response_format|json_object/i.test(err)) {
            useJsonMode = false;
            continue;
          }
          lastError = new Error(`OpenAI API error (${res.status}): ${err}`);
          if ((res.status === 429 || res.status >= 500) && attempt === 0) {
            if (typeof setTimeout === 'function') {
              await new Promise(resolve => setTimeout(resolve, 800));
            }
            continue;
          }
          throw lastError;
        }

        const data: any = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error('Empty response from AI endpoint.');

        return parseProviderStoryResponse(content, files, ctx, 'Review Walkthrough');
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === 0 && (err instanceof SyntaxError || /empty response|valid JSON/i.test(lastError.message))) {
          continue;
        }
        throw lastError;
      }
    }

    throw lastError || new Error('OpenAI-compatible request failed.');
  }

  public async askQuestion(question: string, chapter: Chapter, diffSnippet: string): Promise<string> {
    const config = vscode.workspace.getConfiguration('gitStory');
    const baseUrl = this.isOllama
      ? (config.get<string>('ollamaEndpoint') || 'http://localhost:11434') + '/v1'
      : (config.get<string>('openaiBaseUrl') || 'https://api.openai.com/v1');

    const model = this.isOllama
      ? (config.get<string>('ollamaModel') || 'llama3.2')
      : (config.get<string>('openaiModel') || 'gpt-6-luna');

    const apiKey = await this.getApiKey() || (this.isOllama ? 'ollama' : '');

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `You are assisting a developer reviewing "${chapter.filePath}" (${chapter.role}). Provide concise, constructive insights.`
          },
          {
            role: 'user',
            content: `Context:\n${chapter.narrative}\n\nDiff snippet:\n${diffSnippet}\n\nQuestion: ${question}`
          }
        ],
        temperature: 0.3,
      }),
    });

    if (!res.ok) return `Error querying AI endpoint: ${res.statusText}`;
    const data: any = await res.json();
    return data.choices?.[0]?.message?.content || 'No response generated.';
  }
}
