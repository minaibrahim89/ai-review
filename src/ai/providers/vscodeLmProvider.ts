import * as vscode from 'vscode';
import { DiffFile } from '../../diff/types';
import { AIProvider, Chapter, ReviewContext, StoryNarrative } from '../types';
import { OrderingEngine } from '../orderingEngine';
import {
  buildComparisonSummaryPromptSnippet,
  formatDiffsForPrompt,
  isCancellationError,
  parseProviderStoryResponse,
  ReviewCancelledError,
  throwIfCancelled,
} from './responseParser';

export class VSCodeLMProvider implements AIProvider {
  public readonly id = 'vscode-lm';
  public readonly displayName = 'VS Code Language Model (Copilot / Built-in)';

  public async isAvailable(): Promise<boolean> {
    try {
      if (!vscode.lm || !vscode.lm.selectChatModels) {
        return false;
      }
      const models = await vscode.lm.selectChatModels();
      return models.length > 0;
    } catch {
      return false;
    }
  }

  private async getCandidateModels(): Promise<vscode.LanguageModelChat[]> {
    try {
      const allModels = await vscode.lm.selectChatModels();
      if (allModels.length === 0) return [];

      // Prioritize stronger chat families while keeping all models as fallbacks
      const preferredOrder = ['gpt-6-luna', 'gpt-4o', 'claude-3.5-sonnet', 'claude-3.7-sonnet', 'gemini', 'gpt-4'];
      const rank = (m: vscode.LanguageModelChat) => {
        const key = `${m.family || ''} ${m.id || ''}`.toLowerCase();
        const idx = preferredOrder.findIndex(p => key.includes(p));
        return idx === -1 ? preferredOrder.length : idx;
      };
      return [...allModels].sort((a, b) => rank(a) - rank(b));
    } catch {
      return [];
    }
  }

  private async getChatModel(): Promise<vscode.LanguageModelChat | undefined> {
    const models = await this.getCandidateModels();
    return models[0];
  }

  public async generateStory(files: DiffFile[], ctx: ReviewContext): Promise<StoryNarrative> {
    const models = await this.getCandidateModels();
    if (models.length === 0) {
      throw new Error('No VS Code language model found. Ensure GitHub Copilot or a language model provider extension is installed.');
    }

    const orderedNodes = OrderingEngine.orderFiles(files);
    const diffSummaries = formatDiffsForPrompt(orderedNodes);

    const intentionBlock = ctx.intention?.promptContext ? `\n\n${ctx.intention.promptContext}` : '';
    const repoDefensesBlock = ctx.repoDefenses?.promptContext ? `\n\n${ctx.repoDefenses.promptContext}` : '';

    const baseDesc = ctx.comparison?.base.label ? `${ctx.comparison.base.label} (${ctx.comparison.base.shortHash})` : ctx.comparison?.base.shortHash;
    const targetDesc = ctx.comparison?.target.label ? `${ctx.comparison.target.label} (${ctx.comparison.target.shortHash})` : ctx.comparison?.target.shortHash;
    const scopeDescription = ctx.comparison
      ? `comparing ${baseDesc} ("${ctx.comparison.base.subject}") to ${targetDesc} ("${ctx.comparison.target.subject}")`
      : `${ctx.branch || 'main'}`;

    const comparisonSummarySnippet = buildComparisonSummaryPromptSnippet(ctx);

    const prompt = `You are a principal engineer conducting a structured code review walkthrough.
Analyze these Git changes in repository "${ctx.repoName}" (${scopeDescription}).
Organize the files into an optimal, logical review sequence (data contracts/schemas first, then business logic, then API endpoints, then UI, then tests/configs).

CRITICAL INSTRUCTIONS:
1. Do NOT write fiction, novel-like prose, or dramatized story text.
2. Do NOT use book metaphors, "chapters", "prologues", "acts", or phrases like "In Chapter 1, we...".
3. Instead, guide the reviewer through each changed file in a logical technical sequence. Explain why each file changed, how it connects to and builds upon preceding changes in this sequence, and what specifically needs attention.
4. For each file/step, highlight real potential issues: bugs, race conditions, edge cases, missing null/error handling, security vulnerabilities, or performance regressions with exact line numbers where possible.
5. CROSS-CHECK REPOSITORY DEFENSES: Before proposing any warning, bug, or suggestion, cross-check whether the concern is already handled in surrounding code, imported modules, middleware, or existing validators in the repository. If error handling, input validation, null checking, rate limiting, or authentication is already addressed, DO NOT suggest it as an issue.
6. When referring to code elements in the narrative, keyPoints, or issues (such as variable names, function names, types, class names, file paths, parameters, or short code snippets), ALWAYS format them in markdown backticks (e.g. \`SessionService\`, \`validateToken()\`, \`userId\`, \`redis.get()\`) so they stand out distinctly as code.
7. Provide a suggested conventional commit message.

Respond strictly with valid JSON (no markdown fences, no extra text):
{
  "title": "A concise, professional technical summary title for the changeset",
  "synopsis": "A 1-2 paragraph architectural overview explaining the overarching intent and impact of these changes",
  "suggestedCommitMessage": "feat(scope): conventional commit message with bullet points",
  "chapters": [
    {
      "filePath": "path/to/file",
      "title": "Concise technical title for this step (e.g. Session Model Definition, Redis Fallback Cache Handler)",
      "role": "Architectural layer/role (e.g. Data Contract & Schema, Core Business Logic, UI Component, Unit Test)",
      "summary": "Brief 1-line technical summary of changes",
      "narrative": "A cohesive, professional technical explanation of why this file changed, how it builds on earlier changes in this sequence, and what the reviewer should verify.",
      "keyPoints": ["Bullet 1", "Bullet 2"],
      "issues": [
        {
          "id": "iss-1",
          "severity": "warning | security | suggestion | bug | perf",
          "severityLevel": "critical | high | medium | low | info",
          "title": "Issue title",
          "description": "Why this matters",
          "lineNumber": 12,
          "suggestion": "Fix"
        }
      ]
    }
  ]
}
${comparisonSummarySnippet}
${intentionBlock}
${repoDefensesBlock}

Diffs to analyze:
${diffSummaries}`;

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    let lastError: Error | undefined;

    for (const model of models.slice(0, 3)) {
      throwIfCancelled(ctx.signal);
      const tokenSource = new vscode.CancellationTokenSource();
      const onAbort = () => tokenSource.cancel();
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await model.sendRequest(messages, {}, tokenSource.token);
        let fullText = '';
        for await (const chunk of response.text) {
          throwIfCancelled(ctx.signal);
          fullText += chunk;
        }
        return parseProviderStoryResponse(fullText, files, ctx, 'Review Walkthrough');
      } catch (err: any) {
        if (isCancellationError(err, ctx.signal)) {
          throw new ReviewCancelledError();
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      } finally {
        ctx.signal?.removeEventListener('abort', onAbort);
        tokenSource.dispose();
      }
    }

    throw lastError || new Error('VS Code Language Model failed to generate a valid review.');
  }

  public async askQuestion(question: string, chapter: Chapter, diffSnippet: string): Promise<string> {
    const model = await this.getChatModel();
    if (!model) return 'VS Code Language Model unavailable.';

    const prompt = `Review question regarding ${chapter.filePath} (${chapter.role}):
${question}

Diff context:
${diffSnippet}

Answer concisely:`;

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const tokenSource = new vscode.CancellationTokenSource();
    const response = await model.sendRequest(messages, {}, tokenSource.token);

    let out = '';
    for await (const chunk of response.text) {
      out += chunk;
    }
    return out;
  }
}
