import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadFunctionsFromSource } from './helpers/source-function-loader.mjs';

const runtimeActivity = readFileSync('lambdas/scouts/function/runtime-activity.mjs', 'utf8');
const scoutsEntry = readFileSync('lambdas/scouts/function/scouts-entry.mjs', 'utf8');
const adminHtml = readFileSync('website/admin/index.html', 'utf8');
const activityCentre = readFileSync('website/admin/admin-activity-centre.js', 'utf8');
const approvalWorkflow = readFileSync('website/admin/admin-approval-workflow.js', 'utf8');
const privateStorage = readFileSync('website/admin/private-storage-client.js', 'utf8');
const diagnosticsEnhancements = readFileSync('website/admin/admin-diagnostics-enhancements.js', 'utf8');
const eventReview = readFileSync('lambdas/shared-layer/nodejs/event-review.mjs', 'utf8');
const approvalLifecycle = readFileSync('lambdas/sqs2scouts/function/approval-lifecycle-adapter.mjs', 'utf8');
const imageAdapter = readFileSync('lambdas/sqs2scouts/function/image-provider-adapter.mjs', 'utf8');
const imageWorker = readFileSync('lambdas/sqs2scouts/function/image-provider-worker.mjs', 'utf8');
const legacyNormalizer = readFileSync('lambdas/sqs2scouts/function/legacy-approval-card-normalizer.mjs', 'utf8');
const sqs2scoutsDeploy = readFileSync('lambdas/sqs2scouts/deploy.sh', 'utf8');
const slackProxy = readFileSync('lambdas/scouts-slack-handler/function/slack-handler-proxy.mjs', 'utf8');

