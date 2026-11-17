import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { StoryAgent } from '../ai/storyAgent';
import { DiffParser } from '../diff/diffParser';
import { CommitComparison, CommitRef, DiffScope, GitRepoInfo } from '../git/types';
import { ExtensionMessageToWebview, WebviewMessageToExtension } from './types';
import { Chapter, StoryNarrative } from '../ai/types';
import {
  addressIssueWithCopilot,
  buildCommitsListPayload,
  buildWebviewHtml,
  formatRefShort,
  loadComparisonExtras,
  openChapterFileInEditor,
  openNativeDiffEditor,
  resolveAndValidateComparison,
} from './reviewHelper';

export class ReviewPanel {
  public static currentPanel: ReviewPanel | undefined;
  public static readonly viewType = 'gitStoryReview';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private gitService: GitService;
  private storyAgent: StoryAgent;

  private currentRepo?: GitRepoInfo;
  private repos: GitRepoInfo[] = [];
  private currentScope: DiffScope = 'all';
  private currentComparison?: CommitComparison;
  private currentStory?: StoryNarrative;
  private currentChapterIndex: number = 0;
  private currentProviderName: string = 'Heuristic';

  public static async createOrShow(
    extensionUri: vscode.Uri,
    gitService: GitService,
    storyAgent: StoryAgent
  ): Promise<ReviewPanel> {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.Two;

    if (ReviewPanel.currentPanel) {
      ReviewPanel.currentPanel.panel.reveal(column);
      await ReviewPanel.currentPanel.refresh();
      return ReviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      ReviewPanel.viewType,
      'Git Story: Review Walkthrough',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
        ],
      }
    );

    ReviewPanel.currentPanel = new ReviewPanel(panel, extensionUri, gitService, storyAgent);
    return ReviewPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    gitService: GitService,
    storyAgent: StoryAgent
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.gitService = gitService;
    this.storyAgent = storyAgent;

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'resources', 'book-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'resources', 'book-dark.svg'),
    };

    this.updateWebviewContent();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessageToExtension) => this.handleWebviewMessage(message),
      null,
      this.disposables
    );
  }

  private async handleWebviewMessage(message: WebviewMessageToExtension) {
    switch (message.type) {
      case 'ready': {
        await this.loadInitialData();
        break;
      }
      case 'refresh': {
        await this.refresh();
        break;
      }
      case 'changeScope': {
        this.currentScope = message.scope;
        if (message.scope !== 'commits') {
          this.currentComparison = undefined;
        }
        this.currentChapterIndex = 0;
        await this.loadStory();
        break;
      }
      case 'changeRepo': {
        const found = this.repos.find(r => r.rootUri === message.repoUri);
        if (found) {
          this.currentRepo = found;
          this.currentComparison = undefined;
          if (this.currentScope === 'commits') {
            this.currentScope = 'all';
          }
          this.currentChapterIndex = 0;
          await this.loadStory();
        }
        break;
      }
      case 'requestCommits': {
        await this.sendCommitsList();
        break;
      }
      case 'compareCommits': {
        await this.handleCompareCommitsRefs(message.baseRef, message.targetRef);
        break;
      }
      case 'swapCompareCommits': {
        if (this.currentComparison) {
          this.currentComparison = {
            base: this.currentComparison.target,
            target: this.currentComparison.base,
          };
          this.currentScope = 'commits';
          this.currentChapterIndex = 0;
          await this.loadStory();
        }
        break;
      }
      case 'selectChapter': {
        this.currentChapterIndex = message.chapterIndex;
        const chapter = this.currentStory?.chapters[this.currentChapterIndex];
        if (chapter) {
          await this.openNativeDiff(chapter);
        }
        break;
      }
      case 'jumpToDiffLine': {
        const chapter = this.currentStory?.chapters[this.currentChapterIndex];
        if (chapter) {
          await this.openNativeDiff(chapter, message.lineNumber);
        }
        break;
      }
      case 'openDiffEditor': {
        const chapter = this.currentStory?.chapters[this.currentChapterIndex];
        if (chapter) {
          await this.openNativeDiff(chapter);
        }
        break;
      }
      case 'stageFile': {
        if (this.currentRepo) {
          try {
            await this.gitService.stageFile(this.currentRepo.rootUri, message.filePath);
            this.postMessage({
              type: 'fileStagedStatus',
              payload: { filePath: message.filePath, isStaged: true }
            });
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to stage file: ${err.message}`);
          }
        }
        break;
      }
      case 'unstageFile': {
        if (this.currentRepo) {
          try {
            await this.gitService.unstageFile(this.currentRepo.rootUri, message.filePath);
            this.postMessage({
              type: 'fileStagedStatus',
              payload: { filePath: message.filePath, isStaged: false }
            });
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to unstage file: ${err.message}`);
          }
        }
        break;
      }
      case 'askQuestion': {
        await this.handleAskQuestion(message.question, message.chapterIndex);
        break;
      }
      case 'commit': {
        await this.handleCommit(message.message);
        break;
      }
      case 'openFileInEditor': {
        if (this.currentRepo) {
          const chapter = this.currentStory?.chapters[this.currentChapterIndex];
          await openChapterFileInEditor(
            this.currentRepo.rootUri,
            message.filePath,
            this.currentScope,
            this.currentComparison,
            chapter,
            message.line
          );
        }
        break;
      }
      case 'markReviewed': {
        if (this.currentStory?.chapters[message.chapterIndex]) {
          this.currentStory.chapters[message.chapterIndex].isReviewed = message.isReviewed;
        }
        break;
      }
      case 'changeTheme': {
        const config = vscode.workspace.getConfiguration('gitStory');
        await config.update('themeStyle', message.themeStyle, vscode.ConfigurationTarget.Global);
        break;
      }
      case 'addressWithCopilot': {
        await addressIssueWithCopilot(this.currentRepo?.rootUri, message.filePath, message.issue);
        break;
      }
    }
  }

  public setTheme(themeStyle: 'zen' | 'editorial' | 'compact') {
    this.postMessage({
      type: 'setTheme',
      payload: { themeStyle },
    });
  }

  public async compareCommits(
    base: CommitRef,
    target: CommitRef,
    repo?: GitRepoInfo
  ): Promise<void> {
    if (repo) {
      this.currentRepo = repo;
    } else if (!this.currentRepo) {
      this.repos = await this.gitService.getRepositories();
      this.currentRepo = this.repos[0];
    }
    this.currentScope = 'commits';
    this.currentComparison = { base, target };
    this.currentChapterIndex = 0;
    await this.loadStory();
  }

  private async sendCommitsList(): Promise<void> {
    if (!this.currentRepo) {
      this.repos = await this.gitService.getRepositories();
      this.currentRepo = this.repos[0];
    }
    if (!this.currentRepo) {
      this.postMessage({
        type: 'commitsList',
        payload: { commits: [], branches: [] },
      });
      return;
    }

    const payload = await buildCommitsListPayload(
      this.gitService,
      this.currentRepo.rootUri,
      this.currentRepo.headBranch,
      this.currentComparison
    );
    this.postMessage({
      type: 'commitsList',
      payload,
    });
  }

  private async handleCompareCommitsRefs(baseRef: string, targetRef: string): Promise<void> {
    if (!this.currentRepo) {
      this.postMessage({
        type: 'compareError',
        payload: { message: 'No active Git repository selected.' },
      });
      return;
    }

    const result = await resolveAndValidateComparison(
      this.gitService,
      this.currentRepo.rootUri,
      baseRef,
      targetRef
    );

    if (!result.comparison) {
      this.postMessage({
        type: 'compareError',
        payload: {
          message: result.error || 'Could not resolve one or both commit references.',
          invalidField: result.invalidField,
        },
      });
      return;
    }

    this.currentScope = 'commits';
    this.currentComparison = result.comparison;
    this.currentChapterIndex = 0;
    await this.loadStory();
  }

  public async openNativeDiff(chapter?: Chapter, lineNumber?: number): Promise<void> {
    const ch = chapter || this.currentStory?.chapters[this.currentChapterIndex];
    if (!this.currentRepo || !ch) return;

    await openNativeDiffEditor(
      this.currentRepo.rootUri,
      ch,
      this.currentScope,
      this.currentComparison,
      lineNumber
    );
  }

  private async loadInitialData() {
    this.postMessage({ type: 'loading', payload: { message: 'Discovering Git repositories...' } });

    this.repos = await this.gitService.getRepositories();
    if (this.repos.length === 0) {
      this.postMessage({
        type: 'init',
        payload: {
          story: {
            title: 'No Git Repository Found',
            synopsis: 'The current workspace does not appear to have an initialized Git repository.',
            chapters: [],
            suggestedCommitMessage: '',
          },
          providerName: 'None',
          currentRepo: { rootUri: '', name: 'No Repo' },
          repos: [],
          scope: 'all',
          themeStyle: 'zen',
        }
      });
      return;
    }

    if (!this.currentRepo || !this.repos.some(r => r.rootUri === this.currentRepo?.rootUri)) {
      this.currentRepo = this.repos[0];
    }
    await this.loadStory();
  }

  public async refresh(forceRefresh = false) {
    this.postMessage({ type: 'loading', payload: { message: forceRefresh ? 'Re-analyzing changes with AI...' : 'Checking review cache and changes...' } });
    this.repos = await this.gitService.getRepositories();
    if (this.repos.length > 0 && !this.currentRepo) {
      this.currentRepo = this.repos[0];
    }
    await this.loadStory(forceRefresh);
  }

  private async loadStory(forceRefresh = false) {
    if (!this.currentRepo) return;
    const currentRepo = this.currentRepo;

    if (this.currentScope === 'commits' && !this.currentComparison) {
      this.currentStory = {
        title: 'Select Two Commits to Compare',
        synopsis: 'Choose a base commit and a target commit to compare their states.',
        chapters: [],
        suggestedCommitMessage: '',
      };
      this.postMessage({
        type: 'init',
        payload: {
          story: this.currentStory,
          providerName: 'Git Story',
          currentRepo: this.currentRepo,
          repos: this.repos,
          scope: this.currentScope,
          themeStyle: vscode.workspace.getConfiguration('gitStory').get<string>('themeStyle') || 'zen',
        },
      });
      return;
    }

    this.postMessage({
      type: 'loading',
      payload: {
        message: this.currentScope === 'commits' && this.currentComparison
          ? `Comparing ${formatRefShort(this.currentComparison.base)} ↔ ${formatRefShort(this.currentComparison.target)}...`
          : 'Cross-checking repository defenses & commit intentions...',
      },
    });

    try {
      const comparison = this.currentScope === 'commits' ? this.currentComparison : undefined;
      const rawDiff = comparison
        ? await this.gitService.getCommitDiff(currentRepo.rootUri, comparison.base.hash, comparison.target.hash)
        : await this.gitService.getDiff(currentRepo.rootUri, undefined, this.currentScope);
      const diffFiles = DiffParser.parse(rawDiff);

      if (diffFiles.length === 0) {
        this.currentStory = comparison
          ? {
              title: 'No Differences Between Commits',
              synopsis: `No file differences found between ${comparison.base.shortHash} ("${comparison.base.subject}") and ${comparison.target.shortHash} ("${comparison.target.subject}").`,
              chapters: [],
              suggestedCommitMessage: '',
            }
          : {
              title: 'Working Tree Clean',
              synopsis: 'No uncommitted changes found in the working tree for the selected scope.',
              chapters: [],
              suggestedCommitMessage: '',
            };
        this.postMessage({
          type: 'init',
          payload: {
            story: this.currentStory,
            providerName: 'Git Story',
            currentRepo: this.currentRepo,
            repos: this.repos,
            scope: this.currentScope,
            comparison,
            themeStyle: vscode.workspace.getConfiguration('gitStory').get<string>('themeStyle') || 'zen',
          }
        });
        return;
      }

      let initialized = false;
      const publishStory = (story: StoryNarrative, providerName: string) => {
        const reviewedPaths = new Set(
          (this.currentStory?.chapters || []).filter(chapter => chapter.isReviewed).map(chapter => chapter.filePath)
        );
        for (const chapter of story.chapters) {
          if (reviewedPaths.has(chapter.filePath)) {
            chapter.isReviewed = true;
          }
        }

        this.currentStory = story;
        this.currentProviderName = providerName;
        if (!initialized) {
          initialized = true;
          this.currentChapterIndex = 0;
          this.postMessage({
            type: 'init',
            payload: {
              story,
              providerName,
              currentRepo,
              repos: this.repos,
              scope: this.currentScope,
              comparison,
              themeStyle: vscode.workspace.getConfiguration('gitStory').get<string>('themeStyle') || 'zen',
            }
          });
        } else {
          this.postMessage({
            type: 'updateStory',
            payload: { story, providerName, scope: this.currentScope, comparison },
          });
        }
      };

      const extras = comparison
        ? await loadComparisonExtras(this.gitService, currentRepo.rootUri, diffFiles, comparison)
        : undefined;

      const { story, providerName } = await this.storyAgent.generateStory(diffFiles, {
        repoName: currentRepo.name,
        repoRoot: currentRepo.rootUri,
        branch: currentRepo.headBranch,
        comparison,
        comparisonCommits: extras?.comparisonCommits,
        targetFileContents: extras?.targetFileContents,
      }, forceRefresh, progressStory => publishStory(progressStory, 'AI Review (analyzing)'));
      publishStory(story, providerName);

      if (story.chapters.length > 0) {
        await this.openNativeDiff(story.chapters[0]);
      }
    } catch (err: any) {
      this.postMessage({
        type: 'error',
        payload: { message: `Failed to load review: ${err.message}` }
      });
    }
  }

  private async handleAskQuestion(question: string, chapterIndex: number) {
    if (!this.currentStory?.chapters[chapterIndex]) return;

    const chapter = this.currentStory.chapters[chapterIndex];
    let diffSnippet = '';
    if (chapter.diffFile?.hunks) {
      diffSnippet = chapter.diffFile.hunks.map(h => h.lines.map(l => l.content).join('\n')).slice(0, 10).join('\n');
    }

    const answer = await this.storyAgent.askQuestion(question, chapter, diffSnippet);
    this.postMessage({
      type: 'answer',
      payload: { question, answer, chapterIndex }
    });
  }

  private async handleCommit(commitMessage: string) {
    if (!this.currentRepo) return;

    try {
      if (this.currentScope === 'unstaged' || this.currentScope === 'all') {
        const changed = await this.gitService.getChangedFiles(this.currentRepo.rootUri, 'all');
        for (const file of changed) {
          if (!file.staged) {
            await this.gitService.stageFile(this.currentRepo.rootUri, file.path);
          }
        }
      }

      await this.gitService.commit(this.currentRepo.rootUri, commitMessage);
      this.postMessage({
        type: 'commitSuccess',
        payload: { message: commitMessage }
      });
      vscode.window.showInformationMessage(`Git Story: Committed successfully: "${commitMessage.split('\n')[0]}"`);
      await this.refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Git commit failed: ${err.message}`);
      this.postMessage({
        type: 'error',
        payload: { message: `Commit failed: ${err.message}` }
      });
    }
  }

  private postMessage(msg: ExtensionMessageToWebview) {
    this.panel.webview.postMessage(msg);
  }

  private updateWebviewContent() {
    this.panel.webview.html = buildWebviewHtml(this.panel.webview, this.extensionUri);
  }

  public dispose() {
    ReviewPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}
