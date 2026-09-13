import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadFunctionsFromSource } from './helpers/source-function-loader.mjs';

const runtimeActivity = readFileSync('lambdas/scouts/function/runtime-activity.mjs', 'utf8');
const scoutsEntry = readFileSync('lambdas/scouts/function/scouts-entry.mjs', 'utf8');
const activityCentre = readFileSync('website/admin/admin-activity-centre.js', 'utf8');

function assertSyntax(path) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path} syntax failed: ${result.stderr || result.stdout}`);
}

function recoveryClassifier() {
  const loaded = loadFunctionsFromSource(
    runtimeActivity,
    ['text', 'enrichmentStageFromActivity', 'classifyRuntimeRecovery'],
    {
      TERMINAL_FAILURES: new Set(['failed', 'needs_attention', 'manual_review']),
      RECOVERABLE_ENRICHMENT_STAGES: new Set(['tagline', 'imageTheme', 'image']),
    },
  );
  return loaded.functions.classifyRuntimeRecovery;
}

test('manual recovery implementation files are syntactically valid', () => {
  assertSyntax('lambdas/scouts/function/runtime-activity.mjs');
  assertSyntax('lambdas/scouts/function/scouts-entry.mjs');
  assertSyntax('website/admin/admin-activity-centre.js');
});

test('backend classifies manual_review from the underlying enrichment timeline stage', () => {
  const classifyRuntimeRecovery = recoveryClassifier();
  const recovery = classifyRuntimeRecovery({
    requestId: 'root-1',
    state: 'manual_review',
    stage: 'manual_review',
    hex: 'abcd',
    timeline: [
      { state: 'processing', stage: 'tagline', at: '2026-09-13T06:00:00Z' },
      { state: 'manual_review', stage: 'manual_review', at: '2026-09-13T06:01:00Z' },
    ],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(recovery)), {
    type: 'enrichment_retry',
    available: true,
    action: 'retry',
    label: 'Retry enrichment',
    stage: 'tagline',
    message: 'Retry the tagline enrichment from its durable manual-review state.',
  });
});

test('backend classifies DLQ and unsupported terminal failures without exposing replay data', () => {
  const classifyRuntimeRecovery = recoveryClassifier();
  const dlq = classifyRuntimeRecovery({
    state: 'needs_attention',
    stage: 'scoutsProcessingDLQ',
    failureType: 'WORKER_DELIVERY_EXHAUSTED',
  });
  assert.equal(dlq.type, 'dlq_recovery');
  assert.equal(dlq.action, 'open_operations');
  assert.equal('payload' in dlq, false);
  assert.equal('queueBody' in dlq, false);

  const unsupported = classifyRuntimeRecovery({ state: 'failed', stage: 'persist' });
  assert.equal(unsupported.type, 'unsupported');
  assert.equal(unsupported.available, false);
});

test('runtime activity attaches backend-generated recovery metadata to presented failures', () => {
  assert.match(runtimeActivity, /recovery: classifyRuntimeRecovery\(request\)/);
  assert.match(runtimeActivity, /WORKER_DELIVERY_EXHAUSTED/);
  assert.match(runtimeActivity, /This terminal failure has no safe idempotent manual recovery handler/);
});

test('enrichment recovery command accepts an activity ID and re-reads canonical activity before acting', () => {
  assert.match(scoutsEntry, /function recoveryActivityId/);
  assert.match(scoutsEntry, /buildRuntimeActivity\(\{ rootRequestId: activityId, limit: 50 \}\)/);
  assert.match(scoutsEntry, /buildRuntimeActivity\(\{ requestIds: \[activityId\], limit: 50 \}\)/);
  assert.match(scoutsEntry, /recovery\?\.type !== 'enrichment_retry'/);
  assert.match(scoutsEntry, /const hex = normalizePrivateEventHex\(request\.hex\)/);
  assert.match(scoutsEntry, /const stage = normaliseEnrichmentStage\(recovery\.stage\)/);
});

test('durable manual-review reset remains the concurrency gate and prevents duplicate retries', () => {
  assert.match(scoutsEntry, /retryManualReviewEnrichment\(\{/);
  assert.match(scoutsEntry, /Enrichment stage is no longer in manual review/);
  assert.match(scoutsEntry, /state changed before retry could be reserved/i);
  assert.match(scoutsEntry, /source: 'admin-manual-review-retry'/);
  assert.match(scoutsEntry, /subject: retrySubject/);
  assert.match(scoutsEntry, /action: 'request'/);
});

test('Activity retry submits only the operation ID as recovery input', () => {
  const retryStart = activityCentre.indexOf('async function retryManualReview');
  const retryEnd = activityCentre.indexOf('\n    async function poll()', retryStart);
  const retrySource = activityCentre.slice(retryStart, retryEnd);

  assert.match(retrySource, /window\.confirm/);
  assert.match(retrySource, /button\.disabled = true/);
  assert.match(retrySource, /button\.textContent = 'Retrying…'/);
  assert.match(retrySource, /subject: 'enrichment'/);
  assert.match(retrySource, /action: 'retry'/);
  assert.match(retrySource, /activityId,/);
  assert.doesNotMatch(retrySource, /\n\s+hex,/);
  assert.doesNotMatch(retrySource, /\n\s+stage,/);
  assert.match(retrySource, /Enrichment retry failed/);
});

test('Activity cards expose enrichment, guarded DLQ navigation, and unsupported recovery states', () => {
  assert.match(activityCentre, /Retry enrichment/);
  assert.match(activityCentre, /activity-open-dlq-recovery/);
  assert.match(activityCentre, /Open Operations → DLQ recovery/);
  assert.match(activityCentre, /openOperationsRecovery/);
  assert.match(activityCentre, /diagnostics-open/);
  assert.match(activityCentre, /diagnostics-queue-health/);
  assert.match(activityCentre, /activity-recovery-note/);
  assert.match(activityCentre, /Manual recovery is not supported/);
});
