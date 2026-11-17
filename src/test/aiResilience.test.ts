import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { DiffFile } from '../diff/types';
import { AIProvider, StoryNarrative } from '../ai/types';
import { extractJsonObject, parseProviderStoryResponse } from '../ai/providers/responseParser';
import type { StoryAgent } from '../ai/storyAgent';

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

function makeDiffFile(filePath: string): DiffFile {
  return {
    oldPath: filePath,
    newPath: filePath,
    status: 'modified',
    additions: 1,
    deletions: 0,
    isBinary: false,
    hunks: [{
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      header: '@@ -1,0 +1 @@',
      lines: [{ type: 'add', content: `export const v = '${filePath}';`, newLineNumber: 1 }],
    }],
  };
}

function createAgentWithPref(preference: string, secretsMap: Record<string, string> = {}) {
  const notices: string[] = [];
  const module = { exports: {} };
  const vscodeMock = {
    workspace: {
      getConfiguration: () => ({
        get: (key: string) => {
          if (key === 'aiProvider') return preference;
          if (key === 'geminiModel') return 'gemini-3.8-flash';
          if (key === 'openaiModel') return 'gpt-6-luna';
          return undefined;
        },
      }),
    },
    window: { showInformationMessage: (msg: string) => notices.push(msg) },
  };
  runInNewContext(agentCode, {
    module,
    exports: module.exports,
    require: (name: string) => (name === 'vscode' ? vscodeMock : nodeRequire(name)),
    console: { log() {}, warn() {} },
    process: { env: {} },
  });
  const context = {
    workspaceState: { get: (_k: string, d: unknown) => d, update: async () => {} },
    secrets: { get: async (k: string) => secretsMap[k] },
  };
  const Agent = (module.exports as { StoryAgent: new (c: typeof context) => StoryAgent }).StoryAgent;
  return { agent: new Agent(context), notices };
}

test('extractJsonObject and parseProviderStoryResponse handle prose, fences, trailing commas, and path variants', () => {
  const raw = `Sure! Here is the structured review:
\`\`\`json
{
  "title": "Auth Cleanup",
  "synopsis": "Validates tokens cleanly.",
  "suggestedCommitMessage": "fix(auth): validate tokens",
  "chapters": [
    {
      "filePath": "b/src\\\\auth\\\\token.ts",
      "title": "Token Validation",
      "role": "Core Logic",
      "summary": "Checks expiry",
      "narrative": "Validates JWT expiry.",
      "keyPoints": ["Rejects expired tokens",],
      "issues": []
    }
  ],
}
\`\`\`
Hope this helps!`;

  const parsed = extractJsonObject(raw);
  assert.equal(parsed.title, 'Auth Cleanup');

  const files = [makeDiffFile('src/auth/token.ts')];
  const story = parseProviderStoryResponse(raw, files, { repoName: 'app' });
  assert.equal(story.chapters.length, 1);
  assert.equal(story.chapters[0].filePath, 'src/auth/token.ts');
  assert.equal(story.chapters[0].diffFile, files[0]);
});

test('StoryAgent retries omitted files and retains AI review instead of falling back to heuristic', async () => {
  const { agent, notices } = createAgentWithPref('openai');
  const fileA = makeDiffFile('src/a.ts');
  const fileB = makeDiffFile('src/b.ts');
  let callCount = 0;

  const provider: AIProvider = {
    id: 'openai',
    displayName: 'Test AI',
    isAvailable: async () => true,
    generateStory: async (files): Promise<StoryNarrative> => {
      callCount++;
      if (callCount === 1) {
        // Omit src/b.ts on first pass
        return {
          title: 'AI Review',
          synopsis: 'Reviewed A',
          suggestedCommitMessage: 'feat: update',
          chapters: [{
            index: 1, filePath: 'src/a.ts', title: 'A', role: 'Code',
            summary: 'AI summary A', narrative: 'AI narrative A', keyPoints: [], issues: [],
          }],
        };
      }
      // Return omitted file on targeted retry
      return {
        title: 'AI Retry',
        synopsis: 'Reviewed B',
        suggestedCommitMessage: 'feat: update',
        chapters: files.map((f, i) => ({
          index: i + 1, filePath: f.newPath, title: 'B', role: 'Code',
          summary: 'AI summary B', narrative: 'AI narrative B', keyPoints: [], issues: [],
        })),
      };
    },
    askQuestion: async () => '',
  };
  agent.getProvider = async () => provider;

  const res = await agent.generateStory([fileA, fileB], { repoName: 'repo' });
  assert.equal(callCount, 2);
  assert.equal(res.providerName, 'Test AI');
  assert.equal(notices.length, 0);
  assert.equal(res.story.chapters.length, 2);
  assert.equal(res.story.chapters[0].narrative, 'AI narrative A');
  assert.equal(res.story.chapters[1].narrative, 'AI narrative B');
});

