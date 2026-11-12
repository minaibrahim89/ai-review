import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from '../git/gitService';
import { StoryAgent } from '../ai/storyAgent';
import { DiffParser } from '../diff/diffParser';
import { DiffScope, GitRepoInfo } from '../git/types';
import { ExtensionMessageToWebview, WebviewMessageToExtension } from './types';
import { Chapter, StoryNarrative } from '../ai/types';
import { buildCopilotPrompt, CopilotIssueInfo } from './copilotPrompt';

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
        this.currentChapterIndex = 0;
        await this.loadStory();
        break;
      }
      case 'changeRepo': {
        const found = this.repos.find(r => r.rootUri === message.repoUri);
        if (found) {
          this.currentRepo = found;
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
          const fullPath = path.join(this.currentRepo.rootUri, message.filePath);
          try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
            await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.One,
              selection: message.line ? new vscode.Range(message.line - 1, 0, message.line - 1, 0) : undefined,
            });
          } catch (err: any) {
            vscode.window.showErrorMessage(`Could not open file: ${err.message}`);
          }
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
        await this.handleAddressWithCopilot(message.filePath, message.issue);
        break;
      }
    }
  }

  private async handleAddressWithCopilot(filePath: string, issue: CopilotIssueInfo) {
    if (this.currentRepo) {
      const fullPath = path.join(this.currentRepo.rootUri, filePath);
      try {
        if (fs.existsSync(fullPath)) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
          const line = issue.lineNumber && issue.lineNumber > 0 ? issue.lineNumber - 1 : 0;
          await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One,
            preserveFocus: false,
            selection: new vscode.Range(line, 0, line, 0),
          });
        }
      } catch (err: any) {
        console.warn(`Could not open file ${filePath} for Copilot:`, err);
      }
    }

    const query = buildCopilotPrompt(filePath, issue);

    try {
      const commands = await vscode.commands.getCommands(true);
      if (commands.includes('workbench.action.chat.open')) {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query });
      } else if (commands.includes('workbench.action.quickchat.open')) {
        await vscode.commands.executeCommand('workbench.action.quickchat.open', { query });
      } else {
        await vscode.env.clipboard.writeText(query);
        vscode.window.showInformationMessage(
          'GitHub Copilot Chat is not active. The review prompt has been copied to your clipboard.',
          'OK'
        );
      }
    } catch (err: any) {
      try {
        await vscode.env.clipboard.writeText(query);
        vscode.window.showInformationMessage(
          `Could not open Copilot Chat (${err.message}). The prompt has been copied to your clipboard.`,
          'OK'
        );
      } catch (clipErr) {
        vscode.window.showErrorMessage(`Failed to address with Copilot: ${err.message}`);
      }
    }
  }

  public setTheme(themeStyle: 'zen' | 'editorial' | 'compact') {
    this.postMessage({
      type: 'setTheme',
      payload: { themeStyle },
    });
  }

  public async openNativeDiff(chapter?: Chapter, lineNumber?: number): Promise<void> {
    const ch = chapter || this.currentStory?.chapters[this.currentChapterIndex];
    if (!this.currentRepo || !ch) return;

    const repoRoot = this.currentRepo.rootUri;
    const relativePath = ch.filePath;
    const status = ch.diffFile?.status || 'modified';
    const fileName = path.basename(relativePath);

    let leftUri: vscode.Uri;
    let rightUri: vscode.Uri;
    let title: string;

    if (status === 'added' || status === 'untracked') {
      leftUri = vscode.Uri.parse(`git-story-diff:/${relativePath}?empty=true`);
      rightUri = vscode.Uri.file(path.join(repoRoot, relativePath));
      title = `${fileName} (Added ↔ Working Tree)`;
    } else if (status === 'deleted') {
      leftUri = vscode.Uri.parse(`git-story-diff:/${relativePath}?repo=${encodeURIComponent(repoRoot)}&ref=HEAD`);
      rightUri = vscode.Uri.parse(`git-story-diff:/${relativePath}?empty=true`);
      title = `${fileName} (HEAD ↔ Deleted)`;
    } else if (this.currentScope === 'staged') {
      leftUri = vscode.Uri.parse(`git-story-diff:/${relativePath}?repo=${encodeURIComponent(repoRoot)}&ref=HEAD`);
      rightUri = vscode.Uri.parse(`git-story-diff:/${relativePath}?repo=${encodeURIComponent(repoRoot)}&ref=index`);
      title = `${fileName} (HEAD ↔ Staged)`;
    } else if (this.currentScope === 'unstaged') {
      leftUri = vscode.Uri.parse(`git-story-diff:/${relativePath}?repo=${encodeURIComponent(repoRoot)}&ref=index`);
      rightUri = vscode.Uri.file(path.join(repoRoot, relativePath));
      title = `${fileName} (Index ↔ Working Tree)`;
    } else {
      leftUri = vscode.Uri.parse(`git-story-diff:/${relativePath}?repo=${encodeURIComponent(repoRoot)}&ref=HEAD`);
      rightUri = vscode.Uri.file(path.join(repoRoot, relativePath));
      title = `${fileName} (HEAD ↔ Working Tree)`;
    }

    try {
      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
        preview: true,
        preserveFocus: true,
        viewColumn: vscode.ViewColumn.One,
        selection: lineNumber ? new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0) : undefined,
      });

      if (lineNumber && vscode.window.activeTextEditor) {
        const range = new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0);
        vscode.window.activeTextEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    } catch (err: any) {
      console.error('Failed to open native diff editor:', err);
    }
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

    this.currentRepo = this.repos[0];
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

    this.postMessage({ type: 'loading', payload: { message: 'Cross-checking repository defenses & commit intentions...' } });

    try {
      const rawDiff = await this.gitService.getDiff(this.currentRepo.rootUri, undefined, this.currentScope);
      const diffFiles = DiffParser.parse(rawDiff);

      if (diffFiles.length === 0) {
        this.currentStory = {
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
            themeStyle: vscode.workspace.getConfiguration('gitStory').get<string>('themeStyle') || 'zen',
          }
        });
        return;
      }

      const { story, providerName } = await this.storyAgent.generateStory(diffFiles, {
        repoName: this.currentRepo.name,
        repoRoot: this.currentRepo.rootUri,
        branch: this.currentRepo.headBranch,
      }, forceRefresh);

      // Preserve previously reviewed checkmarks if the file paths match
      if (this.currentStory?.chapters) {
        for (const ch of story.chapters) {
          const old = this.currentStory.chapters.find(o => o.filePath === ch.filePath);
          if (old?.isReviewed) {
            ch.isReviewed = true;
          }
        }
      }

      this.currentStory = story;
      this.currentProviderName = providerName;
      this.currentChapterIndex = 0;

      this.postMessage({
        type: 'init',
        payload: {
          story: this.currentStory,
          providerName: this.currentProviderName,
          currentRepo: this.currentRepo,
          repos: this.repos,
          scope: this.currentScope,
          themeStyle: vscode.workspace.getConfiguration('gitStory').get<string>('themeStyle') || 'zen',
        }
      });

      if (this.currentStory.chapters.length > 0) {
        await this.openNativeDiff(this.currentStory.chapters[0]);
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
    const webview = this.panel.webview;
    const webviewDir = path.join(this.extensionUri.fsPath, 'dist', 'webview');
    const htmlPath = path.join(webviewDir, 'index.html');

    if (!fs.existsSync(htmlPath)) {
      webview.html = `<html><body><h3>Building Git Story webview... Please run compile.</h3></body></html>`;
      return;
    }

    let html = fs.readFileSync(htmlPath, 'utf8');

    const appJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'app.js'));
    const stylesCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'styles.css'));

    html = html.replace('href="styles.css"', `href="${stylesCssUri}"`);
    html = html.replace('src="app.js"', `src="${appJsUri}"`);

    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource};">`;
    html = html.replace('<head>', `<head>\n  ${csp}`);

    webview.html = html;
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
