import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { StoryNarrative } from '../ai/types';
import { ExtensionMessageToWebview } from '../webview/types';

class TestElement {
  classList = {
    values: new Set<string>(),
    add(value: string) { this.values.add(value); },
    remove(value: string) { this.values.delete(value); },
    contains(value: string) { return this.values.has(value); },
  };
  style = {};
  listeners = new Map<string, Array<(e?: any) => void>>();
  value = '';
  textContent = '';
  innerHTML = '';
  disabled = false;
  hidden = false;
  addEventListener(type: string, fn: (e?: any) => void) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type: string) {
    for (const fn of this.listeners.get(type) || []) {
      fn({ target: this, preventDefault() {} });
    }
  }
  appendChild() {}
  querySelectorAll() { return []; }
}

test('review overlay stays open through partial results and unrelated messages, then closes on completion or error', () => {
  const elements = new Map<string, TestElement>();
  const element = (id: string) => {
    let result = elements.get(id);
    if (!result) {
      result = new TestElement();
      elements.set(id, result);
    }
    return result;
  };
  const posted: unknown[] = [];
  let onMessage: ((event: { data: ExtensionMessageToWebview }) => void) | undefined;
  runInNewContext(readFileSync(path.join(__dirname, '..', 'webview', 'app.js'), 'utf8'), {
    acquireVsCodeApi: () => ({ postMessage: (msg: unknown) => posted.push(msg) }),
    document: {
      getElementById: element,
      createElement: () => new TestElement(),
      body: new TestElement(),
    },
    window: {
      addEventListener(type: string, handler: typeof onMessage) {
        if (type === 'message') onMessage = handler;
      },
    },
    alert() {},
  });
  const send = (data: ExtensionMessageToWebview) => {
    assert.ok(onMessage);
    onMessage({ data });
  };
  const story: StoryNarrative = {
    title: 'Review',
    synopsis: '',
    suggestedCommitMessage: '',
    chapters: ['first.ts', 'second.ts'].map((filePath, index) => ({
      index: index + 1, filePath, title: filePath, role: 'Code',
      summary: '', narrative: '', keyPoints: [], issues: [], isPending: true,
    })),
  };
  const isBlocking = () => element('loading-overlay').classList.contains('open');

  send({ type: 'loading', payload: { message: 'Analyzing...' } });
  send({
    type: 'init',
    payload: { story, providerName: 'AI', currentRepo: { rootUri: '', name: 'test' }, repos: [], scope: 'all', themeStyle: 'zen' },
  });
  assert.equal(isBlocking(), true);

  story.chapters[0].isPending = false;
  send({ type: 'updateStory', payload: { story } });
  assert.equal(isBlocking(), true);
  send({ type: 'setTheme', payload: { themeStyle: 'compact' } });
  assert.equal(isBlocking(), true);

  story.chapters[1].isPending = false;
  send({ type: 'updateStory', payload: { story } });
  assert.equal(isBlocking(), false);

  send({ type: 'loading', payload: { message: 'Refreshing...' } });
  send({ type: 'error', payload: { message: 'Review failed' } });
  assert.equal(isBlocking(), false);

  send({ type: 'loading', payload: { message: 'Refreshing...' } });
  send({ type: 'updateStory', payload: { story: { ...story, chapters: [] } } });
  assert.equal(isBlocking(), false);

  // Cancel button posts cancelReview and closes overlay upon reviewCancelled
  send({ type: 'loading', payload: { message: 'Generating AI review...' } });
  assert.equal(isBlocking(), true);
  assert.equal(element('cancel-review-btn').hidden, false);
  element('cancel-review-btn').dispatch('click');
  assert.equal(element('cancel-review-btn').disabled, true);
  assert.equal(element('cancel-review-btn').textContent, 'Cancelling...');
  assert.deepEqual(JSON.parse(JSON.stringify(posted[posted.length - 1])), { type: 'cancelReview' });

  send({ type: 'reviewCancelled', payload: { message: 'AI review generation cancelled.' } });
  assert.equal(isBlocking(), false);
  assert.equal(element('cancel-review-btn').disabled, false);
  assert.equal(element('cancel-review-btn').textContent, 'Cancel');
});
