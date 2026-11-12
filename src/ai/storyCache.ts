import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { DiffFile, DiffHunk } from '../diff/types';
import { Chapter, IssueCallout, StoryNarrative } from './types';

export interface CachedChapterContent {
  filePath: string;
  fileHash: string;
  title: string;
  role: string;
  summary: string;
  narrative: string;
  keyPoints: string[];
  issues: IssueCallout[];
  timestamp: number;
}

export interface CachedStoryNarrative {
  changesetHash: string;
  providerName: string;
  title: string;
  synopsis: string;
  suggestedCommitMessage: string;
  chapters: CachedChapterContent[];
  timestamp: number;
}

/**
 * Computes a deterministic SHA-256 hash for a file's code additions and deletions.
 * Ignores context line differences so staging and unstaging produce the exact same hash.
 */
export function computeFileDiffHash(filePath: string, hunks: DiffHunk[]): string {
  const normalizedHunks = (hunks || []).map(h => {
    return h.lines
      .filter(l => l.type === 'add' || l.type === 'delete')
      .map(l => `${l.type}:${l.content}`)
      .join('\n');
  }).join('\n---\n');

  return crypto
    .createHash('sha256')
    .update(`${filePath}\n${normalizedHunks}`)
    .digest('hex');
}

/**
 * Computes a combined SHA-256 hash for a full changeset.
 */
export function computeChangesetHash(
  files: { filePath: string; fileHash: string }[],
  providerName: string,
  modelName: string
): string {
  const sorted = [...files].sort((a, b) => a.filePath.localeCompare(b.filePath));
  const signature = `${providerName}:${modelName}:${sorted.map(s => `${s.filePath}=${s.fileHash}`).join(';')}`;
  return crypto.createHash('sha256').update(signature).digest('hex');
}

export class StoryCache {
  private static readonly CHANGESET_KEY = 'gitStory.cache.changesets';
  private static readonly CHAPTER_KEY = 'gitStory.cache.chapters';

  // In-memory cache for instant synchronous access
  private changesetMemoryCache = new Map<string, CachedStoryNarrative>();
  private chapterMemoryCache = new Map<string, CachedChapterContent>();

  constructor(private context?: vscode.ExtensionContext) {
    this.restoreFromStorage();
  }

  private restoreFromStorage() {
    if (!this.context) return;

    try {
      const storedChangesets = this.context.workspaceState.get<Record<string, CachedStoryNarrative>>(
        StoryCache.CHANGESET_KEY,
        {}
      );
      for (const [key, val] of Object.entries(storedChangesets)) {
        this.changesetMemoryCache.set(key, val);
      }

      const storedChapters = this.context.workspaceState.get<Record<string, CachedChapterContent>>(
        StoryCache.CHAPTER_KEY,
        {}
      );
      for (const [key, val] of Object.entries(storedChapters)) {
        this.chapterMemoryCache.set(key, val);
      }
    } catch (err) {
      console.warn('Failed to restore story cache from workspaceState:', err);
    }
  }

  private persistToStorage() {
    if (!this.context) return;

    try {
      // Keep most recent 50 changesets and 200 chapters to prevent unbounded growth
      const changesetsObj: Record<string, CachedStoryNarrative> = {};
      const sortedChangesets = Array.from(this.changesetMemoryCache.entries())
        .sort((a, b) => b[1].timestamp - a[1].timestamp)
        .slice(0, 50);
      for (const [k, v] of sortedChangesets) {
        changesetsObj[k] = v;
      }
      this.context.workspaceState.update(StoryCache.CHANGESET_KEY, changesetsObj);

      const chaptersObj: Record<string, CachedChapterContent> = {};
      const sortedChapters = Array.from(this.chapterMemoryCache.entries())
        .sort((a, b) => b[1].timestamp - a[1].timestamp)
        .slice(0, 200);
      for (const [k, v] of sortedChapters) {
        chaptersObj[k] = v;
      }
      this.context.workspaceState.update(StoryCache.CHAPTER_KEY, chaptersObj);
    } catch (err) {
      console.warn('Failed to persist story cache to workspaceState:', err);
    }
  }

  public getChangeset(changesetHash: string): CachedStoryNarrative | undefined {
    return this.changesetMemoryCache.get(changesetHash);
  }

  public setChangeset(
    changesetHash: string,
    story: StoryNarrative,
    providerName: string,
    fileHashes: { filePath: string; fileHash: string }[]
  ): void {
    const now = Date.now();
    const cachedChapters: CachedChapterContent[] = story.chapters.map(ch => {
      const fh = fileHashes.find(f => f.filePath === ch.filePath);
      const hash = fh ? fh.fileHash : computeFileDiffHash(ch.filePath, ch.diffFile?.hunks || []);
      const cachedCh: CachedChapterContent = {
        filePath: ch.filePath,
        fileHash: hash,
        title: ch.title,
        role: ch.role,
        summary: ch.summary,
        narrative: ch.narrative,
        keyPoints: ch.keyPoints || [],
        issues: ch.issues || [],
        timestamp: now,
      };
      // Also cache individual chapter
      this.chapterMemoryCache.set(hash, cachedCh);
      return cachedCh;
    });

    const cachedChangeset: CachedStoryNarrative = {
      changesetHash,
      providerName,
      title: story.title,
      synopsis: story.synopsis,
      suggestedCommitMessage: story.suggestedCommitMessage,
      chapters: cachedChapters,
      timestamp: now,
    };

    this.changesetMemoryCache.set(changesetHash, cachedChangeset);
    this.persistToStorage();
  }

  public getFileChapter(fileHash: string): CachedChapterContent | undefined {
    return this.chapterMemoryCache.get(fileHash);
  }

  public setFileChapter(fileHash: string, chapter: Chapter): void {
    const cachedCh: CachedChapterContent = {
      filePath: chapter.filePath,
      fileHash,
      title: chapter.title,
      role: chapter.role,
      summary: chapter.summary,
      narrative: chapter.narrative,
      keyPoints: chapter.keyPoints || [],
      issues: chapter.issues || [],
      timestamp: Date.now(),
    };
    this.chapterMemoryCache.set(fileHash, cachedCh);
    this.persistToStorage();
  }

  public clear(): void {
    this.changesetMemoryCache.clear();
    this.chapterMemoryCache.clear();
    if (this.context) {
      this.context.workspaceState.update(StoryCache.CHANGESET_KEY, undefined);
      this.context.workspaceState.update(StoryCache.CHAPTER_KEY, undefined);
    }
  }

  public getStats(): { changesetsCount: number; chaptersCount: number } {
    return {
      changesetsCount: this.changesetMemoryCache.size,
      chaptersCount: this.chapterMemoryCache.size,
    };
  }
}
