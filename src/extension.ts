import * as vscode from 'vscode';
import { GitService } from './git/gitService';
import { StoryAgent } from './ai/storyAgent';
import { registerCommands } from './commands';
import { ReviewViewProvider } from './webview/reviewViewProvider';
import { ReviewPanel } from './webview/reviewPanel';
import { GitStoryContentProvider } from './diff/contentProvider';

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  console.log('Activating Git Story extension...');

  const gitService = new GitService();
  const storyAgent = new StoryAgent(context);

  // Register Native Diff Document Content Provider
  const contentProvider = new GitStoryContentProvider(gitService);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      GitStoryContentProvider.scheme,
      contentProvider
    )
  );

  // Register Native Webview View Provider (Sidebar / Secondary Sidebar / Panel)
  const reviewViewProvider = new ReviewViewProvider(context.extensionUri, gitService, storyAgent);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ReviewViewProvider.viewType,
      reviewViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  // Register commands
  const commandDisposables = registerCommands(context, gitService, storyAgent, reviewViewProvider);
  context.subscriptions.push(...commandDisposables);

  // Create Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = 'gitStory.openReview';
  statusBarItem.text = '$(book) Review Changes';
  statusBarItem.tooltip = 'Review uncommitted Git changes in a logical sequence (Native Diff + Panel Walkthrough)';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('gitStory.themeStyle')) {
        const newTheme = vscode.workspace.getConfiguration('gitStory').get<'zen' | 'editorial' | 'compact'>('themeStyle') || 'zen';
        reviewViewProvider.setTheme(newTheme);
        if (ReviewPanel.currentPanel) {
          ReviewPanel.currentPanel.setTheme(newTheme);
        }
      } else if (e.affectsConfiguration('gitStory')) {
        await reviewViewProvider.refresh();
        if (ReviewPanel.currentPanel) {
          await ReviewPanel.currentPanel.refresh();
        }
      }
    })
  );

  console.log('Git Story extension is now active!');
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}
