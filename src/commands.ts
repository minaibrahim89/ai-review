import * as vscode from 'vscode';
import { GitService } from './git/gitService';
import { StoryAgent } from './ai/storyAgent';
import { ReviewPanel } from './webview/reviewPanel';
import { ReviewViewProvider } from './webview/reviewViewProvider';

export function registerCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  storyAgent: StoryAgent,
  reviewViewProvider: ReviewViewProvider
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Command: Open Review Walkthrough (Native VS Code Panel + Native Diff Editor)
  disposables.push(
    vscode.commands.registerCommand('gitStory.openReview', async () => {
      await reviewViewProvider.showAndFocus();
      await reviewViewProvider.openNativeDiff();
    })
  );

  // Command: Open Review Walkthrough in Editor Tab Beside Diff
  disposables.push(
    vscode.commands.registerCommand('gitStory.openReviewBeside', async () => {
      await ReviewPanel.createOrShow(context.extensionUri, gitService, storyAgent);
    })
  );

  // Command: Open Native Diff for Current Step
  disposables.push(
    vscode.commands.registerCommand('gitStory.openNativeDiff', async () => {
      if (ReviewPanel.currentPanel) {
        await ReviewPanel.currentPanel.openNativeDiff();
      } else {
        await reviewViewProvider.openNativeDiff();
      }
    })
  );

  // Command: Refresh
  disposables.push(
    vscode.commands.registerCommand('gitStory.refresh', async () => {
      await reviewViewProvider.refresh();
      if (ReviewPanel.currentPanel) {
        await ReviewPanel.currentPanel.refresh();
      }
    })
  );

  // Command: Clear Review Cache & Re-analyze
  disposables.push(
    vscode.commands.registerCommand('gitStory.clearCache', async () => {
      storyAgent.clearCache();
      vscode.window.showInformationMessage('Git Story: Review cache cleared. Re-analyzing changes with AI...');
      await reviewViewProvider.refresh(true);
      if (ReviewPanel.currentPanel) {
        await ReviewPanel.currentPanel.refresh(true);
      }
    })
  );

  // Command: Configure Provider & API Keys
  disposables.push(
    vscode.commands.registerCommand('gitStory.configureApiKey', async () => {
      const providerChoice = await vscode.window.showQuickPick(
        [
          { label: 'Auto (Recommended)', description: 'Tries VS Code LM, then Gemini, then Heuristic', id: 'auto' },
          { label: 'Google Gemini', description: 'Configure Gemini API Key & Model (gemini-3.8-flash)', id: 'gemini' },
          { label: 'VS Code Language Model', description: 'Uses Copilot or models built into VS Code', id: 'vscode-lm' },
          { label: 'OpenAI / Compatible', description: 'Configure OpenAI API key & endpoint (gpt-6-luna)', id: 'openai' },
          { label: 'Ollama (Local LLM)', description: 'Configure local Ollama endpoint (e.g. http://localhost:11434)', id: 'ollama' },
          { label: 'Heuristic Only (Offline)', description: 'No network / API key required', id: 'heuristic-only' },
        ],
        { placeHolder: 'Select active AI Story Provider' }
      );

      if (!providerChoice) return;

      const config = vscode.workspace.getConfiguration('gitStory');
      await config.update('aiProvider', providerChoice.id, vscode.ConfigurationTarget.Global);

      if (providerChoice.id === 'gemini') {
        const key = await vscode.window.showInputBox({
          prompt: 'Enter your Google Gemini API Key',
          password: true,
          placeHolder: 'AIzaSy...',
        });
        if (key !== undefined) {
          await context.secrets.store('gitStory.geminiApiKey', key.trim());
          vscode.window.showInformationMessage('Google Gemini API Key saved securely.');
        }
      } else if (providerChoice.id === 'openai') {
        const key = await vscode.window.showInputBox({
          prompt: 'Enter your OpenAI API Key',
          password: true,
          placeHolder: 'sk-...',
        });
        if (key !== undefined) {
          await context.secrets.store('gitStory.openaiApiKey', key.trim());
          vscode.window.showInformationMessage('OpenAI API Key saved securely.');
        }
      } else if (providerChoice.id === 'ollama') {
        const endpoint = await vscode.window.showInputBox({
          prompt: 'Enter Ollama Base URL',
          value: config.get<string>('ollamaEndpoint') || 'http://localhost:11434',
        });
        if (endpoint) {
          await config.update('ollamaEndpoint', endpoint.trim(), vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage('Ollama endpoint updated.');
        }
      }

      vscode.window.showInformationMessage(`Git Story provider set to: ${providerChoice.label}`);
      await reviewViewProvider.refresh();
      if (ReviewPanel.currentPanel) {
        await ReviewPanel.currentPanel.refresh();
      }
    })
  );

  return disposables;
}
