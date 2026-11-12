import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from '../git/gitService';
import { StoryAgent } from '../ai/storyAgent';
import { DiffParser } from '../diff/diffParser';
import { DiffFile } from '../diff/types';
import { DiffScope, GitRepoInfo } from '../git/types';
import { ExtensionMessageToWebview, WebviewMessageToExtension } from './types';
import { StoryNarrative } from '../ai/types';

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
  private currentProviderName: string = 'Heuristic';

  public static async createOrShow(
    extensionUri: vscode.Uri,
    gitService: GitService,
    storyAgent: StoryAgent
  ): Promise<ReviewPanel> {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ReviewPanel.currentPanel) {
      ReviewPanel.currentPanel.panel.reveal(column);
      await ReviewPanel.currentPanel.refresh();
      return ReviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      ReviewPanel.viewType,
      'Git Story: Review Changes',
      column || vscode.ViewColumn.One,
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

    // Set HTML content
    this.updateWebviewContent();

    // Listen to panel disposal
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Listen to webview messages
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
        await this.loadStory();
        break;
      }
      case 'changeRepo': {
        const found = this.repos.find(r => r.rootUri === message.repoUri);
        if (found) {
          this.currentRepo = found;
          await this.loadStory();
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
              viewColumn: vscode.ViewColumn.Beside,
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
          diffMode: 'split',
          themeStyle: 'zen',
        }
      });
      return;
    }

    this.currentRepo = this.repos[0];
    await this.loadStory();
  }

  public async refresh() {
    this.postMessage({ type: 'loading', payload: { message: 'Refreshing changes and re-evaluating review sequence...' } });
    this.repos = await this.gitService.getRepositories();
    if (this.repos.length > 0 && !this.currentRepo) {
      this.currentRepo = this.repos[0];
    }
    await this.loadStory();
  }

  private async loadStory() {
    if (!this.currentRepo) return;

    this.postMessage({ type: 'loading', payload: { message: 'Analyzing diffs and organizing review sequence...' } });

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
            diffMode: vscode.workspace.getConfiguration('gitStory').get<'split' | 'unified'>('diffViewMode') || 'split',
            themeStyle: vscode.workspace.getConfiguration('gitStory').get<string>('themeStyle') || 'zen',
          }
        });
        return;
      }

      // Generate Story using AI Story Agent
      const { story, providerName } = await this.storyAgent.generateStory(diffFiles, {
        repoName: this.currentRepo.name,
        branch: this.currentRepo.headBranch,
      });

      this.currentStory = story;
      this.currentProviderName = providerName;

      this.postMessage({
        type: 'init',
        payload: {
          story: this.currentStory,
          providerName: this.currentProviderName,
          currentRepo: this.currentRepo,
          repos: this.repos,
          scope: this.currentScope,
          diffMode: vscode.workspace.getConfiguration('gitStory').get<'split' | 'unified'>('diffViewMode') || 'split',
          themeStyle: vscode.workspace.getConfiguration('gitStory').get<string>('themeStyle') || 'zen',
        }
      });
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
      // If committing from review, automatically stage all changed files if unstaged
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

    // Replace resource paths with webview URIs
    const appJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'app.js'));
    const stylesCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'styles.css'));

    html = html.replace('href="styles.css"', `href="${stylesCssUri}"`);
    html = html.replace('src="app.js"', `src="${appJsUri}"`);

    // Add CSP
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
