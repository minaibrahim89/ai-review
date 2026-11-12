import { test } from 'node:test';
import * as assert from 'node:assert';
import { computeFileDiffHash, computeChangesetHash, StoryCache } from '../ai/storyCache';
import { DiffFile } from '../diff/types';
import { StoryNarrative } from '../ai/types';

test('computeFileDiffHash should produce identical hash regardless of staging state', () => {
  // Staged diff hunk with context line differences
  const stagedHunks = [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      header: '@@ -1,3 +1,4 @@',
      lines: [
        { type: 'context' as const, content: 'import * as path from "path";', oldLineNumber: 1, newLineNumber: 1 },
        { type: 'delete' as const, content: 'const timeout = 1000;', oldLineNumber: 2 },
        { type: 'add' as const, content: 'const timeout = 5000;', newLineNumber: 2 },
        { type: 'add' as const, content: 'const retries = 3;', newLineNumber: 3 },
        { type: 'context' as const, content: 'export default timeout;', oldLineNumber: 3, newLineNumber: 4 },
      ],
    },
  ];

  // Unstaged diff hunk with different context line numbers but identical code modifications
  const unstagedHunks = [
    {
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 4,
      header: '@@ -10,3 +10,4 @@',
      lines: [
        { type: 'context' as const, content: '// slightly different context header', oldLineNumber: 10, newLineNumber: 10 },
        { type: 'delete' as const, content: 'const timeout = 1000;', oldLineNumber: 11 },
        { type: 'add' as const, content: 'const timeout = 5000;', newLineNumber: 11 },
        { type: 'add' as const, content: 'const retries = 3;', newLineNumber: 12 },
        { type: 'context' as const, content: 'export default timeout;', oldLineNumber: 12, newLineNumber: 13 },
      ],
    },
  ];

  const hashStaged = computeFileDiffHash('src/config.ts', stagedHunks);
  const hashUnstaged = computeFileDiffHash('src/config.ts', unstagedHunks);

  assert.strictEqual(hashStaged, hashUnstaged, 'Hashes should be identical when code modifications are identical');
});

test('computeFileDiffHash should change when actual code changes occur', () => {
  const hunksA = [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      header: '@@ -1,1 +1,1 @@',
      lines: [
        { type: 'delete' as const, content: 'const v = 1;' },
        { type: 'add' as const, content: 'const v = 2;' },
      ],
    },
  ];

  const hunksB = [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      header: '@@ -1,1 +1,1 @@',
      lines: [
        { type: 'delete' as const, content: 'const v = 1;' },
        { type: 'add' as const, content: 'const v = 999;' },
      ],
    },
  ];

  const hashA = computeFileDiffHash('src/val.ts', hunksA);
  const hashB = computeFileDiffHash('src/val.ts', hunksB);

  assert.notStrictEqual(hashA, hashB, 'Hashes should differ when code lines change');
});

test('StoryCache should store and retrieve changeset narratives and individual file chapters', () => {
  const cache = new StoryCache(); // in-memory mode without ExtensionContext

  const sampleStory: StoryNarrative = {
    title: 'Core Authentication Overhaul',
    synopsis: 'Implements JWT tokens and Redis cache fallback.',
    suggestedCommitMessage: 'feat(auth): add JWT tokens',
    chapters: [
      {
        index: 1,
        filePath: 'src/auth/service.ts',
        title: 'Authentication Service',
        role: 'Core Business Logic',
        summary: 'Added token validation',
        narrative: '`SessionService` was enhanced with `validateToken()`.',
        keyPoints: ['Key point 1'],
        issues: [],
      },
    ],
  };

  const fileHashes = [
    { filePath: 'src/auth/service.ts', fileHash: 'hash-auth-service-123' },
  ];

  const changesetHash = computeChangesetHash(fileHashes, 'Gemini', 'gemini-3.8-flash');

  // Store in cache
  cache.setChangeset(changesetHash, sampleStory, 'Gemini', fileHashes);

  // Retrieve changeset
  const retrieved = cache.getChangeset(changesetHash);
  assert.ok(retrieved, 'Should retrieve cached changeset');
  assert.strictEqual(retrieved.title, 'Core Authentication Overhaul');
  assert.strictEqual(retrieved.chapters.length, 1);
  assert.strictEqual(retrieved.chapters[0].title, 'Authentication Service');

  // Retrieve individual file chapter
  const fileChapter = cache.getFileChapter('hash-auth-service-123');
  assert.ok(fileChapter, 'Should retrieve individual chapter by file diff hash');
  assert.strictEqual(fileChapter.role, 'Core Business Logic');
  assert.strictEqual(fileChapter.summary, 'Added token validation');

  // Test clear
  cache.clear();
  assert.strictEqual(cache.getChangeset(changesetHash), undefined);
  assert.strictEqual(cache.getFileChapter('hash-auth-service-123'), undefined);
});
