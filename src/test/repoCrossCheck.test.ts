import { test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { RepoCrossChecker } from '../ai/repoCrossCheck';
import { DiffFile } from '../diff/types';
import { IssueCallout, StoryNarrative } from '../ai/types';

test('RepoCrossChecker.analyzeFileContent extracts imports, error handling, and guards', () => {
  const code = `import { z } from 'zod';
import { catchAsync } from '../utils/catchAsync';
import { db } from '../db';

export const handleLogin = catchAsync(async (req, res) => {
  if (!req.body) {
    return res.status(400).send('Missing body');
  }
  const payload = JSON.parse(req.body);
  res.json({ ok: true });
});
`;

  const defense = RepoCrossChecker.analyzeFileContent('src/routes/auth.ts', code);
  assert.strictEqual(defense.filePath, 'src/routes/auth.ts');
  assert.ok(defense.imports.some(i => i.includes('zod')));
  assert.ok(defense.hasErrorHandling);
  assert.ok(defense.existingGuards.some(g => g.includes('!req.body')));
});

test('RepoCrossChecker filters out console.log in test files', () => {
  const file: DiffFile = {
    oldPath: 'src/test/auth.test.ts',
    newPath: 'src/test/auth.test.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    hunks: [],
  };

  const issue: IssueCallout = {
    id: 'iss-1',
    severity: 'warning',
    title: 'Debugging Statement in Commit',
    description: 'console.log statement found in test code',
    lineNumber: 10,
  };

  const result = RepoCrossChecker.isIssueAlreadyAddressed(issue, file);
  assert.strictEqual(result.addressed, true);
  assert.ok(result.reason?.includes('test files'));
});

test('RepoCrossChecker filters out JSON parse warning when enclosed in try/catch on disk', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-story-crosscheck-'));
  const fullPath = path.join(tmpDir, 'service.ts');

  fs.writeFileSync(
    fullPath,
    `export function parseConfig(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    console.error('Config syntax error', err);
    return null;
  }
}
`
  );

  const file: DiffFile = {
    oldPath: 'service.ts',
    newPath: 'service.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    hunks: [],
  };

  const issue: IssueCallout = {
    id: 'iss-2',
    severity: 'suggestion',
    title: 'Potential Unhandled JSON Parse Error',
    description: 'JSON.parse can throw a SyntaxError on malformed payloads.',
    lineNumber: 3,
  };

  try {
    const result = RepoCrossChecker.isIssueAlreadyAddressed(issue, file, tmpDir);
    assert.strictEqual(result.addressed, true);
    assert.ok(result.reason?.includes('enclosing try/catch'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('RepoCrossChecker filters out input validation warning when null guard exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-story-crosscheck-'));
  const fullPath = path.join(tmpDir, 'user.ts');

  fs.writeFileSync(
    fullPath,
    `export function formatUserName(user?: { name: string }) {
  if (!user) return 'Anonymous';
  return user.name.toUpperCase();
}
`
  );

  const file: DiffFile = {
    oldPath: 'user.ts',
    newPath: 'user.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    hunks: [],
  };

  const issue: IssueCallout = {
    id: 'iss-3',
    severity: 'warning',
    title: 'Potential Null Pointer on User Access',
    description: 'Method accesses user.name without null check input validation.',
    lineNumber: 3,
  };

  try {
    const result = RepoCrossChecker.isIssueAlreadyAddressed(issue, file, tmpDir);
    assert.strictEqual(result.addressed, true);
    assert.ok(result.reason?.includes('null safety is already enforced'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('RepoCrossChecker preserves genuine unhandled issues and marks them crossCheckVerified', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-story-crosscheck-'));
  const fullPath = path.join(tmpDir, 'unsafe.ts');

  fs.writeFileSync(
    fullPath,
    `export function processOrder(orderId: string) {
  const token = "some_secret_key_123456789";
  return token;
}
`
  );

  const file: DiffFile = {
    oldPath: 'unsafe.ts',
    newPath: 'unsafe.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    hunks: [],
  };

  const issue: IssueCallout = {
    id: 'iss-4',
    severity: 'security',
    title: 'Hardcoded Secret',
    description: 'A literal secret or token credential was detected in production code.',
    lineNumber: 2,
  };

  try {
    const verified = RepoCrossChecker.verifyAndFilterIssues([issue], file, tmpDir);
    assert.strictEqual(verified.length, 1);
    assert.strictEqual(verified[0].crossCheckVerified, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
