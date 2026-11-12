import * as vscode from 'vscode';
import { DiffFile } from '../../diff/types';
import { AIProvider, Chapter, StoryNarrative } from '../types';
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

  public async generateStory(files: DiffFile[], ctx: { repoName: string; branch?: string }): Promise<StoryNarrative> {
    const config = vscode.workspace.getConfiguration('gitStory');
    let baseUrl = this.isOllama
      ? (config.get<string>('ollamaEndpoint') || 'http://localhost:11434') + '/v1'
      : (config.get<string>('openaiBaseUrl') || 'https://api.openai.com/v1');

    const model = this.isOllama
      ? (config.get<string>('ollamaModel') || 'llama3.2')
      : (config.get<string>('openaiModel') || 'gpt-4o-mini');

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

    const prompt = `You are a senior software architect creating an aesthetically pleasing code review story.
Organize these changes into an optimal reading order.
Respond strictly in valid JSON:
{
  "title": "Story Title",
  "synopsis": "Overview paragraph",
  "suggestedCommitMessage": "feat: conventional commit message",
  "chapters": [
    {
      "filePath": "relative/file/path",
      "title": "Chapter title",
      "role": "Role (e.g. Data Contract, Core Business Logic, UI)",
      "summary": "1-sentence summary",
      "narrative": "Story paragraph explaining why this changed and connecting to previous chapters",
      "keyPoints": ["Key change 1", "Key change 2"],
      "issues": [
        {
          "id": "iss-1",
          "severity": "warning | security | suggestion | bug | perf",
          "title": "Issue title",
          "description": "Explanation",
          "lineNumber": 15,
          "suggestion": "Fix"
        }
      ]
    }
  ]
}

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
      title: parsed.title || 'Review Story',
      synopsis: parsed.synopsis || '',
      suggestedCommitMessage: parsed.suggestedCommitMessage || 'feat: update changes',
      chapters,
    };
  }

  public async askQuestion(question: string, chapter: Chapter, diffSnippet: string): Promise<string> {
    const config = vscode.workspace.getConfiguration('gitStory');
    const baseUrl = this.isOllama
      ? (config.get<string>('ollamaEndpoint') || 'http://localhost:11434') + '/v1'
      : (config.get<string>('openaiBaseUrl') || 'https://api.openai.com/v1');

    const model = this.isOllama
      ? (config.get<string>('ollamaModel') || 'llama3.2')
      : (config.get<string>('openaiModel') || 'gpt-4o-mini');

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
