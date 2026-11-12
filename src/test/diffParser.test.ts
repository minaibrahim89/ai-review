import { test } from 'node:test';
import * as assert from 'node:assert';
import { DiffParser } from '../diff/diffParser';

test('DiffParser should parse unified diff with modifications', () => {
  const sampleDiff = `diff --git a/src/user.ts b/src/user.ts
index 1234567..89abcdef 100644
--- a/src/user.ts
+++ b/src/user.ts
@@ -1,4 +1,5 @@
-const role = 'guest';
+const role = 'admin';
+const active = true;
 export function getUser() {
   return role;
 }`;

  const files = DiffParser.parse(sampleDiff);
  assert.strictEqual(files.length, 1);

  const file = files[0];
  assert.strictEqual(file.oldPath, 'src/user.ts');
  assert.strictEqual(file.newPath, 'src/user.ts');
  assert.strictEqual(file.status, 'modified');
  assert.strictEqual(file.additions, 2);
  assert.strictEqual(file.deletions, 1);
  assert.strictEqual(file.hunks.length, 1);

  const hunk = file.hunks[0];
  assert.strictEqual(hunk.oldStart, 1);
  assert.strictEqual(hunk.newStart, 1);

  // Check word diffing on the replaced line
  const delLine = hunk.lines.find(l => l.type === 'delete');
  const addLine = hunk.lines.find(l => l.type === 'add');
  assert.ok(delLine);
  assert.ok(addLine);
  assert.ok(delLine.wordTokens);
  assert.ok(delLine.wordTokens.some(t => t.isChanged && t.text === 'guest'));
  assert.ok(addLine.wordTokens);
  assert.ok(addLine.wordTokens.some(t => t.isChanged && t.text === 'admin'));
});

test('DiffParser should parse newly added file', () => {
  const sampleDiff = `diff --git a/src/newFile.ts b/src/newFile.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/newFile.ts
@@ -0,0 +1,3 @@
+export interface Session {
+  token: string;
+}
`;

  const files = DiffParser.parse(sampleDiff);
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].status, 'added');
  assert.strictEqual(files[0].additions, 3);
  assert.strictEqual(files[0].deletions, 0);
});

test('DiffParser should handle empty or whitespace diff', () => {
  const files = DiffParser.parse('');
  assert.strictEqual(files.length, 0);
});
