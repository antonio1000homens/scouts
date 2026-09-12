import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadFunctionsFromSource } from './helpers/source-function-loader.mjs';

const runtimeActivity = readFileSync('lambdas/scouts/function/runtime-activity.mjs', 'utf8');
const scoutsEntry = readFileSync('lambdas/scouts/function/scouts-entry.mjs', 'utf8');
const activityCentre = readFileSync('website/admin/admin-activity-centre.js', 'utf8');
const approvalWorkflow = readFileSync('website/admin/admin-approval-workflow.js', 'utf8');
const privateStorage = readFileSync('website/admin/private-storage-client.js', 'utf8');
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

test('issue 91 Admin consumes a server-issued canonical revision before approval', () => {
  assert.match(scoutsEntry, /buildEventReviewSnapshot/);
  assert.match(scoutsEntry, /\['get', 'review'\]\.includes\(command\.action\)/);
  assert.match(scoutsEntry, /review: buildEventReviewSnapshot\(eventObject\)/);
  assert.match(approvalWorkflow, /subject: 'event'/);
  assert.match(approvalWorkflow, /action: 'review'/);
  assert.match(approvalWorkflow, /sameReviewableValues/);
  assert.match(approvalWorkflow, /baseRevision: reviewSnapshot\.revision/);
  assert.doesNotMatch(approvalWorkflow, /crypto\?\.subtle|sha256Prefix|TextEncoder/);
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

test('issue 91 approval controller bootstrap is ordered and observable', () => {
  assert.match(privateStorage, /script\.async = false/);
  assert.match(privateStorage, /scoutsApprovalWorkflowReady = true/);
  assert.match(privateStorage, /Approval controls failed to load/);
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
    'lambdas/shared-layer/nodejs/event-review.mjs',
    'lambdas/sqs2scouts/function/approval-lifecycle-adapter.mjs',
    'lambdas/sqs2scouts/function/image-provider-adapter.mjs',
    'lambdas/sqs2scouts/function/image-provider-worker.mjs',
    'lambdas/sqs2scouts/function/legacy-approval-card-normalizer.mjs',
    'lambdas/scouts-slack-handler/function/slack-handler-proxy.mjs',
  ]) assertSyntax(path);
});
