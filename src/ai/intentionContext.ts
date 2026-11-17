import type * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DiffFile } from '../diff/types';
import { CommitComparison, CommitRef } from '../git/types';
import { GitService } from '../git/gitService';
import { IntentionAnalysis, IntentionSource } from './types';

/**
 * In-memory store for active Copilot Chat interaction history and prompts,
 * populated via Chat Participants or commands.
 */
export class CopilotChatContextStore {
  private static recentTurns: { role: 'user' | 'assistant'; text: string; timestamp: number }[] = [];
  private static lastPrompt: string | undefined;

  public static setRecentPrompt(prompt: string, source: string = 'Copilot Chat'): void {
    this.lastPrompt = prompt;
    this.addTurn('user', prompt);
  }

  public static addTurn(role: 'user' | 'assistant', text: string): void {
    if (!text || text.trim().length === 0) return;
    this.recentTurns.push({ role, text: text.trim(), timestamp: Date.now() });
    if (this.recentTurns.length > 20) {
      this.recentTurns.shift();
    }
  }

  public static getLastPrompt(): string | undefined {
    return this.lastPrompt;
  }

  public static getRecentHistory(): { role: 'user' | 'assistant'; text: string }[] {
    return this.recentTurns.map(t => ({ role: t.role, text: t.text }));
  }

  public static clear(): void {
    this.recentTurns = [];
    this.lastPrompt = undefined;
  }
}

/**
 * Service that inspects the workspace, codebase documentation, Copilot Chat sessions,
 * and Git state to discover the developer's intentions behind changes.
 */
export class IntentionDetector {
  public static async detectIntention(
    repoRoot: string,
    diffFiles: DiffFile[],
    gitService?: GitService,
    extensionContext?: vscode.ExtensionContext,
    comparison?: CommitComparison,
    comparisonCommits?: CommitRef[]
  ): Promise<IntentionAnalysis> {
    const sources: IntentionSource[] = [];

    if (comparison) {
      try {
        sources.push(...this.findCommitComparisonIntentions(comparison, comparisonCommits));
        sources.push(...this.findDiffDocIntentions(diffFiles));
      } catch (err) {
        console.warn('[IntentionDetector] Error finding commit comparison intentions:', err);
      }
      return this.synthesizeAnalysis(sources);
    }

    // 1. Check documentation files (both modified in diff and existing in repo)
    try {
      const docSources = this.findDocIntentions(repoRoot, diffFiles);
      sources.push(...docSources);
    } catch (err) {
      console.warn('[IntentionDetector] Error finding doc intentions:', err);
    }

    // 2. Check Copilot Chat context (in-memory, VS Code workspace storage, global logs)
    try {
      const chatSources = this.findCopilotChatIntentions(extensionContext);
      sources.push(...chatSources);
    } catch (err) {
      console.warn('[IntentionDetector] Error finding Copilot chat intentions:', err);
    }

    // 3. Check open editors (scratchpad notes, draft plans)
    try {
      const editorSources = this.findEditorIntentions();
      sources.push(...editorSources);
    } catch (err) {
      console.warn('[IntentionDetector] Error finding editor intentions:', err);
    }

    // 4. Check Git state (recent commits, pending commit edit message)
    if (gitService && repoRoot) {
      try {
        const gitSources = await this.findGitIntentions(repoRoot, gitService);
        sources.push(...gitSources);
      } catch (err) {
        console.warn('[IntentionDetector] Error finding Git intentions:', err);
      }
    }

    return this.synthesizeAnalysis(sources);
  }

  public static findCommitComparisonIntentions(
    comparison: CommitComparison,
    comparisonCommits?: CommitRef[]
  ): IntentionSource[] {
    const baseLabel = comparison.base.label ? `${comparison.base.label} (${comparison.base.shortHash})` : comparison.base.shortHash;
    const targetLabel = comparison.target.label ? `${comparison.target.label} (${comparison.target.shortHash})` : comparison.target.shortHash;
    const baseShort = comparison.base.label || comparison.base.shortHash;
    const targetShort = comparison.target.label || comparison.target.shortHash;
    const lines = [
      `Base (From): ${baseLabel} — ${comparison.base.subject}`,
      `Target (To): ${targetLabel} — ${comparison.target.subject}`,
    ];
    if (comparisonCommits && comparisonCommits.length > 0) {
      lines.push('', 'Commits in range:');
      for (const c of comparisonCommits.slice(0, 15)) {
        lines.push(`• ${c.shortHash} ${c.subject}`);
      }
    }

    return [
      {
        type: 'git',
        title: `Commits ${baseShort} → ${targetShort}`,
        excerpt: lines.join('\n').slice(0, 1500),
        relevanceScore: 10,
      },
    ];
  }

