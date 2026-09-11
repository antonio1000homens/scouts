#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import './test-cloudflare-image-client.mjs';
import './test-agenda-publisher.mjs';
import './test-deployment-artifact.mjs';
import '../../../../tests/issue-18-cloudflare-image.integration.test.mjs';
import {
  buildApprovedSnapshotPatch,
  buildEventReviewSnapshot,
  compareEventReviewRevision,
} from '../../../shared-layer/nodejs/event-review.mjs';
import { buildCanonicalActivity } from '../../../shared-layer/nodejs/runtime-activity-model.mjs';
import {
  normaliseStage,
  isFullEnrichMessage,
  normaliseImageProvider,
  nextUtcDay,
  classifyCloudflareError,
  buildCallbackResultFromState,
  buildImageGenerationPrompt,
} from '../full-enrich-helpers.mjs';

const requestRouter = readFileSync('lambdas/scouts2sqs/function/request-router.mjs', 'utf8');
const scoutsTemplate = readFileSync('lambdas/cloudformation/templates/scouts.yaml', 'utf8');
const scouts2sqsTemplate = readFileSync('lambdas/cloudformation/templates/scouts2sqs.yaml', 'utf8');
const slackTemplate = readFileSync('lambdas/cloudformation/templates/slack-handler.yaml', 'utf8');
const scoutsDeploy = readFileSync('lambdas/scouts/deploy.sh', 'utf8');
const scouts2sqsDeploy = readFileSync('lambdas/scouts2sqs/deploy.sh', 'utf8');
const sqs2scoutsDeploy = readFileSync('lambdas/sqs2scouts/deploy.sh', 'utf8');
const runtimeActivity = readFileSync('lambdas/scouts/function/runtime-activity.mjs', 'utf8');
const persistenceProcessor = readFileSync('lambdas/sqs2scouts/function/persistence-processor.mjs', 'utf8');
const imageProviderAdapter = readFileSync('lambdas/sqs2scouts/function/image-provider-adapter.mjs', 'utf8');
const approvalLifecycleAdapter = readFileSync('lambdas/sqs2scouts/function/approval-lifecycle-adapter.mjs', 'utf8');
const approvalCoordinator = readFileSync('lambdas/shared-layer/nodejs/approval-coordinator.mjs', 'utf8');
const slackProxy = readFileSync('lambdas/scouts-slack-handler/function/slack-handler-proxy.mjs', 'utf8');

test('normaliseStage maps external imageUrl to logical image', () => {
  assert.equal(normaliseStage('tagline'), 'tagline');
  assert.equal(normaliseStage('imageTheme'), 'imageTheme');
  assert.equal(normaliseStage('imageUrl'), 'image');
  assert.equal(normaliseStage('image'), 'image');
  assert.equal(normaliseStage('other'), null);
});

test('isFullEnrichMessage requires callback token and fullEnrich contract', () => {
  assert.equal(isFullEnrichMessage({ orchestrationType: 'fullEnrich', orchestrationStep: 'image', taskToken: 'token' }), true);
  assert.equal(isFullEnrichMessage({ orchestrationType: 'imageEnrich', orchestrationStep: 'image', taskToken: 'token' }), false);
  assert.equal(isFullEnrichMessage({ orchestrationType: 'fullEnrich', orchestrationStep: 'image' }), false);
});

test('image provider normalization has no automatic fallback', () => {
  assert.equal(normaliseImageProvider('cloudflare'), 'cloudflare');
  assert.equal(normaliseImageProvider('GEMINI'), 'gemini');
  assert.equal(normaliseImageProvider('invalid'), null);
});

test('nextUtcDay returns the next UTC midnight', () => {
  assert.equal(nextUtcDay(new Date('2026-09-07T23:59:00Z')), '2026-09-08T00:00:00.000Z');
});

test('Cloudflare errors map to quota, retryable, and deterministic categories', () => {
  assert.equal(classifyCloudflareError({ providerCode: 3036, message: 'daily allocation exhausted' }), 'PROVIDER_QUOTA');
  assert.equal(classifyCloudflareError({ providerCode: 3040, status: 429, message: 'capacity' }), 'RATE_LIMIT');
  assert.equal(classifyCloudflareError({ providerCode: 5035, status: 403, message: 'paid plan required' }), 'MODEL_CONFIGURATION');
  assert.equal(classifyCloudflareError({ providerCode: 5007, status: 400, message: 'no such model' }), 'MODEL_CONFIGURATION');
  assert.equal(classifyCloudflareError({ providerCode: 3042, status: 404, message: 'invalid model' }), 'MODEL_CONFIGURATION');
  assert.equal(classifyCloudflareError({ providerCode: 3007, status: 408, message: 'request timeout' }), 'NETWORK_TIMEOUT');
  assert.equal(classifyCloudflareError({ providerCode: 3008, status: 408, message: 'aborted' }), 'NETWORK_TIMEOUT');
  assert.equal(classifyCloudflareError({ status: 400, message: 'invalid request' }), 'INVALID_EVENT_DATA');
  assert.equal(classifyCloudflareError({ status: 503, message: 'unavailable' }), 'PROVIDER_5XX');
});

