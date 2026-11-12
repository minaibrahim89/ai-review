import * as vscode from 'vscode';
import { DiffFile } from '../../diff/types';
import { AIProvider, Chapter, StoryNarrative } from '../types';
import { OrderingEngine } from '../orderingEngine';

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

  private async getChatModel(): Promise<vscode.LanguageModelChat | undefined> {
    try {
      const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
      if (models.length > 0) return models[0];

      const anyModels = await vscode.lm.selectChatModels();
      return anyModels.length > 0 ? anyModels[0] : undefined;
    } catch {
      return undefined;
    }
  }

  public async generateStory(files: DiffFile[], ctx: { repoName: string; branch?: string }): Promise<StoryNarrative> {
    const model = await this.getChatModel();
    if (!model) {
      throw new Error('No VS Code language model found. Ensure GitHub Copilot or a language model provider extension is installed.');
    }

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

    const prompt = `You are a principal engineer conducting a structured code review walkthrough.
Analyze these Git changes in repository "${ctx.repoName}" (${ctx.branch || 'main'}).
Organize the files into an optimal, logical review sequence (data contracts/schemas first, then business logic, then API endpoints, then UI, then tests/configs).

CRITICAL INSTRUCTIONS:
1. Do NOT write fiction, novel-like prose, or dramatized story text.
2. Do NOT use book metaphors, "chapters", "prologues", "acts", or phrases like "In Chapter 1, we...".
3. Instead, guide the reviewer through each changed file in a logical technical sequence. Explain why each file changed, how it connects to and builds upon preceding changes in this sequence, and what specifically needs attention.
4. For each file/step, highlight real potential issues: bugs, race conditions, edge cases, missing null/error handling, security vulnerabilities, or performance regressions with exact line numbers where possible.
5. Provide a suggested conventional commit message.

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
          "title": "Issue title",
          "description": "Why this matters",
          "lineNumber": 12,
          "suggestion": "Fix"
        }
      ]
    }
  ]
}

Diffs to analyze:
${diffSummaries}`;

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const tokenSource = new vscode.CancellationTokenSource();
    const response = await model.sendRequest(messages, {}, tokenSource.token);

    let fullText = '';
    for await (const chunk of response.text) {
      fullText += chunk;
    }

    // Strip code fences if model enclosed in ```json
    const cleaned = fullText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);

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
      title: parsed.title || 'Review Walkthrough',
      synopsis: parsed.synopsis || '',
      suggestedCommitMessage: parsed.suggestedCommitMessage || 'feat: update changes',
      chapters,
    };
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
