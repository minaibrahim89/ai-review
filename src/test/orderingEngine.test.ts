import { test } from 'node:test';
import * as assert from 'node:assert';
import { OrderingEngine } from '../ai/orderingEngine';
import { DiffFile } from '../diff/types';

function createMockDiffFile(filePath: string, contentSnippet = ''): DiffFile {
  return {
    oldPath: filePath,
    newPath: filePath,
    status: 'modified',
    additions: 10,
    deletions: 2,
    isBinary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        header: '@@ -1,1 +1,1 @@',
        lines: [
          {
            type: 'add',
            content: contentSnippet || `// modified in ${filePath}`,
          }
        ]
      }
    ]
  };
}

test('OrderingEngine should sequence files in cognitive narrative order', () => {
  // Pass files in scrambled alphabetical order
  const files: DiffFile[] = [
    createMockDiffFile('src/views/UserCard.tsx'),
    createMockDiffFile('src/controllers/user.controller.ts'),
    createMockDiffFile('tests/user.test.ts'),
    createMockDiffFile('src/models/user.types.ts'),
    createMockDiffFile('src/services/user.service.ts'),
  ];

  const ordered = OrderingEngine.orderFiles(files);
  const orderedPaths = ordered.map(n => n.file.newPath);

  // Expected sequence:
  // 1. Types/Schema (src/models/user.types.ts)
  // 2. Core Service (src/services/user.service.ts)
  // 3. Controller (src/controllers/user.controller.ts)
  // 4. UI View (src/views/UserCard.tsx)
  // 5. Test (tests/user.test.ts)
  assert.strictEqual(orderedPaths[0], 'src/models/user.types.ts');
  assert.strictEqual(orderedPaths[1], 'src/services/user.service.ts');
  assert.strictEqual(orderedPaths[2], 'src/controllers/user.controller.ts');
  assert.strictEqual(orderedPaths[3], 'src/views/UserCard.tsx');
  assert.strictEqual(orderedPaths[4], 'tests/user.test.ts');
});

test('OrderingEngine should use imports to break ties', () => {
  // Two files in the same layer (e.g. services), but service B imports service A
  const fileA = createMockDiffFile('src/services/authHelper.service.ts', 'export function hash() {}');
  const fileB = createMockDiffFile('src/services/auth.service.ts', "import { hash } from './authHelper.service';");

  const ordered = OrderingEngine.orderFiles([fileB, fileA]);
  const orderedPaths = ordered.map(n => n.file.newPath);

  assert.strictEqual(orderedPaths[0], 'src/services/authHelper.service.ts');
  assert.strictEqual(orderedPaths[1], 'src/services/auth.service.ts');
});
