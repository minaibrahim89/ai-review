import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CommitComparison, CommitRef, DiffScope, GitBranchInfo } from '../git/types';
import { GitService } from '../git/gitService';
import { DiffFile } from '../diff/types';
import { Chapter } from '../ai/types';
import { GitStoryContentProvider } from '../diff/contentProvider';
import { buildCopilotPrompt, CopilotIssueInfo } from './copilotPrompt';

export type DiffUriSpec =
  | { kind: 'empty'; filePath: string }
  | { kind: 'git'; repoRoot: string; filePath: string; ref: string }
  | { kind: 'file'; repoRoot: string; filePath: string };

export function formatRefShort(ref: CommitRef): string {
  return ref.label || ref.shortHash;
}

export function formatRefDisplay(ref: CommitRef): string {
  return ref.label ? `${ref.label} (${ref.shortHash})` : ref.shortHash;
}

export function describeDiffTarget(
  repoRoot: string,
  chapter: Chapter,
  scope: DiffScope,
  comparison?: CommitComparison
): { left: DiffUriSpec; right: DiffUriSpec; title: string } {
  const relativePath = chapter.filePath;
  const status = chapter.diffFile?.status || 'modified';
  const oldPath = chapter.diffFile?.oldPath || relativePath;
  const newPath = chapter.diffFile?.newPath || relativePath;
  const fileName = path.basename(newPath || oldPath);

  if (scope === 'commits' && comparison) {
    const baseShort = formatRefShort(comparison.base);
    const targetShort = formatRefShort(comparison.target);

    if (status === 'added') {
      return {
        left: { kind: 'empty', filePath: newPath },
        right: { kind: 'git', repoRoot, filePath: newPath, ref: comparison.target.hash },
        title: `${fileName} (${baseShort} ↔ ${targetShort})`,
      };
    }

    if (status === 'deleted') {
      return {
        left: { kind: 'git', repoRoot, filePath: oldPath, ref: comparison.base.hash },
        right: { kind: 'empty', filePath: oldPath },
        title: `${fileName} (${baseShort} ↔ ${targetShort})`,
      };
    }

    return {
      left: { kind: 'git', repoRoot, filePath: oldPath, ref: comparison.base.hash },
      right: { kind: 'git', repoRoot, filePath: newPath, ref: comparison.target.hash },
      title: `${fileName} (${baseShort} ↔ ${targetShort})`,
    };
  }

  if (status === 'added') {
    return {
      left: { kind: 'empty', filePath: newPath },
      right: { kind: 'file', repoRoot, filePath: newPath },
      title: `${fileName} (Added ↔ Working Tree)`,
    };
  }

  if (status === 'deleted') {
    return {
      left: { kind: 'git', repoRoot, filePath: oldPath, ref: 'HEAD' },
      right: { kind: 'empty', filePath: oldPath },
      title: `${fileName} (HEAD ↔ Deleted)`,
    };
  }

  if (scope === 'staged') {
    return {
      left: { kind: 'git', repoRoot, filePath: oldPath, ref: 'HEAD' },
      right: { kind: 'git', repoRoot, filePath: newPath, ref: 'index' },
      title: `${fileName} (HEAD ↔ Staged)`,
    };
  }

  if (scope === 'unstaged') {
    return {
      left: { kind: 'git', repoRoot, filePath: oldPath, ref: 'index' },
      right: { kind: 'file', repoRoot, filePath: newPath },
      title: `${fileName} (Index ↔ Working Tree)`,
    };
  }

  return {
    left: { kind: 'git', repoRoot, filePath: oldPath, ref: 'HEAD' },
    right: { kind: 'file', repoRoot, filePath: newPath },
    title: `${fileName} (HEAD ↔ Working Tree)`,
  };
}

export function toVscodeUri(spec: DiffUriSpec): vscode.Uri {
  if (spec.kind === 'empty') {
    return vscode.Uri.from({
      scheme: GitStoryContentProvider.scheme,
      path: `/${spec.filePath.replace(/^\//, '')}`,
      query: 'empty=true',
    });
  }
  if (spec.kind === 'git') {
    return vscode.Uri.from({
      scheme: GitStoryContentProvider.scheme,
      path: `/${spec.filePath.replace(/^\//, '')}`,
      query: `repo=${encodeURIComponent(spec.repoRoot)}&ref=${encodeURIComponent(spec.ref)}`,
    });
  }
  return vscode.Uri.file(path.join(spec.repoRoot, spec.filePath));
}

