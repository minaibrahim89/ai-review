import * as path from 'path';
import { DiffFile } from '../../diff/types';
import { OrderedFileNode } from '../orderingEngine';
import { Chapter, ReviewContext, StoryNarrative, resolveSeverityLevel } from '../types';

export function normalizeReviewPath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^[ab]\//, '');
}

/**
 * Extracts and parses a JSON object from an LLM response that may include
 * markdown code fences, prose preambles/postscripts, or trailing commas.
 */
export function extractJsonObject(rawText: string): any {
  const trimmed = (rawText || '').trim();
  if (!trimmed) {
    throw new Error('AI provider returned an empty response.');
  }

  // 1. Direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to extraction strategies
  }

  // 2. Strip markdown code fences if present anywhere
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // Continue to balanced-brace extraction
    }
  }

  // 3. Scan for the first balanced JSON object `{ ... }`
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = firstBrace; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(firstBrace, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            // Try removing trailing commas before `}` or `]`
            const withoutTrailingCommas = candidate.replace(/,\s*([}\]])/g, '$1');
            try {
              return JSON.parse(withoutTrailingCommas);
            } catch {
              break;
            }
          }
        }
      }
    }

    // Fallback: slice from first `{` to last `}`
    const lastBrace = trimmed.lastIndexOf('}');
    if (lastBrace > firstBrace) {
      const candidate = trimmed.slice(firstBrace, lastBrace + 1).replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(candidate);
    }
  }

  throw new Error('AI response did not contain a valid JSON object.');
}

/**
 * Matches a chapter's returned filePath to its DiffFile, tolerating `./`, `a/`/`b/`,
 * Windows slashes, oldPath on renames, or unique basenames.
 */
export function matchDiffFile(
  rawPath: string | undefined,
  files: DiffFile[],
  index: number,
  usedFiles: Set<DiffFile>
): DiffFile | undefined {
  if (rawPath) {
    const exact = files.find(f => !usedFiles.has(f) && (f.newPath === rawPath || f.oldPath === rawPath));
    if (exact) return exact;

    const norm = normalizeReviewPath(rawPath);
    const normMatch = files.find(
      f => !usedFiles.has(f) && (normalizeReviewPath(f.newPath) === norm || normalizeReviewPath(f.oldPath) === norm)
    );
    if (normMatch) return normMatch;

    const base = path.posix.basename(norm);
    const baseMatches = files.filter(
      f => !usedFiles.has(f) && path.posix.basename(normalizeReviewPath(f.newPath || f.oldPath)) === base
    );
    if (baseMatches.length === 1) return baseMatches[0];
  }

  const byIndex = files[index];
  if (byIndex && !usedFiles.has(byIndex)) {
    return byIndex;
  }

  return undefined;
}

export function parseProviderStoryResponse(
  rawText: string,
  files: DiffFile[],
  ctx: ReviewContext,
  defaultTitle: string = 'Review Walkthrough'
): StoryNarrative {
  const parsed = extractJsonObject(rawText);
  if (!parsed || !Array.isArray(parsed.chapters)) {
    throw new Error('AI response JSON did not include a "chapters" array.');
  }

  const usedFiles = new Set<DiffFile>();
  const chapters: Chapter[] = [];

  for (let i = 0; i < parsed.chapters.length; i++) {
    const ch = parsed.chapters[i];
    if (!ch || typeof ch !== 'object') continue;

    const diffFile = matchDiffFile(ch.filePath, files, i, usedFiles);
    if (diffFile) {
      usedFiles.add(diffFile);
    }

    const canonicalPath = diffFile
      ? (diffFile.newPath || diffFile.oldPath)
      : (typeof ch.filePath === 'string' && ch.filePath.trim() ? normalizeReviewPath(ch.filePath) : `File ${i + 1}`);

    chapters.push({
      index: chapters.length + 1,
      filePath: canonicalPath,
      title: ch.title || `Step ${chapters.length + 1}`,
      role: ch.role || 'Code Module',
      summary: ch.summary || '',
      narrative: ch.narrative || '',
      keyPoints: Array.isArray(ch.keyPoints) ? ch.keyPoints : [],
      issues: Array.isArray(ch.issues)
        ? ch.issues.map((iss: any, j: number) => ({
            id: iss.id || `issue-${i}-${j}`,
            severity: iss.severity || 'warning',
            severityLevel: resolveSeverityLevel(iss),
            title: iss.title || 'Potential Issue',
            description: iss.description || '',
            lineNumber: typeof iss.lineNumber === 'number' ? iss.lineNumber : undefined,
            suggestion: iss.suggestion,
          }))
        : [],
      isReviewed: false,
      diffFile,
    });
  }

  return {
    title: parsed.title || defaultTitle,
    synopsis: parsed.synopsis || '',
    suggestedCommitMessage: parsed.suggestedCommitMessage || 'feat: update changes',
    chapters,
    intentionContext: ctx.intention && ctx.intention.sources.length > 0 ? {
      summary: ctx.intention.summary,
      sources: ctx.intention.sources.map(s => s.title),
    } : undefined,
  };
}

export function formatDiffsForPrompt(
  orderedNodes: OrderedFileNode[],
  maxLinesPerHunk: number = 100,
  maxTotalChars: number = 60000
): string {
  const parts: string[] = [];
  let totalChars = 0;

  for (let idx = 0; idx < orderedNodes.length; idx++) {
    const n = orderedNodes[idx];
    const f = n.file;
    const filePath = f.newPath || f.oldPath;

    let body = '';
    if (f.isBinary) {
      body = '[Binary file changed]';
    } else if (f.hunks.length === 0) {
      body = f.status === 'renamed'
        ? `[File renamed from ${f.oldPath} to ${f.newPath} with no content changes]`
        : `[${f.status} file with no textual diff hunks]`;
    } else {
      body = f.hunks.map(h => {
        const lines = h.lines.map(l => {
          const prefix = l.type === 'add' ? '+' : l.type === 'delete' ? '-' : ' ';
          return `${prefix}${l.content}`;
        });
        const clipped = lines.length > maxLinesPerHunk
          ? [...lines.slice(0, maxLinesPerHunk), `... (${lines.length - maxLinesPerHunk} more lines truncated)`]
          : lines;
        return `${h.header}\n${clipped.join('\n')}`;
      }).join('\n');
    }

    const header = `--- File ${idx + 1}: ${filePath} (${n.role}, ${f.status}) ---\n`;
    const remaining = maxTotalChars - totalChars;
    if (remaining <= header.length + 100) {
      parts.push(`${header}[Diff truncated due to prompt size budget; +${f.additions} -${f.deletions}]`);
      continue;
    }

    const clippedBody = body.length > remaining - header.length
      ? `${body.slice(0, Math.max(200, remaining - header.length - 40))}\n... [truncated]`
      : body;

    const section = `${header}${clippedBody}`;
    parts.push(section);
    totalChars += section.length;
  }

  return parts.join('\n\n');
}
