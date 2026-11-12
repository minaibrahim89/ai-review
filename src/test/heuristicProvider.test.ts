import { test } from 'node:test';
import * as assert from 'node:assert';
import { HeuristicProvider } from '../ai/providers/heuristicProvider';
import { DiffFile } from '../diff/types';

function createMockDiffWithLines(filePath: string, addedLines: { lineNum: number; content: string }[]): DiffFile {
  return {
    oldPath: filePath,
    newPath: filePath,
    status: 'modified',
    additions: addedLines.length,
    deletions: 0,
    isBinary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: addedLines.length,
        header: '@@ -0,0 +1,5 @@',
        lines: addedLines.map(l => ({
          type: 'add',
          newLineNumber: l.lineNum,
          content: l.content,
        }))
      }
    ]
  };
}

test('HeuristicProvider should detect debugging statements and unsafe JSON parsing', async () => {
  const provider = new HeuristicProvider();

  const file = createMockDiffWithLines('src/services/data.service.ts', [
    { lineNum: 10, content: 'console.log("Debugging session id:", sessionId);' },
    { lineNum: 25, content: 'const data = JSON.parse(rawPayload);' },
    { lineNum: 40, content: 'const apiKey = "api_key = \'sk-live-1234567890abcdef\'";' },
  ]);

  const result = await provider.generateStory([file], { repoName: 'test-repo', branch: 'feature/auth' });

  assert.strictEqual(result.chapters.length, 1);
  const chapter = result.chapters[0];

  assert.ok(chapter.narrative.includes('data.service.ts'));
  assert.ok(chapter.issues.length >= 3);

  const debugIssue = chapter.issues.find(i => i.title.includes('Debugging Statement'));
  assert.ok(debugIssue);
  assert.strictEqual(debugIssue.lineNumber, 10);
  assert.strictEqual(debugIssue.severityLevel, 'medium');

  const jsonIssue = chapter.issues.find(i => i.title.includes('JSON Parse'));
  assert.ok(jsonIssue);
  assert.strictEqual(jsonIssue.lineNumber, 25);
  assert.strictEqual(jsonIssue.severityLevel, 'low');

  const secretIssue = chapter.issues.find(i => i.title.includes('Secret'));
  assert.ok(secretIssue);
  assert.strictEqual(secretIssue.lineNumber, 40);
  assert.strictEqual(secretIssue.severityLevel, 'critical');
});

test('HeuristicProvider should answer reviewer questions', async () => {
  const provider = new HeuristicProvider();
  const file = createMockDiffWithLines('src/models/user.ts', [
    { lineNum: 1, content: 'export interface User { id: string; }' },
    { lineNum: 2, content: 'console.log("user loaded");' }
  ]);

  const result = await provider.generateStory([file], { repoName: 'test-repo' });
  const chapter = result.chapters[0];

  const answer = await provider.askQuestion('What are potential issues in this file?', chapter, '');
  assert.ok(answer.length > 0);
  assert.ok(answer.includes('MEDIUM SEVERITY'));
});
