export type DiffLineType = 'add' | 'delete' | 'context' | 'hunk-header';

export interface WordToken {
  text: string;
  isChanged?: boolean;
}

export interface DiffLine {
  type: DiffLineType;
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
  wordTokens?: WordToken[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  isBinary: boolean;
}
