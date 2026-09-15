import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/deploy-to-s3.yml', 'utf8');
const runner = readFileSync('scripts/run-hermetic-tests.mjs', 'utf8');
const eslintConfig = readFileSync('eslint.config.mjs', 'utf8');
const persistence = readFileSync('lambdas/sqs2scouts/function/persistence-processor.mjs', 'utf8');

test('normal CI delegates hermetic selection to one counted runner', () => {
  assert.match(workflow, /run: node scripts\/run-hermetic-tests\.mjs/);
  assert.doesNotMatch(workflow, /Run retry policy unit tests/);
  assert.match(runner, /Hermetic test files selected/);
  assert.match(runner, /selected zero files for/);
  for (const group of ['shared-layer', 'scouts', 'scouts2sqs', 'sqs2scouts', 'repository']) {
    assert.match(runner, new RegExp(`'${group}'`));
  }
});

test('the static gate covers deployed Lambda code and proves no-undef is active', () => {
  assert.match(eslintConfig, /no-undef/);
  assert.match(runner, /no-undef-regression\.mjs/);
  assert.match(runner, /unexpectedly accepted the no-undef regression fixture/);
  assert.match(runner, /lambdas\/sqs2scouts\/function\/\*\*\/\*\.mjs/);
});

test('the occurrence regression invokes the production persistence handler seam', () => {
  assert.match(persistence, /export function createPersistenceHandler\(dependencies = \{\}\)/);
  assert.match(persistence, /AsyncLocalStorage/);
  assert.match(persistence, /extractOccurrenceVisibility\(messageBody, rawSubject, action\)/);
  assert.match(persistence, /runtimeOutcome = \{ status: 'completed' \}/);
  assert.ok(existsSync('lambdas/sqs2scouts/function/tests/test-persistence-handler.mjs'));
});

test('inert OAuth and OSM stubs are absent from normal discovery', () => {
  for (const name of [
    'test-correct-params.mjs', 'test-endpoints.mjs', 'test-events-summary.mjs',
    'test-final-oauth.mjs', 'test-lambda-oauth.mjs', 'test-oauth-final.mjs',
    'test-oauth-flow.mjs', 'test-oauth-scopes.mjs', 'test-oauth-summary.mjs',
    'test-osm-api.mjs', 'test-scopes.mjs', 'test-simple-oauth.mjs', 'test-valid-terms.mjs',
  ]) {
    assert.equal(existsSync(`lambdas/scouts/function/tests/${name}`), false, name);
  }
});