export async function openNativeDiffEditor(
  repoRoot: string,
  chapter: Chapter,
  scope: DiffScope,
  comparison?: CommitComparison,
  lineNumber?: number
): Promise<void> {
  const target = describeDiffTarget(repoRoot, chapter, scope, comparison);
  const leftUri = toVscodeUri(target.left);
  const rightUri = toVscodeUri(target.right);

  try {
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, target.title, {
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

export async function openChapterFileInEditor(
  repoRoot: string,
  filePath: string,
  scope: DiffScope,
  comparison?: CommitComparison,
  chapter?: Chapter,
  line?: number
): Promise<void> {
  try {
    let uri: vscode.Uri;
    if (scope === 'commits' && comparison) {
      const status = chapter?.diffFile?.status || 'modified';
      const ref = status === 'deleted' ? comparison.base.hash : comparison.target.hash;
      const refPath = status === 'deleted' ? (chapter?.diffFile?.oldPath || filePath) : (chapter?.diffFile?.newPath || filePath);
      uri = toVscodeUri({ kind: 'git', repoRoot, filePath: refPath, ref });
    } else {
      uri = vscode.Uri.file(path.join(repoRoot, filePath));
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      selection: line ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined,
    });
  } catch (err: any) {
    vscode.window.showErrorMessage(`Could not open file: ${err.message}`);
  }
}

export async function resolveAndValidateComparison(
  gitService: GitService,
  repoRoot: string,
  baseRef: string,
  targetRef: string
): Promise<{ comparison?: CommitComparison; error?: string; invalidField?: 'base' | 'target' | 'both' }> {
  const trimmedBase = baseRef.trim();
  const trimmedTarget = targetRef.trim();

  if (!trimmedBase && !trimmedTarget) {
    return { error: 'Enter both a base commit and a target commit.', invalidField: 'both' };
  }
  if (!trimmedBase) {
    return { error: 'Enter a base commit reference or SHA.', invalidField: 'base' };
  }
  if (!trimmedTarget) {
    return { error: 'Enter a target commit reference or SHA.', invalidField: 'target' };
  }

  const [base, target] = await Promise.all([
    gitService.resolveCommit(repoRoot, trimmedBase),
    gitService.resolveCommit(repoRoot, trimmedTarget),
  ]);

  if (!base && !target) {
    return {
      error: `Could not resolve base commit "${trimmedBase}" or target commit "${trimmedTarget}".`,
      invalidField: 'both',
    };
  }
  if (!base) {
    return { error: `Could not resolve base commit "${trimmedBase}".`, invalidField: 'base' };
  }
  if (!target) {
    return { error: `Could not resolve target commit "${trimmedTarget}".`, invalidField: 'target' };
  }

  return { comparison: { base, target } };
}

export async function buildCommitsListPayload(
  gitService: GitService,
  repoRoot: string,
  currentBranch?: string,
  currentComparison?: CommitComparison
): Promise<{
  commits: CommitRef[];
  branches: GitBranchInfo[];
  currentBranch?: string;
  currentBase?: string;
  currentTarget?: string;
}> {
  const [commits, branches] = await Promise.all([
    gitService.getCommits(repoRoot, 100),
    gitService.getBranches(repoRoot),
  ]);

  const activeBranch = branches.find(b => b.isCurrent)?.name || currentBranch;
  const defaultBaseBranch =
    branches.find(b => !b.isRemote && (b.name === 'main' || b.name === 'master') && b.name !== activeBranch)?.name ||
    branches.find(b => !b.isRemote && b.name !== activeBranch)?.name ||
    branches.find(b => b.name !== activeBranch)?.name ||
    branches[0]?.name;

  return {
    commits,
    branches,
    currentBranch: activeBranch,
    currentBase:
      currentComparison?.base.label ||
      currentComparison?.base.shortHash ||
      defaultBaseBranch ||
      commits[1]?.shortHash ||
      commits[0]?.shortHash,
    currentTarget:
      currentComparison?.target.label ||
      currentComparison?.target.shortHash ||
      activeBranch ||
      commits[0]?.shortHash ||
      'HEAD',
  };
}

export async function loadComparisonExtras(
  gitService: GitService,
  repoRoot: string,
  diffFiles: DiffFile[],
  comparison: CommitComparison
): Promise<{ comparisonCommits: CommitRef[]; targetFileContents: Map<string, string> }> {
  let comparisonCommits = await gitService.getCommitsInRange(
    repoRoot,
    comparison.base.hash,
    comparison.target.hash,
    15
  );
  if (comparisonCommits.length === 0 && comparison.base.hash !== comparison.target.hash) {
    comparisonCommits = await gitService.getCommitsInRange(
      repoRoot,
      comparison.target.hash,
      comparison.base.hash,
      15
    );
  }

  const targetFileContents = new Map<string, string>();
  const filesToLoad = diffFiles
    .filter(f => !f.isBinary && f.status !== 'deleted')
    .slice(0, 30);

  await Promise.all(
    filesToLoad.map(async (f) => {
      const relPath = f.newPath || f.oldPath;
      if (!relPath) return;
      try {
        const content = await gitService.getFileContent(repoRoot, `${comparison.target.hash}:${relPath}`);
        targetFileContents.set(relPath, content);
      } catch {
        // Ignore files that cannot be loaded at target ref
      }
    })
  );

  return { comparisonCommits, targetFileContents };
}

export async function addressIssueWithCopilot(
  repoRoot: string | undefined,
  filePath: string,
  issue: CopilotIssueInfo
): Promise<void> {
  if (repoRoot) {
    const fullPath = path.join(repoRoot, filePath);
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
    } catch {
      vscode.window.showErrorMessage(`Failed to address with Copilot: ${err.message}`);
    }
  }
}

export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const webviewDir = path.join(extensionUri.fsPath, 'dist', 'webview');
  const htmlPath = path.join(webviewDir, 'index.html');

  if (!fs.existsSync(htmlPath)) {
    return `<html><body><h3>Building Git Story webview... Please run compile.</h3></body></html>`;
  }

  let html = fs.readFileSync(htmlPath, 'utf8');

  const appJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'app.js'));
  const stylesCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'styles.css'));

  html = html.replace('href="styles.css"', `href="${stylesCssUri}"`);
  html = html.replace('src="app.js"', `src="${appJsUri}"`);

  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource};">`;
  html = html.replace('<head>', `<head>\n  ${csp}`);

  return html;
}
