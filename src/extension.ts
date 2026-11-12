import * as vscode from 'vscode';
import { GitService } from './git/gitService';
import { StoryAgent } from './ai/storyAgent';
import { registerCommands } from './commands';
import { ReviewPanel } from './webview/reviewPanel';

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  console.log('Activating Git Story extension...');

  const gitService = new GitService();
  const storyAgent = new StoryAgent(context);

  // Register all commands
  const commandDisposables = registerCommands(context, gitService, storyAgent);
  context.subscriptions.push(...commandDisposables);

  // Create Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = 'gitStory.openReview';
  statusBarItem.text = '$(book) Review Story';
  statusBarItem.tooltip = 'Read uncommitted Git changes as an AI story';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('gitStory')) {
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
