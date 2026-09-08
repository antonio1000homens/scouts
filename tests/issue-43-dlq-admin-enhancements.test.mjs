import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const runtimeDlq = readFileSync('lambdas/scouts/function/runtime-dlq.mjs', 'utf8');
const scoutsEntry = readFileSync('lambdas/scouts/function/scouts-entry.mjs', 'utf8');
const scoutsTemplate = readFileSync('lambdas/cloudformation/templates/scouts.yaml', 'utf8');
const adminEnhancements = readFileSync('website/admin/admin-diagnostics-enhancements.js', 'utf8');
const adminHtml = readFileSync('website/admin/index.html', 'utf8');

function assertSyntax(path) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path} syntax failed: ${result.stderr || result.stdout}`);
}

test('new DLQ and browser enhancement modules are syntactically valid', () => {
  assertSyntax('lambdas/scouts/function/runtime-dlq.mjs');
  assertSyntax('lambdas/scouts/function/scouts-entry.mjs');
  assertSyntax('website/admin/admin-diagnostics-enhancements.js');
});

test('DLQ inspection is explicit, bounded and non-destructive', () => {
  assert.match(runtimeDlq, /ReceiveMessageCommand/);
  assert.match(runtimeDlq, /MAX_SAMPLE_MESSAGES = 10/);
  assert.match(runtimeDlq, /VisibilityTimeout: 0/);
  assert.match(runtimeDlq, /WaitTimeSeconds: 0/);
  assert.doesNotMatch(runtimeDlq, /DeleteMessageCommand/);
  assert.match(runtimeDlq, /SQS has no peek API/);
  assert.match(runtimeDlq, /ApproximateReceiveCount/);
});

test('DLQ operations are allow-listed to the two Scouts dead-letter queues', () => {
  assert.match(runtimeDlq, /scoutsRequestsDLQ/);
  assert.match(runtimeDlq, /scoutsProcessingDLQ/);
  assert.match(runtimeDlq, /Unsupported DLQ/);
  assert.doesNotMatch(runtimeDlq, /queueUrl:\s*text\(queueName\)/);
});

test('redrive is guarded against stale counts and throttled', () => {
  assert.match(runtimeDlq, /StartMessageMoveTaskCommand/);
  assert.match(runtimeDlq, /expectedVisible/);
  assert.match(runtimeDlq, /DLQ count changed from/);
  assert.match(runtimeDlq, /REDRIVE_RATE_PER_SECOND = 1/);
  assert.match(runtimeDlq, /MaxNumberOfMessagesPerSecond: REDRIVE_RATE_PER_SECOND/);
  assert.match(adminEnhancements, /window\.confirm/);
  assert.match(adminEnhancements, /Redrive all/);
  assert.match(adminEnhancements, /expectedVisible: count/);
});

test('runtime DLQ commands retain the same API-key authentication boundary', () => {
  assert.match(scoutsEntry, /command\.subject === 'dlq'/);
  assert.match(scoutsEntry, /\['inspect', 'redrive'\]/);
  assert.match(scoutsEntry, /getRequiredSecret\('REQUIRED_API_KEY_PARAMETER'\)/);
  assert.match(scoutsEntry, /constantTimeEquals\(getApiKey\(event\), requiredApiKey\)/);
});

test('Scouts role grants only the SQS operations needed for inspect and redrive', () => {
  assert.match(scoutsTemplate, /sqs:ReceiveMessage/);
  assert.match(scoutsTemplate, /sqs:DeleteMessage/);
  assert.match(scoutsTemplate, /sqs:StartMessageMoveTask/);
  assert.match(scoutsTemplate, /scoutsRequestsDLQ/);
  assert.match(scoutsTemplate, /scoutsProcessingDLQ/);
  assert.match(scoutsTemplate, /sqs:SendMessage[\s\S]*scoutsProcessing/);
  assert.doesNotMatch(scoutsTemplate, /arn:aws:sqs:[^\n]*:\*/);
});

test('normal status polling remains read-only and Auto Lambda heartbeat is retired', () => {
  assert.match(adminEnhancements, /setAutoLambdaInvocationEnabled\(false, true\)/);
  assert.match(adminEnhancements, /Auto Lambda heartbeat has been retired/);
  assert.match(adminEnhancements, /Status polling refreshes the canonical request lifecycle, queue counts and Step Functions status/);
  assert.match(adminEnhancements, /It does not invoke workers, create requests or process queues/);
  assert.match(adminEnhancements, /label\.append\(document\.createTextNode\(' Status polling'\)\)/);
});

test('DLQ message sampling happens only behind an explicit Inspect action', () => {
  assert.match(adminEnhancements, /Inspect messages/);
  assert.match(adminEnhancements, /subject: 'dlq',[\s\S]*action: 'inspect'/);
  assert.match(adminEnhancements, /maxMessages: 5/);
  assert.doesNotMatch(adminEnhancements, /setInterval\([^)]*inspectDlq/);
});

test('event cards expose Request Image only when image is absent and theme or prompt exists', () => {
  assert.match(adminEnhancements, /getImageThemeOrLegacyPrompt/);
  assert.match(adminEnhancements, /imageMissing: !imageUrl/);
  assert.match(adminEnhancements, /ready: Boolean\(hex && !imageUrl && imageThemeOrPrompt\)/);
  assert.match(adminEnhancements, /event-direct-image-request/);
  assert.match(adminEnhancements, /Request Image/);
  assert.match(adminEnhancements, /action: 'generateImage'/);
  assert.match(adminEnhancements, /subject: \{ hex: prerequisites\.hex \}/);
});

test('enhancement assets load after the canonical admin presentation layer', () => {
  assert.match(adminHtml, /admin-diagnostics-enhancements\.css/);
  assert.match(adminHtml, /admin-script\.js[\s\S]*admin-simplify\.js[\s\S]*admin-diagnostics-enhancements\.js/);
});
