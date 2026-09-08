import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ISSUE_39_FILES = [
  'tests/issue-39-admin-actions.test.mjs',
  'tests/issue-39-actions-rendering.test.mjs',
  'tests/issue-39-synthetic-workflow.integration.test.mjs',
  'tests/helpers/fake-scouts-provider.mjs',
  'tests/helpers/scouts-workflow-harness.mjs',
  'tests/helpers/source-function-loader.mjs',
];

function source(path) {
  return readFileSync(path, 'utf8');
}

test('issue 39 PR tests do not depend on deployment secrets or AWS SDK clients', () => {
  for (const path of ISSUE_39_FILES) {
    const content = source(path);
    assert.doesNotMatch(content, /\bsecrets\./, `${path} must not read GitHub secrets`);
    assert.doesNotMatch(content, /\bvars\.BW_/, `${path} must not read Bitwarden variable IDs`);
    assert.doesNotMatch(content, /from ['"]@aws-sdk\//, `${path} must not instantiate AWS SDK clients`);
    assert.doesNotMatch(content, /bitwarden\/sm-action/, `${path} must not load Bitwarden`);
  }
});

test('issue 39 PR tests contain no real provider inference endpoints', () => {
  for (const path of ISSUE_39_FILES) {
    const content = source(path);
    assert.doesNotMatch(content, /api\.cloudflare\.com\/client\/v4\/accounts/i, `${path} must not call Cloudflare`);
    assert.doesNotMatch(content, /generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com/i, `${path} must not call Gemini/Vertex`);
  }
});

test('fake provider remains confined to test helpers', () => {
  const productionFiles = [
    'lambdas/sqs2scouts/function/cloudflare-image-client.mjs',
    'lambdas/sqs2scouts/function/image-provider-adapter.mjs',
    'lambdas/scouts2sqs/function/request-router.mjs',
  ];
  for (const path of productionFiles) {
    assert.doesNotMatch(source(path), /(?:provider|IMAGE_GENERATION_PROVIDER)[\s\S]{0,120}['"]fake['"]/i, `${path} must not make fake selectable in production`);
  }
});

test('test strategy documents isolated deployed smoke requirements', () => {
  const docs = source('docs/TESTING-STRATEGY.md');
  assert.match(docs, /GitHub OIDC/);
  assert.match(docs, /least-privilege/);
  assert.match(docs, /test\/<run-id>\//);
  assert.match(docs, /if: always\(\)/);
  assert.match(docs, /hard-limited to one provider invocation/);
});