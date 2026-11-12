import * as vscode from 'vscode';
import { DiffFile } from '../../diff/types';
import { AIProvider, Chapter, ReviewContext, StoryNarrative, resolveSeverityLevel } from '../types';
import { OrderingEngine } from '../orderingEngine';

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
    const diffSummaries = orderedNodes.map((n, idx) => {
      const f = n.file;
      const hunksText = f.hunks.map(h => {
        return h.lines.map(l => {
          const prefix = l.type === 'add' ? '+' : l.type === 'delete' ? '-' : ' ';
          return `${prefix}${l.content}`;
        }).slice(0, 100).join('\n');
      }).join('\n');

      return `--- File ${idx + 1}: ${f.newPath || f.oldPath} (${n.role}, ${f.status}) ---
${hunksText}`;
    }).join('\n\n');

    const intentionBlock = ctx.intention?.promptContext ? `\n\n${ctx.intention.promptContext}` : '';
    const repoDefensesBlock = ctx.repoDefenses?.promptContext ? `\n\n${ctx.repoDefenses.promptContext}` : '';

    const prompt = `You are a principal engineer conducting a structured code review walkthrough.
Organize these uncommitted Git changes into an optimal, logical review sequence (data contracts/schemas first, then business logic, then API endpoints, UI, and tests/config).

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
Branch: ${ctx.branch || 'main'}
Diffs:
${diffSummaries}`;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${err}`);
    }

    const data: any = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from AI endpoint.');

    const parsed = JSON.parse(content);
    const fileLookup = new Map(files.map(f => [f.newPath || f.oldPath, f]));

    const chapters: Chapter[] = (parsed.chapters || []).map((ch: any, i: number) => {
      const diffFile = fileLookup.get(ch.filePath) || files[i];
      return {
        index: i + 1,
        filePath: ch.filePath || (diffFile ? (diffFile.newPath || diffFile.oldPath) : `File ${i + 1}`),
        title: ch.title || `Chapter ${i + 1}`,
        role: ch.role || 'Code Module',
        summary: ch.summary || '',
        narrative: ch.narrative || '',
        keyPoints: ch.keyPoints || [],
        issues: (ch.issues || []).map((iss: any, j: number) => ({
          id: iss.id || `issue-${i}-${j}`,
          severity: iss.severity || 'warning',
          severityLevel: resolveSeverityLevel(iss),
          title: iss.title || 'Potential Issue',
          description: iss.description || '',
          lineNumber: typeof iss.lineNumber === 'number' ? iss.lineNumber : undefined,
          suggestion: iss.suggestion,
        })),
        isReviewed: false,
        diffFile,
      };
    });

    return {
      title: parsed.title || 'Review Walkthrough',
      synopsis: parsed.synopsis || '',
      suggestedCommitMessage: parsed.suggestedCommitMessage || 'feat: update changes',
      chapters,
      intentionContext: ctx.intention && ctx.intention.sources.length > 0 ? {
        summary: ctx.intention.summary,
        sources: ctx.intention.sources.map(s => s.title),
      } : undefined,
    };
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