test('callback result exposes retry and manual-review state explicitly', () => {
  const retry = buildCallbackResultFromState({
    state: { state: 'retry_wait', attemptCount: 2, nextRetryAt: '2026-09-08T10:00:00Z', lastErrorType: 'RATE_LIMIT' },
    stage: 'image',
    hex: 'abcd',
    provider: 'cloudflare',
    generationId: 'gen',
  });
  assert.equal(retry.status, 'retry_wait');
  assert.equal(retry.attemptCount, 2);
  assert.equal(retry.failureCategory, 'RATE_LIMIT');

  const manual = buildCallbackResultFromState({
    state: { state: 'manual_review', attemptCount: 3, lastErrorType: 'AUTH_FAILURE' },
    stage: 'image',
    hex: 'abcd',
    provider: 'cloudflare',
  });
  assert.equal(manual.status, 'manual_review');
  assert.equal(manual.failureCategory, 'AUTH_FAILURE');
});

test('in-progress duplicate keeps callback ownership with the reserved delivery', () => {
  const result = buildCallbackResultFromState({
    state: { state: 'in_progress', attemptCount: 1, generationId: 'gen' },
    stage: 'image',
    hex: 'abcd',
    provider: 'cloudflare',
  });
  assert.equal(result.status, 'duplicate_in_progress');
  assert.equal(result.reason, 'stage_reservation_owned_elsewhere');
});

test('persistence pending returns deferred so Step Functions does not regenerate', () => {
  const result = buildCallbackResultFromState({
    state: { state: 'persist_pending', attemptCount: 1, generationId: 'gen' },
    stage: 'image',
    hex: 'abcd',
    provider: 'gemini',
  });
  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, 'persistence_pending');
});

test('image prompt uses the same scouts.conf placeholders', () => {
  assert.equal(buildImageGenerationPrompt('campfire', {
    imageGenerationPromptTemplate: 'Draw {{IMAGE_THEME}}. {{IMAGE_PROMPT_SPECIFICATIONS}}',
    imageGenerationPromptSpecifications: ['16:9', 'no text'],
  }), 'Draw campfire. 16:9, no text');
});

test('full-enrich preserves the ingress request ID separately from execution name', () => {
  assert.match(requestRouter, /requestId: text\(message\?\.requestId\) \|\| name \|\| executionName\(prefix\)/);
  assert.match(requestRouter, /executionName: name \|\| null/);
  assert.match(requestRouter, /const finalInput = \{ \.\.\.input, executionName: name \}/);
  assert.doesNotMatch(requestRouter, /const finalInput = \{ \.\.\.input, requestId: name \}/);
});

test('issue 91 root correlation is carried through full-enrich and persist contracts', () => {
  assert.match(requestRouter, /rootRequestId: rootRequestIdOf\(message, requestId\)/);
  assert.match(requestRouter, /rootRequestId: rootRequestIdOf\(message, input\.requestId\)/);
  assert.match(requestRouter, /rootRequestId: translated\.rootRequestId \|\| null/);
  assert.match(requestRouter, /rootRequestId: payload\.rootRequestId \|\| null/);
});

test('issue 91 review revision rejects stale state and missing-image approval stays pending', () => {
  const canonical = {
    uid: 'osm-123',
    title: 'Campfire night',
    metadata: {
      hex: 'abcd',
      tagline: 'Join us by the fire',
      image: { theme: 'campfire at dusk', url: null },
      status: { isHidden: false, isApproved: false },
    },
  };
  const snapshot = buildEventReviewSnapshot(canonical);
  const changed = {
    ...canonical,
    metadata: { ...canonical.metadata, tagline: 'Changed elsewhere' },
  };
  assert.equal(compareEventReviewRevision(changed, snapshot.revision).ok, false);

  const patch = buildApprovedSnapshotPatch(snapshot);
  assert.equal(patch.metadata.status.isApproved, false);
  assert.equal(patch.approval.nextState, 'awaiting_image');
  assert.equal(patch.approval.requiresGeneratedImage, true);
  assert.equal(patch.approval.requiresFinalImageReview, true);
});

