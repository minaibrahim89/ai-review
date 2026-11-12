import { DiffScope, GitRepoInfo } from '../git/types';
import { StoryNarrative } from '../ai/types';

export type WebviewMessageToExtension =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'changeScope'; scope: DiffScope }
  | { type: 'changeRepo'; repoUri: string }
  | { type: 'stageFile'; filePath: string }
  | { type: 'unstageFile'; filePath: string }
  | { type: 'markReviewed'; chapterIndex: number; isReviewed: boolean }
  | { type: 'askQuestion'; question: string; chapterIndex: number }
  | { type: 'commit'; message: string }
  | { type: 'openFileInEditor'; filePath: string; line?: number }
  | { type: 'toggleDiffMode'; mode: 'split' | 'unified' };

export type ExtensionMessageToWebview =
  | {
      type: 'init';
      payload: {
        story: StoryNarrative;
        providerName: string;
        currentRepo: GitRepoInfo;
        repos: GitRepoInfo[];
        scope: DiffScope;
        diffMode: 'split' | 'unified';
        themeStyle: string;
      };
    }
  | { type: 'updateStory'; payload: { story: StoryNarrative } }
  | { type: 'answer'; payload: { question: string; answer: string; chapterIndex: number } }
  | { type: 'loading'; payload: { message: string } }
  | { type: 'fileStagedStatus'; payload: { filePath: string; isStaged: boolean } }
  | { type: 'commitSuccess'; payload: { message: string } }
  | { type: 'error'; payload: { message: string } };
