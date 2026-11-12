import * as path from 'path';
import { DiffFile } from '../../diff/types';
import { AIProvider, Chapter, IssueCallout, StoryNarrative } from '../types';
import { OrderingEngine } from '../orderingEngine';

export class HeuristicProvider implements AIProvider {
  public readonly id = 'heuristic-only';
  public readonly displayName = 'Heuristic Offline Engine';

  public async isAvailable(): Promise<boolean> {
    return true; // Always available offline
  }

  public async generateStory(files: DiffFile[], context: { repoName: string; branch?: string }): Promise<StoryNarrative> {
    const orderedNodes = OrderingEngine.orderFiles(files);
    const totalAdditions = files.reduce((acc, f) => acc + f.additions, 0);
    const totalDeletions = files.reduce((acc, f) => acc + f.deletions, 0);

    // Build overall synopsis
    const fileCount = files.length;
    const synopsis = `This changeset in **${context.repoName}** (${context.branch || 'current branch'}) modifies ${fileCount} file${fileCount > 1 ? 's' : ''} with **+${totalAdditions} additions** and **-${totalDeletions} deletions**.\n\n` +
      `The changes have been sequenced into a logical reading arc: starting with foundational schemas and business logic, progressing into endpoints and UI views, and concluding with verification tests.`;

    const chapters: Chapter[] = [];

    for (let idx = 0; idx < orderedNodes.length; idx++) {
      const node = orderedNodes[idx];
      const file = node.file;
      const filePath = file.newPath || file.oldPath;
      const basename = path.basename(filePath);

      // Analyze issues using static code smell rules
      const issues = this.detectStaticIssues(file);

      // Construct narrative for this chapter
      let narrative = `In this chapter, we inspect **${basename}**, which serves as the **${node.role}** of this feature. `;
      if (idx > 0) {
        const prev = orderedNodes[idx - 1];
        narrative += `Following the updates in **${path.basename(prev.file.newPath || prev.file.oldPath)}**, `;
      }

      if (file.status === 'added') {
        narrative += `this is a newly introduced module adding ${file.additions} lines of logic.`;
      } else if (file.status === 'deleted') {
        narrative += `this module has been removed, pruning ${file.deletions} obsolete lines.`;
      } else {
        narrative += `this file receives targeted adjustments (+${file.additions} / -${file.deletions}).`;
      }

      const keyPoints = this.summarizeKeyPoints(file);

      chapters.push({
        index: idx + 1,
        filePath,
        title: node.suggestedTitle,
        role: node.role,
        summary: `${file.status.toUpperCase()}: ${filePath} (+${file.additions} / -${file.deletions})`,
        narrative,
        keyPoints,
        issues,
        isReviewed: false,
        diffFile: file,
      });
    }

    const title = this.synthesizeStoryTitle(orderedNodes);
    const suggestedCommitMessage = this.generateCommitMessage(orderedNodes);

    return {
      title,
      synopsis,
      chapters,
      suggestedCommitMessage,
    };
  }

  public async askQuestion(question: string, chapter: Chapter, diffSnippet: string): Promise<string> {
    const qLower = question.toLowerCase();
    if (qLower.includes('issue') || qLower.includes('bug')) {
      if (chapter.issues.length === 0) {
        return `Heuristic check: No automated code smells or security flags were detected in ${chapter.filePath}. The diff appears clean.`;
      }
      return `Potential items to review in ${chapter.filePath}:\n` +
        chapter.issues.map(i => `- [${i.severity.toUpperCase()}] Line ${i.lineNumber || '?'}: ${i.title} - ${i.description}`).join('\n');
    }

    if (qLower.includes('why') || qLower.includes('summary')) {
      return `This file acts as the **${chapter.role}**. Key changes include:\n` +
        chapter.keyPoints.map(p => `- ${p}`).join('\n');
    }

    return `Heuristic analysis: ${chapter.filePath} (${chapter.role}) has ${chapter.diffFile?.additions || 0} additions and ${chapter.diffFile?.deletions || 0} deletions. Configure a Gemini or VS Code LM provider in settings for deep interactive Q&A.`;
  }

  private detectStaticIssues(file: DiffFile): IssueCallout[] {
    const issues: IssueCallout[] = [];
    let issueCount = 0;

    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type !== 'add') continue;
        const text = line.content;
        const lineNum = line.newLineNumber;

        // 1. Leftover debugging statements
        if (/(console\.(log|debug|trace)|debugger;)/.test(text)) {
          issues.push({
            id: `issue-${++issueCount}`,
            severity: 'warning',
            title: 'Debugging Statement in Commit',
            description: 'A console or debugger call was added. Ensure this is intentional before committing.',
            lineNumber: lineNum,
            suggestion: 'Remove temporary debug logging statements.',
          });
        }