test('StoryAgent batches large changesets (>8 files) and emits intermediate progress', async () => {
  const { agent } = createAgentWithPref('openai');
  const files = Array.from({ length: 10 }, (_, i) => makeDiffFile(`src/file${i + 1}.ts`));
  const batchSizes: number[] = [];
  const progressCounts: number[] = [];

  const provider: AIProvider = {
    id: 'openai',
    displayName: 'Test AI',
    isAvailable: async () => true,
    generateStory: async (batch): Promise<StoryNarrative> => {
      batchSizes.push(batch.length);
      return {
        title: 'Batched Review',
        synopsis: 'Summary',
        suggestedCommitMessage: 'feat: batch',
        chapters: batch.map((f, idx) => ({
          index: idx + 1,
          filePath: f.newPath,
          title: f.newPath,
          role: 'Code',
          summary: 'AI',
          narrative: `AI review of ${f.newPath}`,
          keyPoints: [],
          issues: [],
        })),
      };
    },
    askQuestion: async () => '',
  };
  agent.getProvider = async () => provider;

  const res = await agent.generateStory(files, { repoName: 'repo' }, false, s => {
    progressCounts.push(s.chapters.filter(c => !c.isPending).length);
  });

  assert.deepEqual(batchSizes, [8, 2]);
  assert.ok(progressCounts.includes(8));
  assert.equal(res.providerName, 'Test AI');
  assert.equal(res.story.chapters.length, 10);
});

test('StoryAgent in auto mode tries secondary available AI provider before falling back to heuristic', async () => {
  const { agent, notices } = createAgentWithPref('auto', {
    'gitStory.geminiApiKey': 'gemini-key',
    'gitStory.openaiApiKey': 'openai-key',
  });

  const internal = agent as any;
  internal.geminiProvider = {
    id: 'gemini',
    displayName: 'Google Gemini',
    isAvailable: async () => true,
    generateStory: async () => { throw new Error('429 rate limited'); },
    askQuestion: async () => '',
  };
  internal.vscodeLmProvider = {
    id: 'vscode-lm',
    displayName: 'VS Code Language Model',
    isAvailable: async () => false,
    generateStory: async () => { throw new Error('unavailable'); },
    askQuestion: async () => '',
  };
  internal.openaiProvider = {
    id: 'openai',
    displayName: 'OpenAI / Compatible',
    isAvailable: async () => true,
    generateStory: async (files: DiffFile[]) => ({
      title: 'OpenAI Fallback Success',
      synopsis: 'Recovered via secondary AI',
      suggestedCommitMessage: 'feat: update',
      chapters: files.map((f, i) => ({
        index: i + 1,
        filePath: f.newPath,
        title: 'Module',
        role: 'Code',
        summary: 'Summary',
        narrative: 'Reviewed by OpenAI fallback',
        keyPoints: [],
        issues: [],
      })),
    }),
    askQuestion: async () => '',
  };

  const res = await agent.generateStory([makeDiffFile('src/app.ts')], { repoName: 'repo' });
  assert.equal(res.providerName, 'OpenAI / Compatible');
  assert.equal(res.story.chapters[0].narrative, 'Reviewed by OpenAI fallback');
  assert.equal(notices.length, 0);
});

test('StoryAgent aborts without heuristic fallback or error notice when signal is cancelled', async () => {
  const { agent, notices } = createAgentWithPref('openai');
  const controller = new AbortController();

  const provider: AIProvider = {
    id: 'openai',
    displayName: 'Test AI',
    isAvailable: async () => true,
    generateStory: async (_files, ctx) => {
      controller.abort();
      if (ctx.signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      throw new Error('Should have aborted');
    },
    askQuestion: async () => '',
  };
  agent.getProvider = async () => provider;

  await assert.rejects(
    () => agent.generateStory([makeDiffFile('src/cancel.ts')], { repoName: 'repo', signal: controller.signal }),
    (err: any) => err?.name === 'ReviewCancelledError'
  );
  assert.equal(notices.length, 0);
});
