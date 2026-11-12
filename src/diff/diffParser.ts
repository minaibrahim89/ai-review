import { diffWordsWithSpace } from 'diff';
import { DiffFile, DiffHunk, DiffLine } from './types';

export class DiffParser {
  public static parse(diffText: string): DiffFile[] {
    if (!diffText || !diffText.trim()) {
      return [];
    }

    const files: DiffFile[] = [];
    const lines = diffText.split('\n');
    let currentFile: DiffFile | null = null;
    let currentHunk: DiffHunk | null = null;
    let oldLineNum = 0;
    let newLineNum = 0;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // New file diff starts with "diff --git"
      if (line.startsWith('diff --git ')) {
        if (currentFile) {
          if (currentHunk) {
            currentFile.hunks.push(currentHunk);
            currentHunk = null;
          }
          this.applyWordDiffs(currentFile);
          files.push(currentFile);
        }

        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        const oldPath = match ? match[1] : '';
        const newPath = match ? match[2] : '';

        currentFile = {
          oldPath: oldPath || 'unknown',
          newPath: newPath || oldPath || 'unknown',
          status: 'modified',
          hunks: [],
          additions: 0,
          deletions: 0,
          isBinary: false,
        };
        i++;
        continue;
      }

      if (!currentFile) {
        // Might be diff with no index header (e.g. diff --no-index)
        if (line.startsWith('--- ')) {
          const oldPath = line.substring(4).replace(/^a\//, '').trim();
          currentFile = {
            oldPath: oldPath === '/dev/null' || oldPath === 'NUL' ? '' : oldPath,
            newPath: '',
            status: 'modified',
            hunks: [],
            additions: 0,
            deletions: 0,
            isBinary: false,
          };
        } else {
          i++;
          continue;
        }
      }

      // Check status flags
      if (line.startsWith('new file mode ')) {
        currentFile.status = 'added';
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode ')) {
        currentFile.status = 'deleted';
        i++;
        continue;
      }
      if (line.startsWith('similarity index ') || line.startsWith('rename from ')) {
        currentFile.status = 'renamed';
        i++;
        continue;
      }
      if (line.startsWith('Binary files ')) {
        currentFile.isBinary = true;
        i++;
        continue;
      }
      if (line.startsWith('--- ')) {
        const rawOld = line.substring(4).replace(/^a\//, '').trim();
        currentFile.oldPath = rawOld === '/dev/null' || rawOld === 'NUL' ? '' : rawOld;
        i++;
        continue;
      }
      if (line.startsWith('+++ ')) {
        const rawNew = line.substring(4).replace(/^b\//, '').trim();
        currentFile.newPath = rawNew === '/dev/null' || rawNew === 'NUL' ? '' : rawNew;
        if (!currentFile.oldPath) {
          currentFile.status = 'added';
        } else if (!currentFile.newPath) {
          currentFile.status = 'deleted';
        }
        i++;
        continue;
      }

      // Hunk header: @@ -oldStart,oldLines +newStart,newLines @@
      if (line.startsWith('@@ ')) {
        if (currentHunk) {
          currentFile.hunks.push(currentHunk);
          currentHunk = null;
        }

        const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
        if (hunkMatch) {
          oldLineNum = parseInt(hunkMatch[1], 10);
          const oldLines = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
          newLineNum = parseInt(hunkMatch[3], 10);
          const newLines = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;

          currentHunk = {
            oldStart: oldLineNum,
            oldLines,
            newStart: newLineNum,
            newLines,
            header: line,
            lines: [],
          };
        }
        i++;
        continue;
      }

      // Diff content lines
      if (currentHunk) {
        if (line.startsWith('+')) {
          currentFile.additions++;
          currentHunk.lines.push({
            type: 'add',
            newLineNumber: newLineNum++,
            content: line.substring(1),
          });
        } else if (line.startsWith('-')) {
          currentFile.deletions++;
          currentHunk.lines.push({
            type: 'delete',
            oldLineNumber: oldLineNum++,
            content: line.substring(1),
          });
        } else if (line.startsWith(' ')) {
          currentHunk.lines.push({
            type: 'context',
            oldLineNumber: oldLineNum++,
            newLineNumber: newLineNum++,
            content: line.substring(1),
          });
        } else if (line.startsWith('\\ No newline at end of file')) {
          // ignore Git warning line
        }
      }

      i++;
    }

    if (currentFile) {
      if (currentHunk) {
        currentFile.hunks.push(currentHunk);
      }
      this.applyWordDiffs(currentFile);
      files.push(currentFile);
    }

    return files;
  }

  /**
   * Applies word-level diffing between contiguous delete and add blocks in a hunk
   */
  private static applyWordDiffs(file: DiffFile): void {
    for (const hunk of file.hunks) {
      let i = 0;
      while (i < hunk.lines.length) {
        if (hunk.lines[i].type === 'delete') {
          const deleteLines: DiffLine[] = [];
          const addLines: DiffLine[] = [];

          while (i < hunk.lines.length && hunk.lines[i].type === 'delete') {
            deleteLines.push(hunk.lines[i]);
            i++;
          }
          while (i < hunk.lines.length && hunk.lines[i].type === 'add') {
            addLines.push(hunk.lines[i]);
            i++;
          }

          // Compute word diffs for paired delete/add lines
          const pairCount = Math.min(deleteLines.length, addLines.length);
          for (let p = 0; p < pairCount; p++) {
            const delLine = deleteLines[p];
            const addLine = addLines[p];

            try {
              const diffTokens = diffWordsWithSpace(delLine.content, addLine.content);
              delLine.wordTokens = [];
              addLine.wordTokens = [];

              for (const token of diffTokens) {
                if (token.removed) {
                  delLine.wordTokens.push({ text: token.value, isChanged: true });
                } else if (token.added) {
                  addLine.wordTokens.push({ text: token.value, isChanged: true });
                } else {
                  delLine.wordTokens.push({ text: token.value, isChanged: false });
                  addLine.wordTokens.push({ text: token.value, isChanged: false });
                }
              }
            } catch {
              // Ignore word diff failure on extreme regex patterns
            }
          }
          continue;
        }
        i++;
      }
    }
  }
}
