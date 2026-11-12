import { test } from 'node:test';
import * as assert from 'node:assert';
import { buildCopilotPrompt } from '../webview/copilotPrompt';

test('buildCopilotPrompt formats prompt with file, line, and suggestion', () => {
  const prompt = buildCopilotPrompt('src/auth/jwt.ts', {
    id: 'iss-1',
    title: 'Missing Token Expiration Validation',
    description: 'The jwt.verify callback does not check for expired tokens before accepting claims.',
    severity: 'security',
    lineNumber: 42,
    suggestion: 'Add maxAge or ignoreExpiration: false in jwt.verifyOptions.',
  });

  assert.ok(prompt.includes('SECURITY concern in src/auth/jwt.ts around line 42'));
  assert.ok(prompt.includes('Issue: Missing Token Expiration Validation'));
  assert.ok(prompt.includes('The jwt.verify callback does not check for expired tokens'));
  assert.ok(prompt.includes('Suggested Fix:\nAdd maxAge or ignoreExpiration: false'));
  assert.ok(prompt.includes('Please explain how to resolve this concern and provide the corrected code.'));
});

test('buildCopilotPrompt handles issue without line number or suggestion', () => {
  const prompt = buildCopilotPrompt('config/database.json', {
    title: 'Hardcoded Database Password',
    description: 'Plaintext secret found in version controlled configuration file.',
    severity: 'warning',
  });

  assert.ok(prompt.includes('WARNING concern in config/database.json:'));
  assert.ok(!prompt.includes('around line'));
  assert.ok(!prompt.includes('Suggested Fix'));
  assert.ok(prompt.includes('Issue: Hardcoded Database Password'));
  assert.ok(prompt.includes('Plaintext secret found in version controlled configuration file.'));
});
