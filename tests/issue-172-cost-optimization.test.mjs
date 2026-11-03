import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('admin activity polling backs off for active and idle refreshes', () => {
  const source = read('../website/admin/admin-activity-centre.js');
  assert.match(source, /const ACTIVE_POLL_MS = 10000/);
  assert.match(source, /const IDLE_POLL_MS = 60000/);
  assert.match(source, /const missingTrackedIds = \[\.\.\.tracked\]\.filter\(\(requestId\) => !statusIds\.has\(requestId\)\)/);
  assert.match(source, /requestIds: missingTrackedIds/);
});

test('Gemini publisher retains only the failure alarm metric identity', () => {
  const source = read('../lambdas/sqs2scouts/function/persistence-processor.mjs');
  assert.match(source, /if \(outcome === 'failure'\)/);
  assert.match(source, /Dimensions: \[\['Outcome'\]\]/);
  assert.doesNotMatch(source, /Dimensions: \[\['Kind', 'Outcome'\]\]/);
  assert.match(source, /if \(name === 'EnrichmentRetry' \|\| name === 'EnrichmentQuarantined'\)/);
  assert.match(source, /Dimensions: \[\[\]\]/);
  assert.doesNotMatch(source, /Dimensions: \[\['Stage', 'Outcome'\]\]/);
});

test('image publishers emit only alarm-backed dimensionless failure/quota metrics', () => {
  const worker = read('../lambdas/sqs2scouts/function/image-provider-worker.mjs');
  assert.match(worker, /metricName === 'Failure' \|\| metricName === 'ProviderQuotaExhausted'/);
  assert.match(worker, /Dimensions: \[\[\]\]/);
  const fullEnrich = read('../lambdas/sqs2scouts/function/full-enrich-core.mjs');
  assert.match(fullEnrich, /if \(outcome === 'failure'\)/);
  assert.match(fullEnrich, /Name: 'Failure'/);
  assert.match(fullEnrich, /Dimensions: \[\[\]\]/);
  assert.doesNotMatch(fullEnrich, /Dimensions: \[\['Provider', 'Outcome'\]\]/);
});

test('image quota deferrals clear TTL for retry_wait rows in both writers', () => {
  for (const [path, functionName] of [
    ['../lambdas/sqs2scouts/function/full-enrich-core.mjs', 'markQuotaDeferralWithoutAttempt'],
    ['../lambdas/sqs2scouts/function/image-provider-worker.mjs', 'markImageDeferral'],
  ]) {
    const source = read(path);
    const deferral = source.match(new RegExp(`async function ${functionName}\\([\\s\\S]*?\\n}\\n`))?.[0];
    assert.ok(deferral, `${functionName} must be present`);
    assert.match(deferral, /:state': \\{ S: 'retry_wait' \\}/);
    assert.match(deferral, /REMOVE #inProgressExpiresAt, #expiresAt/);
    assert.doesNotMatch(deferral, /#expiresAt = :expiresAt/);
    assert.doesNotMatch(deferral, /':expiresAt'\\s*:/);
  }
});

test('cost-audit script refuses any account other than the Scouts account', () => {
  const source = read('../scripts/scouts-cost-audit.mjs');
  assert.match(source, /const ACCOUNT_ID = '553490163883'/);
  assert.match(source, /identity\.Account !== ACCOUNT_ID/);
  assert.match(source, /Math\.min\(500/);
});
