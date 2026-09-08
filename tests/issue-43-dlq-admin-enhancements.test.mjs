import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const runtimeDlq = readFileSync('lambdas/scouts/function/runtime-dlq.mjs', 'utf8');
const runtimeSchedule = readFileSync('lambdas/scouts/function/runtime-schedule.mjs', 'utf8');
const scoutsEntry = readFileSync('lambdas/scouts/function/scouts-entry.mjs', 'utf8');
const scoutsTemplate = readFileSync('lambdas/cloudformation/templates/scouts.yaml', 'utf8');
const adminEnhancements = readFileSync('website/admin/admin-diagnostics-enhancements.js', 'utf8');
const adminHtml = readFileSync('website/admin/index.html', 'utf8');

function assertSyntax(path) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path} syntax failed: ${result.stderr || result.stdout}`);
}

test('new DLQ, schedule and browser enhancement modules are syntactically valid', () => {
  assertSyntax('lambdas/scouts/function/runtime-dlq.mjs');
  assertSyntax('lambdas/scouts/function/runtime-schedule.mjs');
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

test('runtime DLQ and schedule commands retain the same API-key authentication boundary', () => {
  assert.match(scoutsEntry, /command\.subject === 'dlq'/);
  assert.match(scoutsEntry, /\['inspect', 'redrive'\]/);
  assert.match(scoutsEntry, /command\.subject === 'schedule'/);
  assert.match(scoutsEntry, /\['status', 'enable', 'disable'\]/);
  assert.match(scoutsEntry, /getRequiredSecret\('REQUIRED_API_KEY_PARAMETER'\)/);
  assert.match(scoutsEntry, /constantTimeEquals\(getApiKey\(event\), requiredApiKey\)/);
});

test('Scouts role separates normal queue publishing from permissions required by SQS redrive', () => {
  assert.match(scoutsTemplate, /# Normal Scouts ingress publishes only to scoutsRequests\.[\s\S]*?sqs:SendMessage\n\s+Resource:\n\s+- !Ref ScoutsRequestsQueueArn/);
  assert.match(scoutsTemplate, /# StartMessageMoveTask requires Receive\/Delete\/GetAttributes on the[\s\S]*?sqs:ReceiveMessage[\s\S]*?sqs:DeleteMessage[\s\S]*?sqs:StartMessageMoveTask/);
  assert.match(scoutsTemplate, /sqs:StartMessageMoveTask[\s\S]*?Resource:\n\s+- !Sub arn:aws:sqs:\$\{AWS::Region\}:\$\{AWS::AccountId\}:scoutsRequestsDLQ\n\s+- !Sub arn:aws:sqs:\$\{AWS::Region\}:\$\{AWS::AccountId\}:scoutsProcessingDLQ/);
  assert.match(scoutsTemplate, /sqs:SendMessage\n\s+Resource:\n\s+- !Ref ScoutsRequestsQueueArn\n\s+- !Sub arn:aws:sqs:\$\{AWS::Region\}:\$\{AWS::AccountId\}:scoutsProcessing/);
  assert.doesNotMatch(scoutsTemplate, /arn:aws:sqs:[^\n]*:\*/);
});

test('EventBridge owns periodic calendar refresh and scheduled queue publication is fail-safe zero by default', () => {
  assert.match(scoutsTemplate, /ScheduledRefreshExpression:[\s\S]*Default: rate\(30 minutes\)/);
  assert.match(scoutsTemplate, /ScheduledRefreshMaxEvents:[\s\S]*Default: 0/);
  assert.match(scoutsTemplate, /ScoutsScheduledRefreshRule:\n\s+Type: AWS::Events::Rule/);
  assert.match(scoutsTemplate, /ScheduleExpression: !Ref ScheduledRefreshExpression/);
  assert.match(scoutsTemplate, /State: ENABLED/);
  assert.match(scoutsTemplate, /\"_scheduledRefresh\":true/);
  assert.match(scoutsTemplate, /\"subject\":\"calendars\"/);
  assert.match(scoutsTemplate, /\"action\":\"refreshAllCalendars\"/);
  assert.match(scoutsTemplate, /\"maxEvents\":\$\{ScheduledRefreshMaxEvents\}/);
  assert.match(scoutsTemplate, /Principal: events\.amazonaws\.com/);
});

test('scheduled refresh enablement is durable and fails closed before calendar work', () => {
  assert.match(runtimeSchedule, /runtime\/scheduledRefresh\.json/);
  assert.match(runtimeSchedule, /getScheduledRefreshSettings/);
  assert.match(runtimeSchedule, /setScheduledRefreshEnabled/);
  assert.match(runtimeSchedule, /PutObjectCommand/);
  assert.match(scoutsEntry, /isScheduledRefreshInvocation\(event\)/);
  assert.match(scoutsEntry, /if \(!schedule\.enabled\)/);
  assert.match(scoutsEntry, /schedule_state_unavailable/);
  assert.match(scoutsEntry, /return legacyHandler\(event\)/);
});

test('status polling remains read-only and browser Auto Lambda is replaced by AWS scheduled refresh', () => {
  assert.match(adminEnhancements, /setAutoLambdaInvocationEnabled\(false, true\)/);
  assert.match(adminEnhancements, /Scheduled refresh/);
  assert.match(adminEnhancements, /EventBridge scheduled calendar refresh/);
  assert.match(adminEnhancements, /Status polling refreshes the canonical request lifecycle, queue counts and Step Functions status/);
  assert.match(adminEnhancements, /It does not invoke workers, create requests or process queues/);
  assert.match(adminEnhancements, /label\.append\(document\.createTextNode\(' Status polling'\)\)/);
});

test('admin can enable, disable, inspect and manually run scheduled refresh', () => {
  assert.match(adminEnhancements, /subject: 'schedule', action: 'status'/);
  assert.match(adminEnhancements, /action: enabled \? 'enable' : 'disable'/);
  assert.match(adminEnhancements, /Run refresh now/);
  assert.match(adminEnhancements, /subject: 'calendars'/);
  assert.match(adminEnhancements, /action: 'refreshAllCalendars'/);
  assert.match(adminEnhancements, /calendar: 'all'/);
  assert.match(adminEnhancements, /maxEvents: 0/);
});

test('DLQ polling waits for API authentication instead of rendering startup failure noise', () => {
  assert.match(adminEnhancements, /async function refreshDlqOverview[\s\S]*if \(!apiAuthReady\)/);
  assert.match(adminEnhancements, /refreshOperationalStatusWhenReady/);
  assert.match(adminEnhancements, /if \(apiAuthReady\)[\s\S]*refreshDlqOverview\(false\)/);
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
