import * as vscode from 'vscode';
import { GitService } from './git/gitService';
import { StoryAgent } from './ai/storyAgent';
import { ReviewPanel } from './webview/reviewPanel';

export function registerCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  storyAgent: StoryAgent
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Command: Open Review
  disposables.push(
    vscode.commands.registerCommand('gitStory.openReview', async () => {
      await ReviewPanel.createOrShow(context.extensionUri, gitService, storyAgent);
    })
  );

  // Command: Refresh
  disposables.push(
    vscode.commands.registerCommand('gitStory.refresh', async () => {
      if (ReviewPanel.currentPanel) {
        await ReviewPanel.currentPanel.refresh();
      } else {
        await ReviewPanel.createOrShow(context.extensionUri, gitService, storyAgent);
      }
    })
  );

  // Command: Configure Provider & API Keys
  disposables.push(
    vscode.commands.registerCommand('gitStory.configureApiKey', async () => {
      const providerChoice = await vscode.window.showQuickPick(
        [
          { label: 'Auto (Recommended)', description: 'Tries VS Code LM, then Gemini, then Heuristic', id: 'auto' },
          { label: 'Google Gemini', description: 'Configure Gemini API Key & Model (gemini-2.5-flash)', id: 'gemini' },
          { label: 'VS Code Language Model', description: 'Uses Copilot or models built into VS Code', id: 'vscode-lm' },
          { label: 'OpenAI / Compatible', description: 'Configure OpenAI API key & endpoint', id: 'openai' },
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
      if (ReviewPanel.currentPanel) {
        await ReviewPanel.currentPanel.refresh();
      }
    })
  );

  return disposables;
}