function assertSyntax(path) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path} syntax check failed:\n${result.stderr}`);
}

test('issue 91 backend owns canonical user-facing workflow presentation', () => {
  assert.match(runtimeActivity, /function canonicalDisplay\(request = \{\}\)/);
  assert.match(runtimeActivity, /awaiting_review[\s\S]*Published — awaiting image approval/);
  assert.match(runtimeActivity, /awaiting_image[\s\S]*Generating image — final review required/);
  assert.match(runtimeActivity, /displayState/);
  assert.match(runtimeActivity, /displayMessage/);
  assert.match(runtimeActivity, /timeline[\s\S]*canonicalDisplay\(entry\)/);
});

test('issue 91 admin activity consumes canonical display state and refreshes reviewable publication', () => {
  assert.match(activityCentre, /request\?\.displayMessage/);
  assert.match(activityCentre, /request\.state === 'awaiting_review'/);
  assert.match(activityCentre, /request\.publication === 'published'/);
  assert.match(activityCentre, /await window\.loadEvents/);
  assert.match(activityCentre, /window\.updateModalContent\(\)/);
  assert.match(activityCentre, /const changed = \[\]/);
  assert.match(activityCentre, /await reconcileAgenda\(changed\)/);
  assert.match(activityCentre, /result\?\.rootRequestId \|\| result\?\.requestId/);
  assert.doesNotMatch(activityCentre, /request\.action \|\| 'change' ·/);
});

test('issue 91 activity reads bypass mutation wrappers and mutation tracking does not launch a duplicate immediate poll', () => {
  assert.match(activityCentre, /window\.sendScoutsReadCommand/);
  assert.match(activityCentre, /if \(requestId\) \{ tracked\.add\(requestId\); saveTracked\(\); \}/);
  assert.doesNotMatch(activityCentre, /saveTracked\(\); poll\(\);/);
  assert.match(privateStorage, /const readOnlySendScoutsCommand = sendScoutsCommand/);
  assert.match(privateStorage, /window\.sendScoutsReadCommand/);
});

test('issue 91 Admin consumes a server-issued canonical revision before approval', () => {
  assert.match(scoutsEntry, /buildEventReviewSnapshot/);
  assert.match(scoutsEntry, /\['get', 'review'\]\.includes\(command\.action\)/);
  assert.match(scoutsEntry, /review: buildEventReviewSnapshot\(eventObject\)/);
  assert.match(approvalWorkflow, /subject: 'event'/);
  assert.match(approvalWorkflow, /action: 'review'/);
  assert.match(approvalWorkflow, /window\.sendScoutsReadCommand/);
  assert.match(approvalWorkflow, /sameReviewableValues/);
  assert.match(approvalWorkflow, /baseRevision: reviewSnapshot\.revision/);
  assert.doesNotMatch(approvalWorkflow, /crypto\?\.subtle|sha256Prefix|TextEncoder/);
});

test('issue 91 read-only review preflight is bounded and stage-specific while approval submission stays authoritative', () => {
  assert.match(approvalWorkflow, /REVIEW_REQUEST_TIMEOUT_MS = 15000/);
  assert.match(approvalWorkflow, /withReadTimeout/);
  assert.match(approvalWorkflow, /REVIEW_TIMEOUT: canonical review did not respond within 15 seconds/);
  assert.match(approvalWorkflow, /let operationStage = 'canonical review'/);
  assert.match(approvalWorkflow, /operationStage = 'approval submission'/);
  assert.match(approvalWorkflow, /Approval failed during \$\{operationStage\}/);
});

test('issue 91 approval refuses an impossible image-generation request', () => {
  assert.match(eventReview, /!imageUrl && !imageTheme/);
  assert.match(eventReview, /requires an image theme before generation can start/);
});

test('issue 91 admin final generated-image review keeps the original root and uses specific copy', () => {
  assert.match(approvalWorkflow, /workflow\?\.state === 'awaiting_review'/);
  assert.match(approvalWorkflow, /workflow\?\.source === 'generated_image'/);
  assert.match(approvalWorkflow, /Approve generated image/);
  assert.match(approvalWorkflow, /rootRequestId: workflow\.rootRequestId/);
  assert.match(approvalWorkflow, /!result\?\.requiresGeneratedImage/);
  assert.match(approvalWorkflow, /Activity Centre owns that long-lived phase/);
});

test('issue 91 successful final approval updates the event entry, not the raw event object', () => {
  assert.match(approvalWorkflow, /applyLocalApprovalState\(entry, true\)/);
  assert.doesNotMatch(approvalWorkflow, /applyLocalApprovalState\(event, true\)/);
});

test('issue 91 approval labels are render-driven and idempotent without a document-wide observer', () => {
  assert.match(approvalWorkflow, /window\.renderEvents = relabelAfterRender/);
  assert.match(approvalWorkflow, /window\.openUploadModal = relabelAfterRender/);
  assert.doesNotMatch(approvalWorkflow, /new MutationObserver/);

  let label = 'Approve';
  let title = '';
  let labelWrites = 0;
  let titleWrites = 0;
  const button = {
    get textContent() { return label; },
    set textContent(value) { labelWrites += 1; label = value; },
    get title() { return title; },
    set title(value) { titleWrites += 1; title = value; },
  };
  const root = { querySelectorAll: () => [button] };
  const { functions } = loadFunctionsFromSource(approvalWorkflow, ['relabelApprovalButtons'], {
    isGeneratedImageReview: () => false,
    eventForApprovalButton: () => ({}),
  });

  functions.relabelApprovalButtons(root);
  functions.relabelApprovalButtons(root);
  assert.equal(label, 'Approve shown changes');
  assert.equal(labelWrites, 1, 'unchanged approval labels must not be rewritten');
  assert.equal(titleWrites, 1, 'unchanged approval titles must not be rewritten');
});

test('issue 91 approval acceptance is not blocked by a secondary activity refresh', () => {
  assert.match(approvalWorkflow, /void Promise\.resolve\(pollQueueDepthSnapshots/);
  assert.doesNotMatch(approvalWorkflow, /await pollQueueDepthSnapshots\(\{ updatePanels: true \}\)/);
});

test('issue 91 approval controller loads statically in dependency order and fails closed', () => {
  const privateStorageIndex = adminHtml.indexOf('<script src="private-storage-client.js"></script>');
  const approvalIndex = adminHtml.indexOf('<script src="admin-approval-workflow.js"');
  const simplifyIndex = adminHtml.indexOf('<script src="admin-simplify.js"></script>');
  assert.ok(privateStorageIndex >= 0 && approvalIndex > privateStorageIndex);
  assert.ok(simplifyIndex > approvalIndex);
  assert.match(adminHtml, /onerror="window\.handleApprovalWorkflowLoadError\?\.\(\)"/);
  assert.match(privateStorage, /approvalBootstrapGuard/);
  assert.match(privateStorage, /handleApprovalWorkflowLoadError/);
  assert.match(approvalWorkflow, /window\.scoutsApprovalWorkflowReady = true/);
  assert.doesNotMatch(privateStorage, /createElement\('script'\)/);
});

test('admin direct-image controls are render-driven and cannot self-trigger a child-list observer', () => {
  assert.match(diagnosticsEnhancements, /function installEventCardRenderHook/);
  assert.match(diagnosticsEnhancements, /window\.renderEvents = diagnosticsAwareRender/);
  assert.doesNotMatch(diagnosticsEnhancements, /new MutationObserver/);
  assert.match(diagnosticsEnhancements, /existing\.textContent !== desiredLabel/);
  assert.match(diagnosticsEnhancements, /void Promise\.resolve\(pollQueueDepthSnapshots\(\)\)/);
  assert.doesNotMatch(diagnosticsEnhancements, /await pollQueueDepthSnapshots\(\)/);
});

test('issue 91 generated review notification has durable external identity and Slack reference', () => {
  const identity = imageWorker.indexOf('ensureReviewNotificationIdentity');
  const send = imageWorker.indexOf('await sendSlackMessage(message.text, message.blocks', identity);
  assert.ok(identity >= 0, 'generated review identity must be prepared');
  assert.ok(send > identity, 'notification identity must be prepared before Slack send');
  assert.match(imageWorker, /client_msg_id: clientMsgId/);
  assert.match(imageWorker, /notificationClientMsgId/);
  assert.match(imageWorker, /notificationChannel: channel/);
  assert.match(imageWorker, /notificationTs: ts/);
  assert.match(imageWorker, /REVIEW_NOTIFICATION_MARKER_RETRIES/);
});

test('issue 91 Slack review references are scoped to one root operation', () => {
  assert.match(approvalLifecycle, /function generatedReviewReference\(event, rootRequestId = null\)/);
  assert.match(approvalLifecycle, /text\(workflow\.rootRequestId\) !== expectedRoot/);
  assert.match(approvalLifecycle, /const sameRoot = text\(previous\.rootRequestId\) === rootRequestId/);
  assert.match(approvalLifecycle, /\.\.\.\(sameRoot \? previous : \{\}\)/);
  assert.match(approvalLifecycle, /generatedReviewReference\(event, message\?\.rootRequestId\)/);
});

test('issue 91 final approval waits for an in-flight generated-review Slack reference', () => {
  assert.match(approvalLifecycle, /function finalApprovalNotificationReferencePending/);
  assert.match(approvalLifecycle, /notificationClientMsgId/);
  assert.match(approvalLifecycle, /notificationChannel/);
  assert.match(approvalLifecycle, /notificationTs/);
  assert.match(approvalLifecycle, /ApprovalReviewNotificationPending/);
  assert.match(approvalLifecycle, /Deferring final approval until generated-review Slack reference is durable/);
});

test('issue 91 final approval reconciles both stored and generated-image Slack cards', () => {
  assert.match(approvalLifecycle, /notificationChannel/);
  assert.match(approvalLifecycle, /notificationTs/);
  assert.match(approvalLifecycle, /for \(const reference of \[generatedMetadata, directMetadata\]\)/);
  assert.match(approvalLifecycle, /seen\.has\(key\)/);
});

test('issue 91 reachable legacy reviews use bounded reference-only Slack actions', () => {
  assert.match(imageAdapter, /normalizeLegacyApprovalCards/);
  assert.match(imageAdapter, /await normalizeLegacyApprovalCards\(delegated\)/);
  assert.match(legacyNormalizer, /text: \{ type: 'plain_text', text: 'Approve shown changes'/);
  assert.match(legacyNormalizer, /event: \{ hex: review\.hex \}/);
  assert.match(legacyNormalizer, /reviewReference: true/);
  assert.match(legacyNormalizer, /value\.length > 2000/);
  assert.doesNotMatch(legacyNormalizer, /scouts_request_edit|scouts_request_skip|scouts_request_hide/);
  assert.match(slackProxy, /async function hydrateApprovalEvent/);
  assert.match(slackProxy, /new GetObjectCommand\(\{ Bucket: TARGET_BUCKET, Key: `events\/\$\{hex\}\.json` \}\)/);
  assert.match(slackProxy, /const approvalEvent = await hydrateApprovalEvent\(event, meta\)/);
  assert.match(sqs2scoutsDeploy, /legacy-approval-card-normalizer\.mjs/);
});

test('issue 91 Slack labels generated review only when the action explicitly identifies it', () => {
  assert.match(slackProxy, /generatedReview = meta\?\.action === 'approve_generated_image'/);
  assert.match(slackProxy, /generatedReview \? 'Approve generated image' : 'Approve shown changes'/);
  assert.match(slackProxy, /action: generatedReview \? 'approve_generated_image' : 'approve_shown_changes'/);
  assert.doesNotMatch(slackProxy, /text: \{ type: 'plain_text', text: imageUrl \? 'Approve generated image'/);
});

test('issue 91 presentation and closure files remain syntactically valid', () => {
  for (const path of [
    'lambdas/scouts/function/runtime-activity.mjs',
    'lambdas/scouts/function/scouts-entry.mjs',
    'website/admin/admin-activity-centre.js',
    'website/admin/admin-approval-workflow.js',
    'website/admin/private-storage-client.js',
    'website/admin/admin-diagnostics-enhancements.js',
    'lambdas/shared-layer/nodejs/event-review.mjs',
    'lambdas/sqs2scouts/function/approval-lifecycle-adapter.mjs',
    'lambdas/sqs2scouts/function/image-provider-adapter.mjs',
    'lambdas/sqs2scouts/function/image-provider-worker.mjs',
    'lambdas/sqs2scouts/function/legacy-approval-card-normalizer.mjs',
    'lambdas/scouts-slack-handler/function/slack-handler-proxy.mjs',
  ]) assertSyntax(path);
});
