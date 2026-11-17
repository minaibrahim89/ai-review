import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { DiffParser } from '../diff/diffParser';
import { IntentionDetector } from '../ai/intentionContext';
import { RepoCrossChecker } from '../ai/repoCrossCheck';
import { AIProvider, StoryNarrative } from '../ai/types';
import { CommitRef, DiffScope, GitBranchInfo } from '../git/types';
import type { GitService } from '../git/gitService';
import type { StoryAgent } from '../ai/storyAgent';
import type * as ReviewHelperModule from '../webview/reviewHelper';
import { ExtensionMessageToWebview, WebviewMessageToExtension } from '../webview/types';

function normalizeRealm<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
const nodeRequire = createRequire(__filename);
const esbuild: typeof import('esbuild') = nodeRequire('esbuild');

function loadWithVscodeMock<T>(entryRelPath: string, vscodeMock: unknown): T {
  const code = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', '..', entryRelPath)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  }).outputFiles[0].text;

  const module = { exports: {} as T };
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name: string) => (name === 'vscode' ? vscodeMock : nodeRequire(name)),
    console: { log() {}, warn() {}, error() {} },
    process,
  });
  return module.exports;
}

const minimalVscodeMock = {
  extensions: { getExtension: () => undefined },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
  },
  window: { showInformationMessage: () => {}, showErrorMessage: () => {} },
  Uri: {
    from: (parts: { scheme: string; path: string; query?: string }) => parts,
    file: (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath }),
  },
};

