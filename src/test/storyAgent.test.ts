import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import type { StoryAgent } from '../ai/storyAgent';
import { AIProvider, StoryNarrative } from '../ai/types';
import { DiffFile } from '../diff/types';
import { computeChangesetHash, computeFileDiffHash } from '../ai/storyCache';

const nodeRequire = createRequire(__filename);
const esbuild: typeof import('esbuild') = nodeRequire('esbuild');
const agentCode = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', '..', 'src', 'ai', 'storyAgent.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
}).outputFiles[0].text;

function createAgent(preference = 'openai') {
  const notices: string[] = [];
  const module = { exports: {} };
  const vscodeMock = {
    workspace: {
      getConfiguration: () => ({
        get: (key: string) => key === 'aiProvider' ? preference : key === 'openaiModel' ? 'test-model' : undefined,
      }),
    },
    window: { showInformationMessage: (message: string) => notices.push(message) },
  };
  runInNewContext(agentCode, {
    module,
    exports: module.exports,
    require: (name: string) => name === 'vscode' ? vscodeMock : nodeRequire(name),
    console: { log() {}, warn() {} },
    process: { env: {} },
  });
  const context = {
    workspaceState: { get: (_key: string, defaultValue: unknown) => defaultValue, update: async () => {} },
    secrets: { get: async () => undefined },
  };
  const Agent = (module.exports as { StoryAgent: new (fixture: typeof context) => StoryAgent }).StoryAgent;
  return { agent: new Agent(context), notices };
}

const file: DiffFile = {
  oldPath: 'example.ts', newPath: 'example.ts', status: 'modified',
  additions: 1, deletions: 0, isBinary: false,
  hunks: [{
    oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, header: '@@ -1,0 +1 @@',
    lines: [{ type: 'add', content: 'export const value = 1;', newLineNumber: 1 }],
  }],
};
const story: StoryNarrative = {
  title: 'AI review', synopsis: 'Analysis', suggestedCommitMessage: 'feat: add value',
  chapters: [{
    index: 1, filePath: 'example.ts', title: 'Value', role: 'Code',
    summary: 'Added value', narrative: 'AI analysis', keyPoints: [], issues: [],
  }],
};

test('explicit AI selection is retained even when credentials are unavailable', async () => {
  for (const providerId of ['openai', 'gemini', 'vscode-lm', 'ollama']) {
    const { agent } = createAgent(providerId);
    assert.equal((await agent.getProvider()).id, providerId);
  }
});

test('legacy heuristic cache is ignored and a failed AI request is retried on refresh', async () => {
  const { agent, notices } = createAgent();
  let calls = 0;
  const provider: AIProvider = {
    id: 'openai', displayName: 'Test AI',
    isAvailable: async () => true,
    generateStory: async () => {
      calls++;
      if (calls === 1) throw new Error('Temporary outage');
      return story;
    },
    askQuestion: async () => '',
  };
  agent.getProvider = async () => provider;
  const fileHashes = [{ filePath: file.newPath, fileHash: computeFileDiffHash(file.newPath, file.hunks) }];
  const hash = computeChangesetHash(fileHashes, provider.displayName, 'test-model');
  agent.getCache().setChangeset(hash, story, 'Heuristic Offline Engine', fileHashes);
  const originalCacheStats = agent.getCache().getStats();

  const fallback = await agent.generateStory([file], { repoName: 'test' });
  assert.equal(calls, 1);
  assert.equal(fallback.providerName, 'Heuristic Offline Engine');
  assert.equal(fallback.fromCache, false);
  assert.equal(notices.length, 1);
  assert.deepEqual(agent.getCache().getStats(), originalCacheStats);

  const recovered = await agent.generateStory([file], { repoName: 'test' });
  assert.equal(calls, 2);
  assert.equal(recovered.providerName, 'Test AI');
  assert.equal(recovered.fromCache, false);
  const cached = await agent.generateStory([file], { repoName: 'test' });
  assert.equal(calls, 2);
  assert.equal(cached.providerName, 'Test AI (Cached)');
});

test('explicit heuristic-only mode can still reuse its own cache', async () => {
  const { agent } = createAgent('heuristic-only');
  const first = await agent.generateStory([file], { repoName: 'test' });
  const second = await agent.generateStory([file], { repoName: 'test' });
  assert.equal(first.fromCache, false);
  assert.equal(second.providerName, 'Heuristic Offline Engine (Cached)');
  assert.equal(second.fromCache, true);
});
