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

export type DiffScope = 'all' | 'staged' | 'unstaged' | 'commits';

export interface CommitRef {
  hash: string;
  shortHash: string;
  subject: string;
  label?: string;
  author?: string;
  date?: string;
  refs?: string;
}

export interface GitBranchInfo {
  name: string;
  hash: string;
  shortHash: string;
  subject: string;
  isRemote: boolean;
  isCurrent: boolean;
  date?: string;
}

export interface CommitComparison {
  base: CommitRef;
  target: CommitRef;
}

export interface WorkspaceGitState {
  repos: GitRepoInfo[];
  selectedRepoUri?: string;
  branchName?: string;
  files: ChangedFile[];
  scope: DiffScope;
  comparison?: CommitComparison;
}