  public static findDiffDocIntentions(diffFiles: DiffFile[]): IntentionSource[] {
    const sources: IntentionSource[] = [];

    // Documentation touched in the current changeset
    for (const file of diffFiles) {
      const p = file.newPath || file.oldPath;
      const lower = p.toLowerCase();
      if (
        lower.endsWith('.md') ||
        lower.endsWith('.rst') ||
        lower.endsWith('.txt') ||
        lower.startsWith('docs/') ||
        lower.startsWith('doc/')
      ) {
        const addedLines = file.hunks
          .flatMap(h => h.lines)
          .filter(l => l.type === 'add')
          .map(l => l.content)
          .filter(c => c.trim().length > 0)
          .slice(0, 50)
          .join('\n');

        if (addedLines.trim().length > 0) {
          sources.push({
            type: 'doc',
            title: `Modified Doc: ${p}`,
            sourcePath: p,
            excerpt: addedLines.slice(0, 1500),
            relevanceScore: 10,
          });
        }
      }
    }

    return sources;
  }

  /**
   * Scans codebase for intention-bearing documents:
   * 1) Markdown/doc files actively modified or added in the diff.
   * 2) Canonical spec/plan/task files in root or docs/ folder.
   */
  public static findDocIntentions(repoRoot: string, diffFiles: DiffFile[]): IntentionSource[] {
    const sources: IntentionSource[] = this.findDiffDocIntentions(diffFiles);

    // B. Canonical intention & specification files in workspace
    const candidateFiles = [
      'SPEC.md',
      'SPECIFICATION.md',
      'PLAN.md',
      'TASK.md',
      'TASKS.md',
      'TODO.md',
      'ROADMAP.md',
      'DESIGN.md',
      'RFC.md',
      'PR_DESCRIPTION.md',
      'PULL_REQUEST.md',
      '.github/pull_request_template.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      'docs/plan.md',
      'docs/spec.md',
      'docs/design.md',
      'docs/rfc.md',
      'docs/tasks.md',
      'docs/architecture.md',
      'docs/intent.md',
      'doc/plan.md',
      'doc/spec.md',
      'doc/design.md',
    ];

    for (const rel of candidateFiles) {
      const fullPath = path.join(repoRoot, rel);
      if (fs.existsSync(fullPath)) {
        try {
          const stat = fs.statSync(fullPath);
          const raw = fs.readFileSync(fullPath, 'utf8');
          const excerpt = this.extractDocExcerpt(raw);
          if (excerpt.length > 20) {
            const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
            const score = ageDays <= 2 ? 9 : ageDays <= 7 ? 8 : 6;
            sources.push({
              type: 'doc',
              title: `Spec Doc: ${rel}`,
              sourcePath: rel,
              excerpt,
              relevanceScore: score,
            });
          }
        } catch {
          // ignore read error
        }
      }
    }

    return sources;
  }

