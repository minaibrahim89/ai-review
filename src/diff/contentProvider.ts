import * as vscode from 'vscode';
import { GitService } from '../git/gitService';

export class GitStoryContentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = 'git-story-diff';
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private gitService: GitService) {}

  public fireDidChange(uri: vscode.Uri) {
    this._onDidChange.fire(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    if (params.get('empty') === 'true') {
      return '';
    }
    const repoPath = params.get('repo');
    const ref = params.get('ref') || 'HEAD';
    // Remove leading slash from path
    const filePath = uri.path.replace(/^\//, '');

    if (!repoPath || !filePath) {
      return '';
    }

    try {
      const gitRef = ref === 'index' ? `:${filePath}` : `${ref}:${filePath}`;
      return await this.gitService.getFileContent(repoPath, gitRef);
    } catch {
      // Return empty if the file does not exist at ref (e.g. untracked/added)
      return '';
    }
  }
}