        // 2. Unsafe JSON.parse without fallback or validation
        if (/JSON\.parse\s*\(/.test(text) && !/try\s*\{/.test(text)) {
          issues.push({
            id: `issue-${++issueCount}`,
            severity: 'suggestion',
            title: 'Potential Unhandled JSON Parse Error',
            description: 'JSON.parse can throw a SyntaxError on malformed or null payloads.',
            lineNumber: lineNum,
            suggestion: 'Wrap JSON.parse in a try/catch or validate with a schema parser.',
          });
        }

        // 3. Exposed secret / token patterns
        if (/(api_key|secret_key|private_key|auth_token)\s*[:=]\s*['"][a-zA-Z0-9_\-]{8,}['"]/i.test(text)) {
          issues.push({
            id: `issue-${++issueCount}`,
            severity: 'security',
            title: 'Potential Hardcoded Secret',
            description: 'A literal secret or token credential was detected in the diff.',
            lineNumber: lineNum,
            suggestion: 'Move secrets to environment variables or secret vaults.',
          });
        }

        // 4. Loose TypeScript any types
        if (/:\s*any\b/.test(text)) {
          issues.push({
            id: `issue-${++issueCount}`,
            severity: 'suggestion',
            title: 'Explicit "any" Type Usage',
            description: 'Using `any` disables TypeScript type checking for this expression.',
            lineNumber: lineNum,
            suggestion: 'Consider using `unknown` or creating a dedicated interface.',
          });
        }

        // 5. Unresolved TODO or FIXME
        if (/\b(TODO|FIXME|HACK)\b/i.test(text)) {
          issues.push({
            id: `issue-${++issueCount}`,
            severity: 'suggestion',
            title: 'Unresolved TODO / FIXME Note',
            description: `Review note found: "${text.trim()}". Verify if it must be addressed in this commit.`,
            lineNumber: lineNum,
          });
        }
      }
    }

    return issues;
  }

  private summarizeKeyPoints(file: DiffFile): string[] {
    const points: string[] = [];
    if (file.isBinary) {
      points.push('Binary asset modified');
      return points;
    }

    points.push(`${file.additions} lines added, ${file.deletions} lines deleted across ${file.hunks.length} diff hunk${file.hunks.length > 1 ? 's' : ''}`);

    // Detect function / class signatures in added lines
    const addedSignatures: string[] = [];
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'add') {
          const fnMatch = line.content.match(/(?:function|class|interface|type|const)\s+([A-Za-z0-9_]+)/);
          if (fnMatch && !addedSignatures.includes(fnMatch[1])) {
            addedSignatures.push(fnMatch[1]);
            if (addedSignatures.length >= 3) break;
          }
        }
      }
      if (addedSignatures.length >= 3) break;
    }

    if (addedSignatures.length > 0) {
      points.push(`Introduced/modified symbols: ${addedSignatures.map(s => `\`${s}\``).join(', ')}`);
    }

    return points;
  }

  private synthesizeStoryTitle(nodes: { file: DiffFile; role: string }[]): string {
    const hasModels = nodes.some(n => n.role.includes('Schema') || n.role.includes('Contract'));
    const hasUI = nodes.some(n => n.role.includes('Interface') || n.role.includes('Presentation'));
    const hasCore = nodes.some(n => n.role.includes('Core'));

    if (hasModels && hasCore && hasUI) {
      return 'Full-Stack Feature Implementation';
    }
    if (hasModels && hasCore) {
      return 'Core Domain & Data Architecture Update';
    }
    if (hasUI) {
      return 'User Interface & Presentation Refinements';
    }
    return `Changes across ${nodes.length} file${nodes.length > 1 ? 's' : ''}`;
  }

  private generateCommitMessage(nodes: { file: DiffFile; role: string }[]): string {
    const primary = nodes[0];
    const basename = path.basename(primary.file.newPath || primary.file.oldPath);
    let type = 'feat';

    if (nodes.every(n => n.role.includes('Test'))) {
      type = 'test';
    } else if (nodes.every(n => n.role.includes('Doc'))) {
      type = 'docs';
    } else if (nodes.every(n => n.role.includes('Config'))) {
      type = 'chore';
    }

    return `${type}: update ${basename} and related modules\n\n- ${nodes.map(n => `Review ${path.basename(n.file.newPath || n.file.oldPath)} (${n.role})`).slice(0, 4).join('\n- ')}`;
  }
}
