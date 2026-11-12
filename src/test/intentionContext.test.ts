import { test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CopilotChatContextStore, IntentionDetector } from '../ai/intentionContext';
import { DiffFile } from '../diff/types';

test('CopilotChatContextStore records prompts and turns', () => {
  CopilotChatContextStore.clear();

  CopilotChatContextStore.setRecentPrompt('Refactor auth service to support JWT refresh token rotation');
  assert.strictEqual(CopilotChatContextStore.getLastPrompt(), 'Refactor auth service to support JWT refresh token rotation');

  CopilotChatContextStore.addTurn('assistant', 'Created TokenRotationService with Redis backend.');
  const history = CopilotChatContextStore.getRecentHistory();

  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].role, 'user');
  assert.ok(history[0].text.includes('JWT refresh token'));
  assert.strictEqual(history[1].role, 'assistant');
  assert.ok(history[1].text.includes('TokenRotationService'));
});

test('IntentionDetector detects documentation additions in diff files', () => {
  const diffFiles: DiffFile[] = [
    {
      oldPath: 'docs/plan.md',
      newPath: 'docs/plan.md',
      status: 'modified',
      additions: 5,
      deletions: 0,
      hunks: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 5,
          header: '@@ -1,0 +1,5 @@',
          lines: [
            { type: 'add', content: '## Goals', oldLineNumber: undefined, newLineNumber: 1 },
            { type: 'add', content: '- Enforce token expiration on verify', oldLineNumber: undefined, newLineNumber: 2 },
            { type: 'add', content: '- Add rate limiting on auth endpoints', oldLineNumber: undefined, newLineNumber: 3 },
          ],
        },
      ],
    },
  ];

  const tmpDir = os.tmpdir();
  const sources = IntentionDetector.findDocIntentions(tmpDir, diffFiles);

  assert.ok(sources.length > 0);
  const docSource = sources.find(s => s.sourcePath === 'docs/plan.md');
  assert.ok(docSource);
  assert.strictEqual(docSource.type, 'doc');
  assert.ok(docSource.excerpt.includes('Enforce token expiration'));
  assert.ok(docSource.excerpt.includes('Add rate limiting'));
});

test('IntentionDetector detects existing workspace spec docs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-story-test-'));
  const planPath = path.join(tmpDir, 'PLAN.md');
  fs.writeFileSync(
    planPath,
    `# Feature Plan
## Intent
Implement Redis session caching with fallback to database.

## Tasks
1. Add Redis client
2. Wrap session lookups
`
  );

  try {
    const sources = IntentionDetector.findDocIntentions(tmpDir, []);
    assert.ok(sources.length > 0);
    const planSource = sources.find(s => s.sourcePath === 'PLAN.md');
    assert.ok(planSource);
    assert.ok(planSource.excerpt.includes('Implement Redis session caching'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('IntentionDetector synthesizes analysis with formatted prompt block', () => {
  const analysis = IntentionDetector.synthesizeAnalysis([
    {
      type: 'doc',
      title: 'Spec Doc: PLAN.md',
      sourcePath: 'PLAN.md',
      excerpt: 'Goal: Secure authentication endpoints',
      relevanceScore: 9,
    },
    {
      type: 'copilot-chat',
      title: 'Copilot Chat Active Prompt',
      excerpt: 'Add rate limiting to /api/login',
      relevanceScore: 10,
    },
  ]);

  assert.ok(analysis.summary.includes('documentation'));
  assert.ok(analysis.summary.includes('Copilot Chat context'));
  assert.ok(analysis.promptContext.includes('--- INTENTION & TASK CONTEXT ---'));
  assert.ok(analysis.promptContext.includes('Spec Doc: PLAN.md'));
  assert.ok(analysis.promptContext.includes('Copilot Chat Active Prompt'));
  assert.ok(analysis.promptContext.includes('CRITICAL REVIEW INSTRUCTION:'));
});