test('issue 91 root-correlated child requests collapse without merging separate same-HEX operations', () => {
  const request = (requestId, rootRequestId) => ({
    requestId,
    messageId: `${requestId}-message`,
    rootRequestId,
    hex: 'abcd',
    title: 'Campfire night',
    requestTime: '2026-09-11T20:00:00.000Z',
  });
  const grouped = buildCanonicalActivity({
    queuedSnapshot: { requests: [request('approval', 'root-a')] },
    processingSnapshot: { requests: [{ ...request('image-child', 'root-a'), status: 'awaiting_image' }] },
    now: new Date('2026-09-11T20:01:00.000Z'),
  });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].rootRequestId, 'root-a');
  assert.equal(grouped[0].state, 'awaiting_image');
  assert.deepEqual(grouped[0].childRequestIds.sort(), ['approval', 'image-child']);

  const separate = buildCanonicalActivity({
    queuedSnapshot: { requests: [request('approval-a', 'root-a'), request('approval-b', 'root-b')] },
    now: new Date('2026-09-11T20:01:00.000Z'),
  });
  assert.equal(separate.length, 2);
});

test('issue 91 second slice uses one idempotent coordinator for admin and Slack', () => {
  assert.match(approvalCoordinator, /IDEMPOTENCY_PREFIX = 'runtime\/approval-idempotency\/'/);
  assert.match(approvalCoordinator, /IfNoneMatch: options\.ifNoneMatch/);
  assert.match(approvalCoordinator, /CLAIM_TAKEOVER_MS = 30_000/);
  assert.match(approvalCoordinator, /reused: true/);
  assert.match(approvalCoordinator, /const imageRequestId = `\$\{root\}:image:\$\{revision\}`/);
  assert.match(slackProxy, /coordinateEventApproval/);
  assert.match(slackProxy, /view_submission/);
  assert.match(slackProxy, /baseRevision: baseSnapshot\.revision/);
  assert.match(slackProxy, /statusCode === 409/);
  assert.match(slackProxy, /Review changed — refreshed/);
});

test('issue 91 generated image persistence is concurrency guarded and requires final review', () => {
  assert.match(imageProviderAdapter, /function approvalContext\(message\)/);
  assert.match(imageProviderAdapter, /IfMatch: text\(options\.ifMatch\)/);
  assert.match(imageProviderAdapter, /manual_image_superseded_generation/);
  assert.match(imageProviderAdapter, /state: 'awaiting_review'/);
  assert.match(imageProviderAdapter, /Approve generated image/);
  assert.match(imageProviderAdapter, /realm: 'approvalReview'/);
  assert.match(imageProviderAdapter, /review_notification_pending/);
  assert.match(imageProviderAdapter, /approval_persist_pending/);
});

test('issue 91 revisioned persistence bypasses legacy auto-approval and completes only the root', () => {
  assert.match(approvalLifecycleAdapter, /isRevisionedApprovalPersist/);
  assert.match(approvalLifecycleAdapter, /currentReview\.revision !== baseRevision/);
  assert.match(approvalLifecycleAdapter, /IfMatch: text\(eTag\)/);
  assert.match(approvalLifecycleAdapter, /approvalState === 'approved' \? 'completed' : 'awaiting_image'/);
  assert.match(approvalLifecycleAdapter, /await publishEvent\(hex, accepted\)/);
  assert.match(sqs2scoutsDeploy, /HANDLER="\$\{HANDLER:-approval-lifecycle-adapter\.lambdaHandler\}"/);
  assert.match(sqs2scoutsDeploy, /approval-lifecycle-adapter\.mjs/);
});

test('issue 91 root activity remains authoritative over child terminal states', () => {
  assert.match(runtimeActivity, /isExplicitRootRow/);
  assert.match(runtimeActivity, /existing\._hasExplicitRootRow && !incomingIsRoot/);
  assert.match(runtimeActivity, /_hasExplicitRootRow: existing\._hasExplicitRootRow \|\| incomingIsRoot/);
});