const { GitService: GitServiceClass } = loadWithVscodeMock<{ GitService: new () => GitService }>(
  'src/git/gitService.ts',
  minimalVscodeMock
);
const reviewHelper = loadWithVscodeMock<typeof ReviewHelperModule>(
  'src/webview/reviewHelper.ts',
  minimalVscodeMock
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createTempRepo(): { dir: string; commits: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-story-compare-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');

  fs.writeFileSync(path.join(dir, 'base.ts'), 'export const version = 1;\n');
  fs.writeFileSync(path.join(dir, 'legacy.ts'), 'export const legacy = true;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'feat: initial commit');
  const c1 = git(dir, 'rev-parse', 'HEAD');

  fs.writeFileSync(path.join(dir, 'base.ts'), 'export const version = 2;\nexport const stable = true;\n');
  fs.writeFileSync(path.join(dir, 'feature.ts'), 'export function run() { return 42; }\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'feat: add feature and bump version');
  const c2 = git(dir, 'rev-parse', 'HEAD');

  git(dir, 'rm', 'legacy.ts');
  fs.writeFileSync(path.join(dir, 'feature.ts'), 'export function run() { return 99; }\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'refactor: remove legacy and update run');
  const c3 = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'tag', 'v1.0.0', c2);

  return { dir, commits: [c1, c2, c3] };
}

test('GitService resolves commits, lists history, and diffs any two commits in either direction', async () => {
  const { dir, commits: [c1, c2, c3] } = createTempRepo();
  try {
    const gitService = new GitServiceClass();
    const listed = await gitService.getCommits(dir, 10);
    assert.equal(listed.length, 3);
    assert.equal(listed[0].hash, c3);
    assert.equal(listed[2].hash, c1);

    // Resolve by short SHA, tag, relative ref, and reject invalid/flag-like refs
    const resolvedTag = await gitService.resolveCommit(dir, 'v1.0.0');
    assert.equal(resolvedTag?.hash, c2);
    const resolvedRel = await gitService.resolveCommit(dir, 'HEAD~2');
    assert.equal(resolvedRel?.hash, c1);
    assert.equal(await gitService.resolveCommit(dir, 'nonexistent-ref'), null);
    assert.equal(await gitService.resolveCommit(dir, '--version'), null);

    // Diff c1 -> c3
    const forwardRaw = await gitService.getCommitDiff(dir, c1, c3);
    const forwardFiles = DiffParser.parse(forwardRaw);
    const forwardByPath = new Map(forwardFiles.map(f => [f.newPath || f.oldPath, f]));
    assert.equal(forwardByPath.get('base.ts')?.status, 'modified');
    assert.equal(forwardByPath.get('feature.ts')?.status, 'added');
    assert.equal(forwardByPath.get('legacy.ts')?.status, 'deleted');

    // Reverse diff c3 -> c1
    const reverseRaw = await gitService.getCommitDiff(dir, c3, c1);
    const reverseFiles = DiffParser.parse(reverseRaw);
    const reverseByPath = new Map(reverseFiles.map(f => [f.newPath || f.oldPath, f]));
    assert.equal(reverseByPath.get('feature.ts')?.status, 'deleted');
    assert.equal(reverseByPath.get('legacy.ts')?.status, 'added');

    // Same commit -> empty diff
    const sameRaw = await gitService.getCommitDiff(dir, c2, c2);
    assert.equal(DiffParser.parse(sameRaw).length, 0);

    // Range commits
    const range = await gitService.getCommitsInRange(dir, c1, c3, 10);
    assert.equal(range.length, 2);
    assert.deepEqual(normalizeRealm(range.map(c => c.hash)), [c3, c2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewHelper validates commit pairs, describes diff URIs, and loads target snapshots', async () => {
  const { dir, commits: [c1, , c3] } = createTempRepo();
  try {
    const gitService = new GitServiceClass();
    const emptyErr = await reviewHelper.resolveAndValidateComparison(gitService, dir, '', 'HEAD');
    assert.equal(emptyErr.invalidField, 'base');

    const badTargetErr = await reviewHelper.resolveAndValidateComparison(gitService, dir, c1, 'bad-ref');
    assert.equal(badTargetErr.invalidField, 'target');

    const valid = await reviewHelper.resolveAndValidateComparison(gitService, dir, c1, c3);
    assert.ok(valid.comparison);
    assert.equal(valid.comparison.base.hash, c1);
    assert.equal(valid.comparison.target.hash, c3);

    const diffFiles = DiffParser.parse(await gitService.getCommitDiff(dir, c1, c3));
    const extras = await reviewHelper.loadComparisonExtras(gitService, dir, diffFiles, valid.comparison);
    assert.equal(extras.comparisonCommits.length, 2);
    assert.ok(extras.targetFileContents.get('feature.ts')?.includes('return 99'));
    assert.equal(extras.targetFileContents.has('legacy.ts'), false);

    // Verify native diff URI specs for modified, added, deleted, and renamed files
    const modifiedTarget = reviewHelper.describeDiffTarget(
      dir,
      {
        index: 1, filePath: 'base.ts', title: 'Base', role: 'Code', summary: '', narrative: '',
        keyPoints: [], issues: [],
        diffFile: { oldPath: 'base.ts', newPath: 'base.ts', status: 'modified', hunks: [], additions: 1, deletions: 0, isBinary: false },
      },
      'commits',
      valid.comparison
    );
    assert.deepEqual(normalizeRealm(modifiedTarget.left), { kind: 'git', repoRoot: dir, filePath: 'base.ts', ref: c1 });
    assert.deepEqual(normalizeRealm(modifiedTarget.right), { kind: 'git', repoRoot: dir, filePath: 'base.ts', ref: c3 });

    const addedTarget = reviewHelper.describeDiffTarget(
      dir,
      {
        index: 2, filePath: 'feature.ts', title: 'Feature', role: 'Code', summary: '', narrative: '',
        keyPoints: [], issues: [],
        diffFile: { oldPath: '', newPath: 'feature.ts', status: 'added', hunks: [], additions: 1, deletions: 0, isBinary: false },
      },
      'commits',
      valid.comparison
    );
    assert.equal(addedTarget.left.kind, 'empty');
    assert.deepEqual(normalizeRealm(addedTarget.right), { kind: 'git', repoRoot: dir, filePath: 'feature.ts', ref: c3 });

    const renamedTarget = reviewHelper.describeDiffTarget(
      dir,
      {
        index: 3, filePath: 'newName.ts', title: 'Renamed', role: 'Code', summary: '', narrative: '',
        keyPoints: [], issues: [],
        diffFile: { oldPath: 'oldName.ts', newPath: 'newName.ts', status: 'renamed', hunks: [], additions: 0, deletions: 0, isBinary: false },
      },
      'commits',
      valid.comparison
    );
    assert.deepEqual(normalizeRealm(renamedTarget.left), { kind: 'git', repoRoot: dir, filePath: 'oldName.ts', ref: c1 });
    assert.deepEqual(normalizeRealm(renamedTarget.right), { kind: 'git', repoRoot: dir, filePath: 'newName.ts', ref: c3 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StoryAgent, IntentionDetector, and RepoCrossChecker isolate commit comparison context and cache', async () => {
  const base: CommitRef = { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject: 'Base state' };
  const target: CommitRef = { hash: 'b'.repeat(40), shortHash: 'bbbbbbb', subject: 'Target state' };

  const intention = await IntentionDetector.detectIntention(
    process.cwd(),
    [],
    undefined,
    undefined,
    { base, target },
    [{ hash: 'c'.repeat(40), shortHash: 'ccccccc', subject: 'feat: intermediate step' }]
  );
  assert.ok(intention.summary.includes('aaaaaaa → bbbbbbb'));
  assert.ok(intention.promptContext.includes('feat: intermediate step'));

  // RepoCrossChecker should check snapshot fileContents instead of working tree
  const snapshotMap = new Map<string, string>([
    ['virtual.ts', 'try {\n  JSON.parse(raw);\n} catch {}\n'],
  ]);
  const issues = RepoCrossChecker.verifyAndFilterIssues(
    [{
      id: 'i1', severity: 'warning', title: 'Potential Unhandled JSON Parse Error',
      description: 'JSON.parse may throw', lineNumber: 2,
    }],
    { oldPath: 'virtual.ts', newPath: 'virtual.ts', status: 'modified', hunks: [], additions: 1, deletions: 0, isBinary: false },
    process.cwd(),
    undefined,
    snapshotMap
  );
  assert.equal(issues.length, 0);

  // StoryAgent caches different commit comparisons independently
  const { StoryAgent: StoryAgentClass } = loadWithVscodeMock<{
    StoryAgent: new (ctx: { workspaceState: unknown; secrets: unknown }) => StoryAgent;
  }>('src/ai/storyAgent.ts', {
    workspace: { getConfiguration: () => ({ get: (k: string) => (k === 'aiProvider' ? 'openai' : 'test-model') }) },
    window: { showInformationMessage: () => {} },
  });
  const agent = new StoryAgentClass({
    workspaceState: { get: (_k: string, d: unknown) => d, update: async () => {} },
    secrets: { get: async () => undefined },
  });

  let aiCalls = 0;
  const provider: AIProvider = {
    id: 'openai',
    displayName: 'Test AI',
    isAvailable: async () => true,
    generateStory: async (_files, ctx) => {
      aiCalls++;
      return {
        title: `${ctx.comparison?.base.shortHash}->${ctx.comparison?.target.shortHash}`,
        synopsis: 'Comparison review',
        suggestedCommitMessage: '',
        chapters: [{
          index: 1, filePath: 'a.ts', title: 'A', role: 'Code',
          summary: 'S', narrative: 'N', keyPoints: [], issues: [],
        }],
      };
    },
    askQuestion: async () => '',
  };
  agent.getProvider = async () => provider;

  const diffFile = {
    oldPath: 'a.ts', newPath: 'a.ts', status: 'modified' as const,
    additions: 1, deletions: 0, isBinary: false,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, header: '@@ -1,0 +1 @@', lines: [{ type: 'add' as const, content: 'x = 1;', newLineNumber: 1 }] }],
  };

  const first = await agent.generateStory([diffFile], { repoName: 'repo', comparison: { base, target } });
  const second = await agent.generateStory([diffFile], { repoName: 'repo', comparison: { base, target } });
  const reversed = await agent.generateStory([diffFile], { repoName: 'repo', comparison: { base: target, target: base } });

  assert.equal(aiCalls, 2);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(reversed.fromCache, false);
  assert.equal(reversed.story.title, 'bbbbbbb->aaaaaaa');
});

test('webview UI renders commit comparison controls, hides working-tree actions, and submits compare refs', () => {
  class MockElement {
    classList = {
      values: new Set<string>(),
      add(v: string) { this.values.add(v); },
      remove(v: string) { this.values.delete(v); },
      contains(v: string) { return this.values.has(v); },
    };
    style: Record<string, string> = {};
    attributes = new Map<string, string>();
    listeners = new Map<string, Array<(e?: any) => void>>();
    children: MockElement[] = [];
    options: MockElement[] = [];
    hidden = false;
    disabled = false;
    open = false;
    value = '';
    textContent = '';
    innerHTML = '';
    title = '';
    addEventListener(type: string, fn: (e?: any) => void) {
      const list = this.listeners.get(type) || [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    dispatch(type: string, event: any = {}) {
      for (const fn of this.listeners.get(type) || []) {
        fn({ target: this, preventDefault() {}, ...event });
      }
    }
    appendChild(child: MockElement) {
      this.children.push(child);
      this.options.push(child);
    }
    setAttribute(k: string, v: string) { this.attributes.set(k, v); }
    removeAttribute(k: string) { this.attributes.delete(k); }
    getAttribute(k: string) { return this.attributes.get(k); }
    querySelectorAll() { return []; }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
  }

  const elements = new Map<string, MockElement>();
  const getEl = (id: string) => {
    let el = elements.get(id);
    if (!el) {
      el = new MockElement();
      elements.set(id, el);
    }
    return el;
  };

  const postedMessages: WebviewMessageToExtension[] = [];
  let onMessage: ((event: { data: ExtensionMessageToWebview }) => void) | undefined;

  runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'webview', 'app.js'), 'utf8'), {
    acquireVsCodeApi: () => ({
      postMessage: (msg: WebviewMessageToExtension) => postedMessages.push(msg),
    }),
    document: {
      getElementById: getEl,
      createElement: () => new MockElement(),
      body: new MockElement(),
    },
    window: {
      addEventListener(type: string, handler: typeof onMessage) {
        if (type === 'message') onMessage = handler;
      },
    },
    alert() {},
  });

  assert.ok(onMessage);
  const base: CommitRef = { hash: '1111111111111111111111111111111111111111', shortHash: '1111111', subject: 'Initial' };
  const target: CommitRef = { hash: '2222222222222222222222222222222222222222', shortHash: '2222222', subject: 'Updated' };
  const story: StoryNarrative = {
    title: 'Compare 1111111 -> 2222222',
    synopsis: 'Diff summary',
    suggestedCommitMessage: '',
    chapters: [{
      index: 1, filePath: 'a.ts', title: 'File A', role: 'Code',
      summary: 'S', narrative: 'N', keyPoints: [], issues: [],
    }],
  };

  // Init in commit comparison mode
  onMessage({
    data: {
      type: 'init',
      payload: {
        story,
        providerName: 'Heuristic',
        currentRepo: { rootUri: '/repo', name: 'repo', headBranch: 'main' },
        repos: [],
        scope: 'commits' as DiffScope,
        comparison: { base, target },
        themeStyle: 'zen',
      },
    },
  });

  assert.equal(getEl('compare-bar').hidden, false);
  assert.equal(getEl('repo-branch').textContent, '1111111 ↔ 2222222');
  assert.equal(getEl('stage-file-btn').style.display, 'none');
  assert.equal(getEl('finish-commit-btn').style.display, 'none');

  // Open compare modal, receive commitsList, handle error, and submit valid refs
  getEl('change-commits-btn').dispatch('click');
  assert.equal(getEl('compare-modal').open, true);
  assert.ok(postedMessages.some(m => m.type === 'requestCommits'));

  onMessage({
    data: {
      type: 'commitsList',
      payload: { commits: [target, base], currentBase: '1111111', currentTarget: '2222222' },
    },
  });
  assert.equal(getEl('base-commit-input').value, '1111111');
  assert.equal(getEl('target-commit-input').value, '2222222');

  onMessage({
    data: {
      type: 'compareError',
      payload: { message: 'Could not resolve base commit', invalidField: 'base' },
    },
  });
  assert.equal(getEl('compare-error-msg').textContent, 'Could not resolve base commit');
  assert.equal(getEl('base-commit-input').getAttribute('aria-invalid'), 'true');

  getEl('base-commit-input').value = 'HEAD~2';
  getEl('target-commit-input').value = 'HEAD';
  getEl('compare-form').dispatch('submit');
  assert.deepEqual(normalizeRealm(postedMessages[postedMessages.length - 1]), {
    type: 'compareCommits',
    baseRef: 'HEAD~2',
    targetRef: 'HEAD',
  });

  // Switch to Branches mode via scope selector and verify branch dropdowns & labels
  getEl('scope-select').value = 'branches';
  getEl('scope-select').dispatch('change');
  assert.equal((getEl('compare-mode-branches') as any).checked, true);

  const mainBranch: GitBranchInfo = {
    name: 'main',
    hash: base.hash,
    shortHash: base.shortHash,
    subject: 'Initial',
    isRemote: false,
    isCurrent: false,
  };
  const featureBranch: GitBranchInfo = {
    name: 'feature/auth',
    hash: target.hash,
    shortHash: target.shortHash,
    subject: 'Add auth',
    isRemote: false,
    isCurrent: true,
  };

  getEl('base-commit-input').value = '';
  getEl('target-commit-input').value = '';
  onMessage({
    data: {
      type: 'commitsList',
      payload: {
        commits: [target, base],
        branches: [featureBranch, mainBranch],
        currentBranch: 'feature/auth',
        currentBase: 'main',
        currentTarget: 'feature/auth',
      },
    },
  });
  assert.equal(getEl('base-commit-input').value, 'main');
  assert.equal(getEl('target-commit-input').value, 'feature/auth');
  assert.ok(getEl('base-commit-select').options.some(o => o.value === 'main'));
  assert.ok(getEl('target-commit-select').options.some(o => o.value === 'feature/auth'));

  getEl('compare-form').dispatch('submit');
  assert.deepEqual(normalizeRealm(postedMessages[postedMessages.length - 1]), {
    type: 'compareCommits',
    baseRef: 'main',
    targetRef: 'feature/auth',
  });

  // Render active branch comparison with branch labels and changeSummary
  onMessage({
    data: {
      type: 'init',
      payload: {
        story: {
          ...story,
          changeSummary: {
            purpose: 'Adds branch authentication flow.',
            architectureReview: 'Separates auth middleware from controllers.',
            potentialIssues: ['Token expiry edge case on clock skew'],
          },
        },
        providerName: 'Heuristic',
        currentRepo: { rootUri: '/repo', name: 'repo', headBranch: 'feature/auth' },
        repos: [],
        scope: 'commits' as DiffScope,
        comparison: {
          base: { ...base, label: 'main' },
          target: { ...target, label: 'feature/auth' },
        },
        themeStyle: 'zen',
      },
    },
  });
  assert.equal(getEl('repo-branch').textContent, 'main ↔ feature/auth');
  assert.ok(getEl('compare-base-badge').textContent.startsWith('main (1111111)'));
  assert.ok(getEl('compare-target-badge').textContent.startsWith('feature/auth (2222222)'));
  assert.equal(getEl('branch-summary-card').hidden, false);
  assert.equal(getEl('branch-summary-range').textContent, 'main ↔ feature/auth');
  assert.ok(getEl('branch-summary-purpose').innerHTML.includes('Adds branch authentication flow.'));
  assert.ok(getEl('branch-summary-architecture').innerHTML.includes('Separates auth middleware'));
  assert.equal(getEl('branch-summary-issues').children.length, 1);

  // Switching back to working tree hides branch-summary-card
  onMessage({
    data: {
      type: 'init',
      payload: {
        story,
        providerName: 'Heuristic',
        currentRepo: { rootUri: '/repo', name: 'repo', headBranch: 'feature/auth' },
        repos: [],
        scope: 'all' as DiffScope,
        themeStyle: 'zen',
      },
    },
  });
  assert.equal(getEl('branch-summary-card').hidden, true);
});

test('GitService.getBranches and buildCommitsListPayload list branches and preserve branch labels', async () => {
  const { dir, commits: [, c2] } = createTempRepo();
  try {
    const defaultBranch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(dir, 'checkout', '-b', 'feature/login', c2);
    fs.writeFileSync(path.join(dir, 'login.ts'), 'export const login = () => true;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'feat: add login');

    const gitService = new GitServiceClass();
    const branches = await gitService.getBranches(dir);
    assert.ok(branches.some(b => b.name === defaultBranch && !b.isCurrent && !b.isRemote));
    assert.ok(branches.some(b => b.name === 'feature/login' && b.isCurrent && !b.isRemote));

    const resolvedBase = await gitService.resolveCommit(dir, defaultBranch);
    const resolvedTarget = await gitService.resolveCommit(dir, 'feature/login');
    assert.equal(resolvedBase?.label, defaultBranch);
    assert.equal(resolvedTarget?.label, 'feature/login');

    const diffFiles = DiffParser.parse(await gitService.getCommitDiff(dir, resolvedBase!.hash, resolvedTarget!.hash));
    assert.ok(diffFiles.some(f => (f.newPath || f.oldPath) === 'login.ts' && f.status === 'added'));

    const payload = await reviewHelper.buildCommitsListPayload(gitService, dir, 'feature/login');
    assert.equal(payload.currentTarget, 'feature/login');
    assert.equal(payload.currentBase, defaultBranch);
    assert.ok(payload.branches.length >= 2);

    const diffTarget = reviewHelper.describeDiffTarget(
      dir,
      {
        index: 1, filePath: 'login.ts', title: 'Login', role: 'Code', summary: '', narrative: '',
        keyPoints: [], issues: [],
        diffFile: { oldPath: '', newPath: 'login.ts', status: 'added', hunks: [], additions: 1, deletions: 0, isBinary: false },
      },
      'commits',
      { base: resolvedBase!, target: resolvedTarget! }
    );
    assert.equal(diffTarget.title, `login.ts (${defaultBranch} ↔ feature/login)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
