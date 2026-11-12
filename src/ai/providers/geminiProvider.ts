import * as vscode from 'vscode';
import { DiffFile } from '../../diff/types';
import { AIProvider, Chapter, IssueCallout, StoryNarrative } from '../types';
import { OrderingEngine } from '../orderingEngine';

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

  public async generateStory(files: DiffFile[], ctx: { repoName: string; branch?: string }): Promise<StoryNarrative> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Google Gemini API Key is missing. Configure it via command "Git Story: Configure AI Provider & API Key".');
    }

    const config = vscode.workspace.getConfiguration('gitStory');
    const model = config.get<string>('geminiModel') || 'gemini-2.5-flash';

    // First use OrderingEngine as topological baseline
    const orderedNodes = OrderingEngine.orderFiles(files);

    // Prepare diff summary for prompt
    const diffSummaries = orderedNodes.map((n, idx) => {
      const f = n.file;
      const hunksText = f.hunks.map(h => {
        return h.lines.map(l => {
          const prefix = l.type === 'add' ? '+' : l.type === 'delete' ? '-' : ' ';
          return `${prefix}${l.content}`;
        }).slice(0, 100).join('\n'); // limit lines per hunk to keep prompt compact
      }).join('\n');

      return `--- File ${idx + 1}: ${f.newPath || f.oldPath} (${n.role}, ${f.status}) ---
${hunksText}`;
    }).join('\n\n');

    const systemPrompt = `You are an elite code reviewer and technical storyteller.
Your task is to take a set of uncommitted Git changes and craft an aesthetically pleasing, calm, distraction-free "Story" of the review.

Guidelines:
1. Figure out the best narrative reading order for the human reviewer (foundations/contracts first, then business logic, then API, then UI, then tests).
2. The narrative should read like an engaging, clear technical story where each file is a "Chapter" building logically upon previous chapters.
3. For each chapter, highlight real potential issues, bugs, race conditions, edge cases, missing null checks, security concerns, or performance regressions with the exact line number where possible.
4. Provide a suggested conventional commit message.

Return strictly valid JSON with this schema:
{
  "title": "A concise, engaging title for the entire changeset story",
  "synopsis": "A 1-2 paragraph executive prologue explaining the overarching intent and architectural impact",
  "suggestedCommitMessage": "feat(scope): conventional commit message with bullet points",
  "chapters": [
    {
      "filePath": "relative/path/to/file",
      "title": "Chapter title (e.g. The New Data Contract)",
      "role": "Architectural role (e.g. Database Schema, Core Business Logic, UI Component)",
      "summary": "Brief 1-line summary of changes",
      "narrative": "A clean, well-written story explaining why this file changed, how it connects to prior chapters, and what to pay attention to.",
      "keyPoints": ["Bullet point 1", "Bullet point 2"],
      "issues": [
        {
          "id": "iss-1",
          "severity": "warning | security | suggestion | bug | perf",
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

    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: `${systemPrompt}\n\nRepository: ${ctx.repoName}\nBranch: ${ctx.branch || 'main'}\n\nDiff Content:\n${diffSummaries}` }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    const textOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textOutput) {
      throw new Error('Gemini returned an empty response.');
    }

    const parsed = JSON.parse(textOutput);

    // Map diffFiles to chapters
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
      suggestedCommitMessage: parsed.suggestedCommitMessage || 'feat: update code changes',
      chapters,
    };
  }

  public async askQuestion(question: string, chapter: Chapter, diffSnippet: string): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) return 'Gemini API key is not configured.';

    const config = vscode.workspace.getConfiguration('gitStory');
    const model = config.get<string>('geminiModel') || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const prompt = `You are assisting a developer reviewing file "${chapter.filePath}" (${chapter.role}).
Narrative Context: ${chapter.narrative}

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
