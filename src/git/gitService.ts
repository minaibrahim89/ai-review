import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { ChangedFile, ChangeStatus, DiffScope, GitRepoInfo } from './types';

const execFileAsync = promisify(execFile);

export class GitService {
  private gitExtensionApi: any = null;

  constructor() {
    this.initVsCodeGitApi();
  }

  private initVsCodeGitApi() {
    try {
      const extension = vscode.extensions.getExtension('vscode.git');
      if (extension) {
        if (extension.isActive) {
          this.gitExtensionApi = extension.exports.getAPI(1);
        } else {
          extension.activate().then(() => {
            this.gitExtensionApi = extension.exports.getAPI(1);
          }).catch(() => {
            // Fallback to CLI
          });
        }
      }
    } catch {
      // VS Code Git extension not available; will use CLI
    }
  }

  private async runGit(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd,
        maxBuffer: 15 * 1024 * 1024, // 15MB buffer for large diffs
      });
      return stdout;
    } catch (err: any) {
      // If error output exists, include it for diagnostics
      if (err.stdout) {
        return err.stdout;
      }
      throw new Error(`Git command 'git ${args.join(' ')}' failed in ${cwd}: ${err.message}`);
    }
  }

  public async getRepositories(): Promise<GitRepoInfo[]> {
    const repos: GitRepoInfo[] = [];

    // 1. Try VS Code Git extension first
    if (this.gitExtensionApi && this.gitExtensionApi.repositories?.length > 0) {
      for (const repo of this.gitExtensionApi.repositories) {
        const rootUri = repo.rootUri.fsPath;
        repos.push({
          rootUri,
          name: path.basename(rootUri),
          headBranch: repo.state.HEAD?.name,
        });
      }
      return repos;
    }

    // 2. Discover from workspace folders via CLI
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    for (const folder of workspaceFolders) {
      const fsPath = folder.uri.fsPath;
      try {
        const isRepo = await this.checkIfGitRepo(fsPath);
        if (isRepo) {
          const branch = await this.getCurrentBranch(fsPath);
          repos.push({
            rootUri: fsPath,
            name: folder.name,
            headBranch: branch,
          });
        }
      } catch {
        // Skip folder
      }
    }

    return repos;
  }

  private async checkIfGitRepo(dir: string): Promise<boolean> {
    try {
      const out = await this.runGit(dir, ['rev-parse', '--is-inside-work-tree']);
      return out.trim() === 'true';
    } catch {
      return false;
    }
  }

  public async getCurrentBranch(dir: string): Promise<string> {
    try {
      const out = await this.runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      return out.trim();
    } catch {
      return 'HEAD';
    }
  }

  public async getChangedFiles(repoPath: string, scope: DiffScope = 'all'): Promise<ChangedFile[]> {
    const fileMap = new Map<string, ChangedFile>();

    // Get status list using git status --porcelain=v1 -z
    try {
      const statusRaw = await this.runGit(repoPath, ['status', '--porcelain=v1', '-z']);
      const entries = statusRaw.split('\0').filter(Boolean);

      let i = 0;
      while (i < entries.length) {
        const entry = entries[i];
        if (entry.length < 3) {
          i++;
          continue;
        }

        const x = entry[0]; // Staged status
        const y = entry[1]; // Unstaged status
        let filePath = entry.substring(3).trim();
        let originalPath: string | undefined;

        if (x === 'R' || y === 'R') {
          // Renamed file next entry is original name in -z format
          i++;
          if (i < entries.length) {
            originalPath = filePath;
            filePath = entries[i].trim();
          }
        }

        let status: ChangeStatus = 'modified';
        if (x === 'A' || y === 'A' || (x === '?' && y === '?')) {
          status = x === '?' ? 'untracked' : 'added';
        } else if (x === 'D' || y === 'D') {
          status = 'deleted';
        } else if (x === 'R' || y === 'R') {
          status = 'renamed';
        }

        const isStaged = x !== ' ' && x !== '?' && x !== '!';
        const isUnstaged = y !== ' ' || (x === '?' && y === '?');

        let include = false;
        if (scope === 'all') {
          include = true;
        } else if (scope === 'staged') {
          include = isStaged;
        } else if (scope === 'unstaged') {
          include = isUnstaged;
        }

        if (include) {
          fileMap.set(filePath, {
            path: filePath,
            originalPath,
            status,
            staged: isStaged,
            additions: 0,
            deletions: 0,
          });
        }

        i++;
      }
    } catch (err) {
      console.error('Error fetching git status:', err);
    }

    // Now enrich with diff stats using git diff --numstat
    try {
      let numstatArgs: string[] = ['diff', '--numstat'];
      if (scope === 'staged') {
        numstatArgs = ['diff', '--cached', '--numstat'];
      } else if (scope === 'all') {
        // We will get both staged and unstaged numstats
        const unstagedStats = await this.runGit(repoPath, ['diff', '--numstat']);
        const stagedStats = await this.runGit(repoPath, ['diff', '--cached', '--numstat']);
        this.parseNumstat(unstagedStats, fileMap);
        this.parseNumstat(stagedStats, fileMap);
        return Array.from(fileMap.values());
      }

      const numstatOut = await this.runGit(repoPath, numstatArgs);
      this.parseNumstat(numstatOut, fileMap);
    } catch (err) {
      console.error('Error fetching diff numstat:', err);
    }

    return Array.from(fileMap.values());
  }

  private parseNumstat(output: string, map: Map<string, ChangedFile>) {
    const lines = output.split('\n');
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
        const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
        const filePath = parts[2].trim();

        const file = map.get(filePath);
        if (file) {
          file.additions += additions;
          file.deletions += deletions;
        } else {
          // File might not be in status porcelain (rare edge case)
          map.set(filePath, {
            path: filePath,
            status: 'modified',
            staged: false,
            additions,
            deletions,
          });
        }
      }
    }
  }

  public async getDiff(repoPath: string, filePath?: string, scope: DiffScope = 'all'): Promise<string> {
    const baseArgs: string[] = ['diff', '--no-color', '-U3'];

    let targetArgs: string[] = [];
    if (filePath) {
      targetArgs = ['--', filePath];
    }

    try {
      if (scope === 'staged') {
        return await this.runGit(repoPath, [...baseArgs, '--cached', ...targetArgs]);
      } else if (scope === 'unstaged') {
        let diff = await this.runGit(repoPath, [...baseArgs, ...targetArgs]);
        // Also check if untracked file
        if (filePath && !diff.trim()) {
          const untrackedDiff = await this.getUntrackedFileDiff(repoPath, filePath);
          if (untrackedDiff) return untrackedDiff;
        }
        return diff;
      } else {
        // 'all': Staged + Unstaged combined (diff against HEAD)
        let diff = '';
        try {
          diff = await this.runGit(repoPath, [...baseArgs, 'HEAD', ...targetArgs]);
        } catch {
          // If HEAD doesn't exist yet (initial commit in fresh repo), fallback to staged + unstaged
          const staged = await this.runGit(repoPath, [...baseArgs, '--cached', ...targetArgs]);
          const unstaged = await this.runGit(repoPath, [...baseArgs, ...targetArgs]);
          diff = staged + (staged && unstaged ? '\n' : '') + unstaged;
        }

        // If diff is still empty and filePath is specified, it might be an untracked file
        if (filePath && !diff.trim()) {
          const untrackedDiff = await this.getUntrackedFileDiff(repoPath, filePath);
          if (untrackedDiff) return untrackedDiff;
        }
        return diff;
      }
    } catch (err: any) {
      console.error(`Failed to get diff for ${filePath || 'repo'}:`, err);
      return '';
    }
  }

  private async getUntrackedFileDiff(repoPath: string, relativePath: string): Promise<string> {
    const fullPath = path.join(repoPath, relativePath);
    if (!fs.existsSync(fullPath)) return '';

    try {
      // Use git diff --no-index /dev/null <file> to format clean unified diff for new untracked files
      const { stdout } = await execFileAsync('git', ['diff', '--no-index', '--no-color', '-U3', 'NUL', relativePath], {
        cwd: repoPath,
      }).catch((err) => {
        // git diff --no-index exits with 1 when differences are found!
        if (err.stdout) return err;
        return { stdout: '' };
      });
      return stdout || '';
    } catch {
      return '';
    }
  }

  public async stageFile(repoPath: string, filePath: string): Promise<void> {
    await this.runGit(repoPath, ['add', '--', filePath]);
  }

  public async unstageFile(repoPath: string, filePath: string): Promise<void> {
    try {
      await this.runGit(repoPath, ['restore', '--staged', '--', filePath]);
    } catch {
      await this.runGit(repoPath, ['reset', 'HEAD', '--', filePath]);
    }
  }

  public async commit(repoPath: string, message: string): Promise<void> {
    await this.runGit(repoPath, ['commit', '-m', message]);
  }
}