  /**
   * Discovers Copilot Chat context:
   * 1) In-memory CopilotChatContextStore
   * 2) VS Code workspaceStorage chatSessions
   * 3) Global Copilot debug logs
   */
  public static findCopilotChatIntentions(extensionContext?: vscode.ExtensionContext): IntentionSource[] {
    const sources: IntentionSource[] = [];

    // 1. In-memory active prompt / turn history
    const lastPrompt = CopilotChatContextStore.getLastPrompt();
    if (lastPrompt && lastPrompt.trim().length > 0) {
      sources.push({
        type: 'copilot-chat',
        title: 'Copilot Chat Active Prompt',
        excerpt: lastPrompt.trim().slice(0, 800),
        relevanceScore: 10,
      });
    }

    const turns = CopilotChatContextStore.getRecentHistory();
    if (turns.length > 0) {
      const formatted = turns
        .slice(-4)
        .map(t => `${t.role.toUpperCase()}: ${t.text}`)
        .join('\n\n');
      sources.push({
        type: 'copilot-chat',
        title: 'Copilot Chat Conversation History',
        excerpt: formatted.slice(0, 1500),
        relevanceScore: 8,
      });
    }

    // 2. VS Code workspaceStorage chatSessions folder
    if (extensionContext?.storageUri) {
      try {
        const wsStorageDir = path.dirname(extensionContext.storageUri.fsPath);
        const chatSessionsDir = path.join(wsStorageDir, 'chatSessions');
        if (fs.existsSync(chatSessionsDir)) {
          const entries = fs.readdirSync(chatSessionsDir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
              const full = path.join(chatSessionsDir, f);
              return { name: f, full, mtime: fs.statSync(full).mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);

          if (entries.length > 0) {
            const latest = entries[0];
            const content = fs.readFileSync(latest.full, 'utf8');
            const extracted = this.parseChatSessionJson(content);
            if (extracted.length > 0) {
              sources.push({
                type: 'copilot-chat',
                title: 'Copilot Workspace Chat Session',
                sourcePath: latest.name,
                excerpt: extracted.slice(0, 1500),
                relevanceScore: 8,
              });
            }
          }
        }
      } catch (err) {
        // ignore workspaceStorage read error
      }
    }

    // 3. Global Copilot Chat debug logs
    try {
      const globalLogsDir = this.findGlobalCopilotDebugDir();
      if (globalLogsDir && fs.existsSync(globalLogsDir)) {
        const dirs = fs.readdirSync(globalLogsDir)
          .map(d => {
            const full = path.join(globalLogsDir, d);
            return { name: d, full, stat: fs.statSync(full) };
          })
          .filter(d => d.stat.isDirectory())
          .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

        if (dirs.length > 0) {
          const latestLog = path.join(dirs[0].full, 'main.jsonl');
          if (fs.existsSync(latestLog)) {
            const lines = fs.readFileSync(latestLog, 'utf8').split('\n');
            const userMessages: string[] = [];
            for (const line of lines) {
              if (line.includes('user') || line.includes('prompt') || line.includes('question')) {
                try {
                  const parsed = JSON.parse(line);
                  if (parsed.message?.text) userMessages.push(parsed.message.text);
                  else if (parsed.prompt) userMessages.push(parsed.prompt);
                } catch {
                  // ignore malformed JSON line
                }
              }
            }
            if (userMessages.length > 0) {
              sources.push({
                type: 'copilot-chat',
                title: 'Copilot Debug Log Transcript',
                excerpt: userMessages.slice(-3).join('\n---\n').slice(0, 1000),
                relevanceScore: 7,
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }

    return sources;
  }

  /**
   * Scans open visible and active editor documents for draft plans, scratchpads, or task notes.
   */
  public static findEditorIntentions(): IntentionSource[] {
    const sources: IntentionSource[] = [];

    try {
      const vscode = require('vscode');
      if (!vscode || !vscode.workspace || !vscode.workspace.textDocuments) {
        return sources;
      }

      for (const doc of vscode.workspace.textDocuments) {
        if (doc.isClosed) continue;
        const text = doc.getText().trim();
        if (text.length < 25) continue;

        const basename = path.basename(doc.fileName).toLowerCase();
        const isCandidate =
          doc.isUntitled ||
          basename.includes('plan') ||
          basename.includes('task') ||
          basename.includes('todo') ||
          basename.includes('scratch') ||
          basename.includes('prompt') ||
          basename.includes('notes');

        if (isCandidate) {
          sources.push({
            type: 'open-editor',
            title: `Open Notes: ${path.basename(doc.fileName)}`,
            sourcePath: doc.isUntitled ? undefined : doc.fileName,
            excerpt: text.slice(0, 1000),
            relevanceScore: 6,
          });
        }
      }
    } catch {
      // Running in unit test or outside VS Code host
    }

    return sources;
  }

  /**
   * Inspects Git state: recent commit titles and pending commit edit messages.
   */
  public static async findGitIntentions(repoRoot: string, gitService: GitService): Promise<IntentionSource[]> {
    const sources: IntentionSource[] = [];

    // A. Pending commit message draft
    const editMsg = await gitService.getCommitEditMsg(repoRoot);
    if (editMsg && editMsg.length > 5) {
      sources.push({
        type: 'git',
        title: 'Draft Commit Message (.git/COMMIT_EDITMSG)',
        excerpt: editMsg.slice(0, 500),
        relevanceScore: 9,
      });
    }

    // B. Recent commits on this branch
    const recentCommits = await gitService.getRecentCommitMessages(repoRoot, 3);
    if (recentCommits.length > 0) {
      sources.push({
        type: 'git',
        title: 'Recent Commits',
        excerpt: recentCommits.map(c => `• ${c}`).join('\n'),
        relevanceScore: 5,
      });
    }

    return sources;
  }

  /**
   * Synthesizes discovered sources into a cohesive IntentionAnalysis with a formatted prompt block.
   */
  public static synthesizeAnalysis(sources: IntentionSource[]): IntentionAnalysis {
    if (sources.length === 0) {
      return {
        summary: '',
        sources: [],
        promptContext: '',
      };
    }

    // Deduplicate and sort by relevance score descending
    const seen = new Set<string>();
    const uniqueSources: IntentionSource[] = [];
    for (const s of sources) {
      const key = `${s.type}:${s.title}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueSources.push(s);
      }
    }
    uniqueSources.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // Limit to top 4 highest quality sources
    const topSources = uniqueSources.slice(0, 4);

    // Generate concise summary description
    const docTitles = topSources.filter(s => s.type === 'doc').map(s => s.title);
    const chatTitles = topSources.filter(s => s.type === 'copilot-chat').map(s => s.title);
    const gitTitles = topSources.filter(s => s.type === 'git').map(s => s.title);

    const parts: string[] = [];
    if (docTitles.length > 0) parts.push(`documentation (${docTitles.join(', ')})`);
    if (chatTitles.length > 0) parts.push('Copilot Chat context');
    if (gitTitles.length > 0) parts.push(`Git signals (${gitTitles.join(', ')})`);

    const summary = `Review grounded in project ${parts.join(' and ')}.`;

    // Construct structured prompt context
    let promptContext = `\n--- INTENTION & TASK CONTEXT ---\n` +
      `The changes being reviewed are guided by the following documented intentions, task specs, and Copilot context:\n\n`;

    topSources.forEach((src, idx) => {
      promptContext += `[Source ${idx + 1}: ${src.title}]\n${src.excerpt}\n\n`;
    });

    promptContext += `CRITICAL REVIEW INSTRUCTION:\n` +
      `Evaluate the code changes against these stated intentions. Verify whether the implementation satisfies the documented requirements, point out any missing edge cases or regressions against the plan, and align the narrative explanation with the developer's original goals.\n` +
      `--- END INTENTION CONTEXT ---\n`;

    return {
      summary,
      sources: topSources,
      promptContext,
    };
  }

  private static extractDocExcerpt(content: string): string {
    const lines = content.split('\n');
    const sectionsToFind = [
      'goal',
      'overview',
      'intent',
      'motivation',
      'requirement',
      'task',
      'scope',
      'architecture',
      'summary',
    ];

    let capturing = false;
    let captured: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lower = line.toLowerCase();

      if (line.startsWith('#')) {
        const matchesSection = sectionsToFind.some(sec => lower.includes(sec));
        if (matchesSection) {
          capturing = true;
          captured.push(line);
          continue;
        } else if (capturing) {
          // Reached another major heading
          if (line.startsWith('# ') || line.startsWith('## ')) {
            break;
          }
        }
      }

      if (capturing) {
        captured.push(line);
        if (captured.join('\n').length > 1200) break;
      }
    }

    if (captured.length > 0) {
      return captured.join('\n').trim();
    }

    // Fallback: first 1000 characters
    return content.trim().slice(0, 1000);
  }

  private static parseChatSessionJson(jsonStr: string): string {
    try {
      const data = JSON.parse(jsonStr);
      const requests = data.requests || data.history || [];
      const prompts: string[] = [];

      for (const req of requests) {
        if (req.message?.text) prompts.push(`USER: ${req.message.text}`);
        else if (req.prompt) prompts.push(`USER: ${req.prompt}`);
        else if (req.query) prompts.push(`USER: ${req.query}`);
      }

      return prompts.slice(-3).join('\n\n');
    } catch {
      return '';
    }
  }

  private static findGlobalCopilotDebugDir(): string | undefined {
    const home = os.homedir();
    if (process.platform === 'win32') {
      const p = path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'debug-logs');
      if (fs.existsSync(p)) return p;
    } else if (process.platform === 'darwin') {
      const p = path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'debug-logs');
      if (fs.existsSync(p)) return p;
    } else {
      const p = path.join(home, '.config', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'debug-logs');
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }
}
