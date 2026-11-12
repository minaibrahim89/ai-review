import * as vscode from 'vscode';
import { GitService } from './git/gitService';
import { StoryAgent } from './ai/storyAgent';
import { registerCommands } from './commands';
import { ReviewViewProvider } from './webview/reviewViewProvider';
import { ReviewPanel } from './webview/reviewPanel';
import { GitStoryContentProvider } from './diff/contentProvider';
import { CopilotChatContextStore } from './ai/intentionContext';

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

  // Register GitHub Copilot Chat Participant (@gitstory) if available
  if (vscode.chat && typeof vscode.chat.createChatParticipant === 'function') {
    try {
      const participant = vscode.chat.createChatParticipant(
        'gitStory.participant',
        async (request, chatContext, stream, token) => {
          // 1. Capture recent turns into CopilotChatContextStore
          if (chatContext.history && chatContext.history.length > 0) {
            for (const turn of chatContext.history) {
              if (turn instanceof vscode.ChatRequestTurn) {
                CopilotChatContextStore.addTurn('user', turn.prompt);
              } else if (turn instanceof vscode.ChatResponseTurn) {
                const textParts = (turn.response as any[])
                  ?.filter((p: any) => p && typeof p.value === 'object' && typeof p.value.value === 'string')
                  ?.map((p: any) => p.value.value)
                  ?.join(' ');
                if (textParts) {
                  CopilotChatContextStore.addTurn('assistant', textParts);
                }
              }
            }
          }

          if (request.prompt) {
            CopilotChatContextStore.setRecentPrompt(request.prompt, 'Copilot Chat (@gitstory)');
          }

          stream.markdown('Analyzing uncommitted changes grounded in your Copilot chat context and codebase documentation...\n\n');

          // Open the review walkthrough
          await vscode.commands.executeCommand('gitStory.openReview');
          stream.markdown('✓ Review Walkthrough is now open in the Git Story panel.');
        }
      );
      participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'book-dark.svg');
      context.subscriptions.push(participant);
    } catch (err) {
      console.warn('Could not register Copilot chat participant:', err);
    }
  }

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
