import { DiffFile } from '../diff/types';
import { CommitComparison, CommitRef } from '../git/types';

export type IssueSeverity = 'warning' | 'security' | 'suggestion' | 'bug' | 'perf';
export type SeverityLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface IssueCallout {
  id: string;
  severity: IssueSeverity;
  severityLevel?: SeverityLevel;
  title: string;
  description: string;
  lineNumber?: number;
  suggestion?: string;
  crossCheckVerified?: boolean;
}

/**
 * Resolves or normalizes the severity level ('critical' | 'high' | 'medium' | 'low' | 'info')
 * for an issue, taking into account explicit severityLevel, category, and descriptive keywords.
 */
export function resolveSeverityLevel(issue: {
  severity?: string;
  severityLevel?: string;
  title?: string;
  description?: string;
}): SeverityLevel {
  if (issue.severityLevel) {
    const lvl = issue.severityLevel.toLowerCase();
    if (lvl === 'critical' || lvl === 'high' || lvl === 'medium' || lvl === 'low' || lvl === 'info') {
      return lvl as SeverityLevel;
    }
  }

  const sev = (issue.severity || '').toLowerCase();
  const text = `${issue.title || ''} ${issue.description || ''}`.toLowerCase();

  // Critical-level signals
  if (
    text.includes('critical') ||
    text.includes('vulnerability') ||
    text.includes('hardcoded secret') ||
    text.includes('injection') ||
    text.includes('auth bypass') ||
    text.includes('rce') ||
    text.includes('token leak')
  ) {
    return 'critical';
  }

  // High-level signals
  if (sev === 'security' || sev === 'bug' || text.includes('high severity') || text.includes('security risk')) {
    return 'high';
  }

  // Medium-level signals
  if (sev === 'warning' || sev === 'perf' || text.includes('warning') || text.includes('performance regression')) {
    return 'medium';
  }

  // Low / Info
  if (sev === 'suggestion' || text.includes('suggestion') || text.includes('todo') || text.includes('style')) {
    return 'low';
  }

  return 'medium';
}

export interface ReviewStep {
  index: number;
  filePath: string;
  title: string;
  role: string;
  summary: string;
  narrative: string;
  keyPoints: string[];
  issues: IssueCallout[];
  isReviewed?: boolean;
  isPending?: boolean;
  diffFile?: DiffFile;
}

// Backward-compatible alias
export type Chapter = ReviewStep;

export interface IntentionSource {
  type: 'doc' | 'copilot-chat' | 'git' | 'open-editor';
  title: string;
  sourcePath?: string;
  excerpt: string;
  relevanceScore: number;
}

export interface IntentionAnalysis {
  summary: string;
  sources: IntentionSource[];
  promptContext: string;
}

export interface FileDefenseContext {
  filePath: string;
  imports: string[];
  existingGuards: string[];
  hasErrorHandling: boolean;
}

export interface RepoDefenseItem {
  category: 'validation' | 'error-handling' | 'security' | 'database';
  filePath: string;
  description: string;
}

export interface RepoDefenseAnalysis {
  fileDefenses: FileDefenseContext[];
  workspaceDefenses: RepoDefenseItem[];
  promptContext: string;
}

export interface ReviewContext {
  repoName: string;
  repoRoot?: string;
  branch?: string;
  comparison?: CommitComparison;
  comparisonCommits?: CommitRef[];
  targetFileContents?: Map<string, string>;
  intention?: IntentionAnalysis;
  repoDefenses?: RepoDefenseAnalysis;
  signal?: AbortSignal;
}

export interface StoryNarrative {
  title: string;
  synopsis: string;
  chapters: ReviewStep[];
  suggestedCommitMessage: string;
  intentionContext?: {
    summary: string;
    sources: string[];
  };
}

export interface AIProvider {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  generateStory(files: DiffFile[], context: ReviewContext): Promise<StoryNarrative>;
  askQuestion(question: string, chapter: Chapter, diffSnippet: string): Promise<string>;
}
