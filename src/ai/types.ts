import { DiffFile } from '../diff/types';

export type IssueSeverity = 'warning' | 'security' | 'suggestion' | 'bug' | 'perf';

export interface IssueCallout {
  id: string;
  severity: IssueSeverity;
  title: string;
  description: string;
  lineNumber?: number;
  suggestion?: string;
}

export interface Chapter {
  index: number;
  filePath: string;
  title: string;
  role: string;
  summary: string;
  narrative: string;
  keyPoints: string[];
  issues: IssueCallout[];
  isReviewed?: boolean;
  diffFile?: DiffFile;
}

export interface StoryNarrative {
  title: string;
  synopsis: string;
  chapters: Chapter[];
  suggestedCommitMessage: string;
}

export interface AIProvider {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  generateStory(files: DiffFile[], context: { repoName: string; branch?: string }): Promise<StoryNarrative>;
  askQuestion(question: string, chapter: Chapter, diffSnippet: string): Promise<string>;
}
