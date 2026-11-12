export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  path: string;
  originalPath?: string;
  status: ChangeStatus;
  staged: boolean;
  additions: number;
  deletions: number;
}

export interface GitRepoInfo {
  rootUri: string;
  name: string;
  headBranch?: string;
}

export type DiffScope = 'all' | 'staged' | 'unstaged';

export interface WorkspaceGitState {
  repos: GitRepoInfo[];
  selectedRepoUri?: string;
  branchName?: string;
  files: ChangedFile[];
  scope: DiffScope;
}