test('issue 91 least privilege allows only required approval retries and Slack canonical reads', () => {
  assert.match(scouts2sqsTemplate, /sqs:SendMessage[\s\S]*?- !Ref QueueArn[\s\S]*?- !Ref ScoutsDecisionQueueArn/);
  assert.match(slackTemplate, /s3:GetObject[\s\S]*?\/events\/\*/);
  assert.match(slackTemplate, /runtime\/approval-idempotency\/\*/);
  assert.match(slackTemplate, /s3:PutObject[\s\S]*?runtime\/approval-idempotency\/\*/);
});

test('historical imageEnrich action is only a compatibility alias into full-enrich', () => {
  assert.match(requestRouter, /new Set\(\['new', 'retry', 'imageEnrich', 'fullEnrich'\]\)/);
  assert.match(requestRouter, /stateMachineArn: FULL_ENRICH_STATE_MACHINE_ARN/);
  assert.doesNotMatch(requestRouter, /IMAGE_ENRICH_STATE_MACHINE_ARN/);
});

test('active deployments contain only the canonical full-enrich state machine', () => {
  for (const source of [scoutsTemplate, scouts2sqsTemplate, scoutsDeploy, scouts2sqsDeploy, runtimeActivity]) {
    assert.doesNotMatch(source, /IMAGE_ENRICH_STATE_MACHINE_ARN/);
    assert.doesNotMatch(source, /ImageEnrichStateMachineArn/);
  }
  assert.match(scoutsTemplate, /FullEnrichStateMachineArn/);
  assert.match(scoutsTemplate, /FULL_ENRICH_STATE_MACHINE_ARN/);
  assert.match(scouts2sqsTemplate, /FullEnrichStateMachineArn/);
  assert.match(scoutsDeploy, /scouts-full-enrich/);
  assert.match(scouts2sqsDeploy, /scouts-full-enrich/);
  assert.match(scouts2sqsDeploy, /HANDLER="\$\{HANDLER:-request-router\.lambdaHandler\}"/);
  assert.equal(existsSync('lambdas/cloudformation/templates/scouts-image-enrich.yaml'), false);
});

test('retired image-enrich deployment artifacts stay removed after cutover', () => {
  assert.equal(existsSync('lambdas/scouts-image-enrich/deploy.sh'), false);
  assert.equal(existsSync('lambdas/scouts-image-enrich/decommission.sh'), false);
  assert.equal(existsSync('lambdas/cloudformation/templates/scouts-image-enrich.yaml'), false);
});

test('Scouts status deployment uses full-enrich activity entrypoint and least privilege', () => {
  assert.match(scoutsTemplate, /Default: scouts-entry\.handler/);
  assert.match(scoutsTemplate, /states:DescribeExecution/);
  assert.match(scoutsTemplate, /states:GetExecutionHistory/);
  assert.equal(scoutsTemplate.includes('execution:*:*'), false);
  assert.equal((scoutsTemplate.match(/execution:\$\{FullEnrichStateMachineName\}:\*/g) || []).length, 1);
  assert.match(scoutsTemplate, /FullEnrichStateMachineName: !Select \[6, !Split \[':', !Ref FullEnrichStateMachineArn\]\]/);
  assert.match(scoutsDeploy, /scouts-entry\.handler/);
  assert.match(scoutsDeploy, /scouts-entry\.mjs[\s\\]+(?:agenda-hex-repair\.mjs[\s\\]+)?runtime-activity\.mjs/);
});

test('activity status reads the durable request ledger rather than rotating snapshots', () => {
  assert.match(runtimeActivity, /listRequestActivity/);
  assert.match(runtimeActivity, /request-activity-ledger/);
  assert.match(runtimeActivity, /nextCursor/);
  assert.doesNotMatch(runtimeActivity, /scoutsProcessing\.json/);
  assert.doesNotMatch(runtimeActivity, /scoutsComplete\.json/);
});

test('all direct enrichment persistence paths publish their canonical HEX event before completion', () => {
  assert.match(sqs2scoutsDeploy, /agenda-publisher\.mjs/);
  assert.match(persistenceProcessor, /await saveHexEventToS3\(hexValue, hexData\);\s*await publishHexEventToAgenda\(hexValue, hexData\);/);
  assert.match(persistenceProcessor, /await saveHexEventToS3\(hexValue, event\);\s*await publishHexEventToAgenda\(hexValue, event\);/);
  assert.match(persistenceProcessor, /orchestrationStep: 'tagline'/);
  assert.match(persistenceProcessor, /orchestrationStep: 'imageTheme'/);
  assert.match(imageProviderAdapter, /await saveEvent\(hex, event\);\s*await publishEvent\(hex, event\);/);
});
