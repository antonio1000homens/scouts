import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const scoutsSource = read('lambdas/scouts/function/scouts.mjs');
const workerSource = read('lambdas/sqs2scouts/function/full-enrich-adapter.mjs');
const workerLegacySource = read('lambdas/sqs2scouts/function/sqs2scouts.mjs');
const scoutsTemplate = read('lambdas/cloudformation/templates/scouts.yaml');
const workerTemplate = read('lambdas/cloudformation/templates/sqs2scouts.yaml');
const retryDocs = read('GEMINI-ENRICHMENT-RETRY.md');

function sliceFunction(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test('scheduled enrichment checks per-stage state before both new and retry queue publication', () => {
  const eligibilityCalls = scoutsSource.match(/await checkEnrichmentEligibility\(/g) || [];
  assert.ok(eligibilityCalls.length >= 2, 'expected eligibility checks on new and stale/retry paths');
  assert.match(scoutsSource, /skipReason:\s*eligibility\.reason/);
  assert.match(scoutsSource, /state_store_unavailable/);
});

test('global daily Gemini circuit is checked upstream and fails closed', () => {
  const circuit = sliceFunction(scoutsSource, 'async function isGeminiCircuitOpen', 'async function checkEnrichmentEligibility');
  assert.match(circuit, /GEMINI_DAILY_REQUEST_LIMIT <= 0/);
  assert.match(circuit, /usageScope:\s*\{ S: 'requests' \}/);
  assert.match(circuit, /count >= GEMINI_DAILY_REQUEST_LIMIT/);
  assert.match(circuit, /budget_circuit_open/);
  assert.match(circuit, /budget_circuit_unavailable/);
});

test('CloudFormation provisions retry state, safe parameters, least-required DynamoDB actions and alarms', () => {
  for (const parameter of [
    'GeminiEnrichmentStateTableName',
    'GeminiMaxAttemptsPerStage',
    'GeminiRetryDelayAttempt2Seconds',
    'GeminiRetryDelayAttempt3Seconds',
    'GeminiInProgressLeaseSeconds',
  ]) {
    assert.match(workerTemplate, new RegExp(parameter));
  }
  assert.match(workerTemplate, /AttributeName:\s*hex/);
  assert.match(workerTemplate, /AttributeName:\s*stage/);
  assert.match(workerTemplate, /dynamodb:GetItem/);
  assert.match(workerTemplate, /dynamodb:PutItem/);
  assert.match(workerTemplate, /dynamodb:UpdateItem/);
  assert.match(workerTemplate, /GeminiEnrichmentQuarantineAlarm/);
  assert.match(workerTemplate, /GeminiEnrichmentRetryBurstAlarm/);
  assert.match(scoutsTemplate, /GEMINI_ENRICHMENT_STATE_TABLE_NAME/);
  assert.match(scoutsTemplate, /GEMINI_DAILY_REQUEST_LIMIT/);
});

test('image provider call is owned by atomic stage reservation before any provider budget or external call', () => {
  const imageFlow = sliceFunction(workerSource, 'async function processImageProvider', 'async function resultAfterLegacy');
  const reserve = imageFlow.indexOf('await reserveEnrichmentAttempt');
  const budget = imageFlow.indexOf("provider === 'gemini'\n    ? await reserveGeminiImageBudgets()");
  const cloudflareCall = imageFlow.indexOf('await callCloudflare(prompt)');
  const geminiCall = imageFlow.indexOf('await callGemini(prompt)');
  assert.ok(reserve >= 0 && budget > reserve, 'stage reservation must precede budget reservation');
  assert.ok(cloudflareCall > budget, 'Cloudflare call must occur after reservation and budget');
  assert.ok(geminiCall > budget, 'Gemini call must occur after reservation and budget');
});

test('provider success is cached before event persistence so persistence retries do not regenerate', () => {
  const imageFlow = sliceFunction(workerSource, 'async function processImageProvider', 'async function resultAfterLegacy');
  const cache = imageFlow.indexOf('await markGeminiSucceeded');
  const persist = imageFlow.indexOf('await persistGeneratedImage', cache);
  assert.ok(cache >= 0 && persist > cache, 'generated result must be cached before event persistence');
  assert.match(imageFlow, /loadReusableGeneration/);
  assert.match(imageFlow, /persistence_pending/);
});

test('Slack escalation is warning-on-second-attempt and quarantine-once', () => {
  const notification = sliceFunction(workerSource, 'async function notifyTransition', 'function cloudflareApiError');
  assert.match(notification, /state\.state === 'retry_wait' && attemptCount === 2/);
  assert.match(notification, /state\.state === 'manual_review'/);
  assert.match(notification, /claimEnrichmentEscalation/);
});

test('legacy Gemini worker still reserves per-stage attempts and caches success before persistence', () => {
  assert.match(workerLegacySource, /reserveEnrichmentAttempt/);
  assert.match(workerLegacySource, /loadReusableGeneration/);
  assert.match(workerLegacySource, /markGeminiSucceeded/);
  assert.match(workerLegacySource, /markEnrichmentFailure/);
});

test('manual recovery is documented and requires an explicit HEX + stage reset', () => {
  assert.match(retryDocs, /resetEnrichmentState/);
  assert.match(retryDocs, /HEX_VALUE STAGE/);
  assert.match(retryDocs, /manual_review/);
});
