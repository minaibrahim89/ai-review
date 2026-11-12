import { test } from 'node:test';
import * as assert from 'node:assert';
import { resolveSeverityLevel } from '../ai/types';

test('resolveSeverityLevel respects explicit severityLevel values', () => {
  assert.strictEqual(resolveSeverityLevel({ severity: 'warning', severityLevel: 'critical' }), 'critical');
  assert.strictEqual(resolveSeverityLevel({ severity: 'warning', severityLevel: 'high' }), 'high');
  assert.strictEqual(resolveSeverityLevel({ severity: 'security', severityLevel: 'medium' }), 'medium');
  assert.strictEqual(resolveSeverityLevel({ severity: 'bug', severityLevel: 'low' }), 'low');
  assert.strictEqual(resolveSeverityLevel({ severity: 'suggestion', severityLevel: 'info' }), 'info');
});

test('resolveSeverityLevel detects critical keywords in title or description', () => {
  assert.strictEqual(
    resolveSeverityLevel({
      severity: 'warning',
      title: 'Potential Hardcoded Secret',
      description: 'API key detected in code.',
    }),
    'critical'
  );

  assert.strictEqual(
    resolveSeverityLevel({
      severity: 'suggestion',
      title: 'SQL injection risk',
      description: 'Raw query constructed with string concatenation.',
    }),
    'critical'
  );

  assert.strictEqual(
    resolveSeverityLevel({
      severity: 'warning',
      title: 'Auth Bypass Detected',
      description: 'Route does not verify authentication token.',
    }),
    'critical'
  );
});

test('resolveSeverityLevel infers high severity for security and bug categories', () => {
  assert.strictEqual(
    resolveSeverityLevel({
      severity: 'security',
      title: 'Missing CSRF check',
      description: 'Form submission lacks anti-CSRF token.',
    }),
    'high'
  );

  assert.strictEqual(
    resolveSeverityLevel({
      severity: 'bug',
      title: 'Null pointer dereference',
      description: 'Accessing user.id when user can be undefined.',
    }),
    'high'
  );
});

test('resolveSeverityLevel infers medium severity for warnings and performance issues', () => {
  assert.strictEqual(
    resolveSeverityLevel({
      severity: 'warning',
      title: 'Debugging statement',
      description: 'console.log left in production code.',
    }),
    'medium'
  );

  assert.strictEqual(
    resolveSeverityLevel({
      severity: 'perf',
      title: 'N+1 query pattern',
      description: 'Database query executed inside loop.',
    }),
    'medium'
  );
});

test('resolveSeverityLevel infers low or info severity for suggestions and style notes', () => {
  assert.strictEqual(
    resolveSeverityLevel({
      severity: 'suggestion',
      title: 'Extract Helper Method',
      description: 'Code could be simplified with a utility function.',
    }),
    'low'
  );

  assert.strictEqual(
    resolveSeverityLevel({
      severity: 'suggestion',
      title: 'Unresolved TODO note',
      description: 'TODO: Refactor this logic later.',
    }),
    'low'
  );
});
