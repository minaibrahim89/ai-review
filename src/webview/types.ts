import { CommitComparison, CommitRef, DiffScope, GitBranchInfo, GitRepoInfo } from '../git/types';
import { StoryNarrative } from '../ai/types';

export type WebviewMessageToExtension =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'cancelReview' }
  | { type: 'changeScope'; scope: DiffScope }
  | { type: 'changeRepo'; repoUri: string }
  | { type: 'requestCommits' }
  | { type: 'compareCommits'; baseRef: string; targetRef: string }
  | { type: 'swapCompareCommits' }
  | { type: 'selectChapter'; chapterIndex: number }
  | { type: 'jumpToDiffLine'; filePath: string; lineNumber: number }
  | { type: 'openDiffEditor'; filePath: string }
  | { type: 'stageFile'; filePath: string }
  | { type: 'unstageFile'; filePath: string }
  | { type: 'markReviewed'; chapterIndex: number; isReviewed: boolean }
  | { type: 'askQuestion'; question: string; chapterIndex: number }
  | { type: 'commit'; message: string }
  | { type: 'openFileInEditor'; filePath: string; line?: number }
  | { type: 'changeTheme'; themeStyle: 'zen' | 'editorial' | 'compact' }
  | {
      type: 'addressWithCopilot';
      filePath: string;
      issue: {
        id?: string;
        title: string;
        description: string;
        severity: string;
        severityLevel?: string;
        lineNumber?: number;
        suggestion?: string;
      };
    };

export type ExtensionMessageToWebview =
  | {
      type: 'init';
      payload: {
        story: StoryNarrative;
        providerName: string;
        currentRepo: GitRepoInfo;
        repos: GitRepoInfo[];
        scope: DiffScope;
        comparison?: CommitComparison;
        themeStyle: string;
      };
    }
  | {
      type: 'updateStory';
      payload: {
        story: StoryNarrative;
        providerName?: string;
        scope?: DiffScope;
        comparison?: CommitComparison;
      };
    }
  | {
      type: 'commitsList';
      payload: {
        commits: CommitRef[];
        branches?: GitBranchInfo[];
        currentBranch?: string;
        currentBase?: string;
        currentTarget?: string;
      };
    }
  | {
      type: 'compareError';
      payload: {
        message: string;
        invalidField?: 'base' | 'target' | 'both';
      };
    }
  | { type: 'setChapter'; payload: { chapterIndex: number } }
  | { type: 'answer'; payload: { question: string; answer: string; chapterIndex: number } }
  | { type: 'loading'; payload: { message: string } }
  | { type: 'reviewCancelled'; payload: { message: string } }
  | { type: 'fileStagedStatus'; payload: { filePath: string; isStaged: boolean } }
  | { type: 'commitSuccess'; payload: { message: string } }
  | { type: 'error'; payload: { message: string } }
  | { type: 'setTheme'; payload: { themeStyle: 'zen' | 'editorial' | 'compact' } };
