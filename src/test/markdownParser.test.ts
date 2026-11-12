import { test } from 'node:test';
import * as assert from 'node:assert';
import { formatMarkdown, formatInlineMarkdown } from '../webview/markdown';

test('formatMarkdown should format headers without raw hash markers', () => {
  const input = '### Architecture Overview\n#### Detailed Flow';
  const html = formatMarkdown(input);

  assert.ok(!html.includes('###'));
  assert.ok(!html.includes('####'));
  assert.ok(html.includes('<h4 class="prose-h4">'));
  assert.ok(html.includes('Architecture Overview'));
  assert.ok(html.includes('Detailed Flow'));
});

test('formatMarkdown should format bullet lists without raw dash markers', () => {
  const input = '- First key decision\n- Second architectural shift\n- Third verification step';
  const html = formatMarkdown(input);

  assert.ok(html.includes('<ul class="prose-ul">'));
  assert.ok(html.includes('<li>First key decision</li>'));
  assert.ok(html.includes('<li>Second architectural shift</li>'));
  assert.ok(html.includes('<li>Third verification step</li>'));
  assert.ok(!html.includes('- First'));
});

test('formatMarkdown should format explicit backtick code spans with inline-code class', () => {
  const input = 'We updated `SessionService` to call `redis.get(key)` safely.';
  const html = formatMarkdown(input);

  assert.ok(html.includes('<code class="inline-code">SessionService</code>'));
  assert.ok(html.includes('<code class="inline-code">redis.get(key)</code>'));
  assert.ok(!html.includes('`SessionService`'));
});

test('formatMarkdown should automatically detect and style code identifiers outside tags', () => {
  const input = 'In this step, UserService calls validateToken() and updates auth.token property in user.ts.';
  const html = formatMarkdown(input);

  assert.ok(html.includes('<code class="inline-code">UserService</code>'));
  assert.ok(html.includes('<code class="inline-code">validateToken()</code>'));
  assert.ok(html.includes('<code class="inline-code">auth.token</code>'));
  assert.ok(html.includes('<code class="inline-code">user.ts</code>'));
});

test('formatInlineMarkdown should format bold, italic, and identifiers without raw markdown', () => {
  const input = '**Important:** Check `is_active` parameter in updateUser() method';
  const html = formatInlineMarkdown(input);

  assert.ok(html.includes('<strong>Important:</strong>'));
  assert.ok(html.includes('<code class="inline-code">is_active</code>'));
  assert.ok(html.includes('<code class="inline-code">updateUser()</code>'));
  assert.ok(!html.includes('**'));
  assert.ok(!html.includes('`'));
});

test('formatMarkdown should handle fenced code blocks without mangling code content', () => {
  const input = '```typescript\nconst token = createSession(user);\nreturn token;\n```';
  const html = formatMarkdown(input);

  assert.ok(html.includes('<pre class="code-block"><code>'));
  assert.ok(html.includes('const token = createSession(user);'));
  assert.ok(!html.includes('```'));
});
