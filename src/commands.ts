import * as vscode from 'vscode';
import { GitService } from './git/gitService';
import { CommitRef, GitBranchInfo, GitRepoInfo } from './git/types';
import { StoryAgent } from './ai/storyAgent';
import { ReviewPanel } from './webview/reviewPanel';
import { ReviewViewProvider } from './webview/reviewViewProvider';

async function selectRepository(gitService: GitService): Promise<GitRepoInfo | undefined> {
  const repos = await gitService.getRepositories();
  if (repos.length === 0) {
    vscode.window.showInformationMessage('Git Story: No Git repository found in the current workspace.');
    return undefined;
  }
  if (repos.length === 1) {
    return repos[0];
  }
  const repoPick = await vscode.window.showQuickPick(
    repos.map(r => ({ label: r.name, description: r.headBranch || '', repo: r })),
    { placeHolder: 'Select Git repository' }
  );
  return repoPick?.repo;
}

async function pickBranchRef(
  gitService: GitService,
  repoPath: string,
  placeHolder: string,
  branches: GitBranchInfo[]
): Promise<CommitRef | undefined> {
  type BranchQuickPickItem = vscode.QuickPickItem & { branch?: GitBranchInfo; isCustom?: boolean };
  const items: BranchQuickPickItem[] = [
    ...branches.map((b): BranchQuickPickItem => ({
      label: `$(git-branch) ${b.name}${b.isCurrent ? ' (current)' : ''}`,
      description: `${b.shortHash} — ${b.subject}`,
      detail: `${b.isRemote ? 'Remote branch' : 'Local branch'}${b.date ? ` • ${b.date}` : ''}`,
      branch: b,
    })),
    {
      label: '$(edit) Enter custom branch or ref...',
      description: 'e.g. origin/main, feature/foo, or commit ref',
      isCustom: true,
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) return undefined;
  if (picked.branch) {
    return {
      hash: picked.branch.hash,
      shortHash: picked.branch.shortHash,
      subject: picked.branch.subject,
      label: picked.branch.name,
      date: picked.branch.date,
    };
  }

  const customRef = await vscode.window.showInputBox({
    prompt: placeHolder,
    placeHolder: 'e.g. main, origin/feature, or commit SHA',
  });
  if (!customRef || !customRef.trim()) return undefined;

  const resolved = await gitService.resolveCommit(repoPath, customRef.trim());
  if (!resolved) {
    vscode.window.showErrorMessage(`Git Story: Could not resolve branch/ref "${customRef.trim()}".`);
    return undefined;
  }
  return resolved;
}

async function pickCommitRef(
  gitService: GitService,
  repoPath: string,
  placeHolder: string,
  commits: CommitRef[]
): Promise<CommitRef | undefined> {
  type CommitQuickPickItem = vscode.QuickPickItem & { commit?: CommitRef; isCustom?: boolean };
  const items: CommitQuickPickItem[] = [
    {
      label: '$(edit) Enter custom commit SHA, branch, tag, or ref...',
      description: 'e.g. HEAD~3, main, v1.0.0, or commit hash',
      isCustom: true,
    },
    ...commits.map((c): CommitQuickPickItem => ({
      label: `$(git-commit) ${c.shortHash}  ${c.subject}`,
      description: c.refs ? `[${c.refs}] ${c.date || ''}`.trim() : (c.date || ''),
      detail: c.author ? `Author: ${c.author}` : undefined,
      commit: c,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) return undefined;
  if (picked.commit) return picked.commit;

  const customRef = await vscode.window.showInputBox({
    prompt: placeHolder,
    placeHolder: 'e.g. HEAD~1, main, v1.0.0, or commit SHA',
  });
  if (!customRef || !customRef.trim()) return undefined;

  const resolved = await gitService.resolveCommit(repoPath, customRef.trim());
  if (!resolved) {
    vscode.window.showErrorMessage(`Git Story: Could not resolve commit reference "${customRef.trim()}".`);
    return undefined;
  }
  return resolved;
}

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

  // Command: Compare Any Two Commits
  disposables.push(
    vscode.commands.registerCommand('gitStory.compareCommits', async () => {
      const selectedRepo = await selectRepository(gitService);
      if (!selectedRepo) return;

      const commits = await gitService.getCommits(selectedRepo.rootUri, 100);
      if (commits.length === 0) {
        vscode.window.showInformationMessage('Git Story: No commits found in this repository yet.');
        return;
      }

      const baseCommit = await pickCommitRef(
        gitService,
        selectedRepo.rootUri,
        'Step 1/2: Select Base Commit (From / Left State)',
        commits
      );
      if (!baseCommit) return;

      const targetCommit = await pickCommitRef(
        gitService,
        selectedRepo.rootUri,
        `Step 2/2: Select Target Commit (To / Right State) — comparing from ${baseCommit.shortHash}`,
        commits
      );
      if (!targetCommit) return;

      if (ReviewPanel.currentPanel) {
        await ReviewPanel.currentPanel.compareCommits(baseCommit, targetCommit, selectedRepo);
      } else {
        await reviewViewProvider.compareCommits(baseCommit, targetCommit, selectedRepo);
        await reviewViewProvider.showAndFocus();
      }
    })
  );

  // Command: Compare Two Branches
  disposables.push(
    vscode.commands.registerCommand('gitStory.compareBranches', async () => {
      const selectedRepo = await selectRepository(gitService);
      if (!selectedRepo) return;

      const branches = await gitService.getBranches(selectedRepo.rootUri);
      if (branches.length === 0) {
        vscode.window.showInformationMessage('Git Story: No branches found in this repository yet.');
        return;
      }

      const baseBranch = await pickBranchRef(
        gitService,
        selectedRepo.rootUri,
        'Step 1/2: Select Base Branch (From / Left State)',
        branches
      );
      if (!baseBranch) return;

      const targetBranch = await pickBranchRef(
        gitService,
        selectedRepo.rootUri,
        `Step 2/2: Select Target Branch (To / Right State) — comparing from ${baseBranch.label || baseBranch.shortHash}`,
        branches
      );
      if (!targetBranch) return;

      if (ReviewPanel.currentPanel) {
        await ReviewPanel.currentPanel.compareCommits(baseBranch, targetBranch, selectedRepo);
      } else {
        await reviewViewProvider.compareCommits(baseBranch, targetBranch, selectedRepo);
        await reviewViewProvider.showAndFocus();
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
