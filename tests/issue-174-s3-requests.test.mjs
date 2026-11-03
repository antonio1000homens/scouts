import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createImageHeadMemo } from '../lambdas/scouts/function/image-head-memo.mjs';
import {
  buildImageEnrichRuntimeStageIndex,
  findImageEnrichRuntimeStage,
} from '../lambdas/scouts/function/runtime-activity-index.mjs';

const source = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('image HEAD checks are shared across duplicate events in one invocation', async () => {
  const memo = createImageHeadMemo();
  let checks = 0;
  const check = async () => {
    checks += 1;
    return true;
  };
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    memo('website-bucket', 'website/eventImages/shared.jpg', check)));
  assert.deepEqual(results, Array(20).fill(true));
  assert.equal(checks, 1, 'only one real HEAD for concurrent or repeated references');
  await memo('website-bucket', 'website/eventImages/other.jpg', check);
  await memo('other-bucket', 'website/eventImages/shared.jpg', check);
  assert.equal(checks, 3, 'cache keys must include both bucket and object');
  assert.deepEqual(memo.stats(), { requests: 3, cacheHits: 19 });
});

test('missing object is cached for this invocation but rechecked on the next', async () => {
  let checks = 0;
  const check = async () => { checks += 1; return false; };
  const first = createImageHeadMemo();
  assert.equal(await first('bucket', 'missing.jpg', check), false);
  assert.equal(await first('bucket', 'missing.jpg', check), false);
  assert.equal(checks, 1);
  assert.equal(await createImageHeadMemo()('bucket', 'missing.jpg', check), false);
  assert.equal(checks, 2, 'deleted or restored files must be reevaluated on later refreshes');
});

test('transient HEAD failures are evicted and can be retried', async () => {
  const memo = createImageHeadMemo();
  let attempts = 0;
  const check = () => {
    attempts += 1;
    if (attempts === 1) throw new Error('SlowDown');
    return true;
  };
  await assert.rejects(memo('bucket', 'image.jpg', check), /SlowDown/);
  assert.equal(await memo('bucket', 'image.jpg', check), true);
  assert.equal(attempts, 2);
});

test('Scouts image verification shares the per-invocation HEAD cache without masking AWS errors', () => {
  const scouts = source('../lambdas/scouts/function/scouts-service.mjs');
  assert.match(scouts, /const imageHeadMemo = createImageHeadMemo\(\)/);
  assert.match(scouts, /verifyAndRepairEventImages\(enrichedAgenda, bucket, imageHeadMemo\)/);
  assert.match(scouts, /verifyAndRepairHexFile\(bucket, key, hexData, imageHeadMemo\)/);
  assert.match(scouts, /imageHeadMemo\(bucket, key, check\)/);
  assert.match(scouts, /Number\(error\?\.\$metadata\?\.httpStatusCode\) === 404/);
  assert.match(scouts, /throw error;/);
  assert.match(scouts, /migrateLegacyImageIfNeeded\(bucket, currentUrl\)/);
  assert.match(scouts, /const hexReadCache = new Map\(\)/);
  assert.match(scouts, /hexReadCache\.size < MAX_HEX_READ_CACHE_ENTRIES/);
  assert.match(scouts, /hexReadCache\?\.delete\(key\)/);
  assert.match(scouts, /const cachedHex = hexReadCache\.get\(key\)/);
  assert.match(scouts, /reusedHexReads/);
  assert.match(scouts, /imageHead: imageHeadMemo\.stats\(\)/);
  assert.match(scouts, /runWithS3RequestMetrics\(s3RequestSource\(event\)/);
  assert.doesNotMatch(scouts, /s3\.send\(/);
  const s3Metrics = source('../lambdas/scouts/function/s3-request-metrics.mjs');
  assert.match(s3Metrics, /\[S3 Request Reduction\] SDK calls by operation/);
  assert.match(s3Metrics, /runWithS3RequestMetrics/);
  assert.match(s3Metrics, /command\?\.constructor\?\.name/);
  assert.doesNotMatch(s3Metrics, /Key:|Bucket:/);
});

test('active Step Functions stage metadata comes from bounded activity rows, not stale S3 snapshots', () => {
  const index = buildImageEnrichRuntimeStageIndex([
    { requestId: 'root-1', rootRequestId: 'root-1', hex: 'aa', state: 'orchestrating', stage: 'full_enrich', updatedAt: '2026-11-03T10:00:00Z' },
    { requestId: 'child-1', rootRequestId: 'root-1', hex: 'aa', state: 'processing', stage: 'tagline', updatedAt: '2026-11-03T10:01:00Z' },
    { requestId: 'child-2', rootRequestId: 'root-1', hex: 'aa', state: 'processing', stage: 'imageTheme', updatedAt: '2026-11-03T10:02:00Z' },
    { requestId: 'old-review', rootRequestId: 'old-review', hex: 'bb', state: 'manual_review', stage: 'image', updatedAt: '2026-11-03T10:03:00Z' },
    { requestId: 'stale', rootRequestId: 'stale', hex: 'ee', state: 'processing', stage: 'image', updatedAt: '2026-11-03T09:00:00Z' },
    { requestId: 'unrelated', rootRequestId: 'unrelated', hex: 'cc', state: 'processing', stage: 'scouts2sqs', updatedAt: '2026-11-03T10:04:00Z' },
  ]);
  assert.equal(findImageEnrichRuntimeStage(index, { requestId: 'root-1', rootRequestId: 'root-1' }).currentStage, 'imageTheme');
  assert.equal(findImageEnrichRuntimeStage(index, { hex: 'bb' }), null, 'terminal manual review is not presented as active');
  assert.equal(findImageEnrichRuntimeStage(index, { hex: 'dd' }), null, 'a missing activity row does not invent an execution stage');
  assert.equal(findImageEnrichRuntimeStage(index, { requestId: 'stale' }, '2026-11-03T10:00:00Z'), null, 'activity predating an execution cannot supply its current stage');
  assert.equal(findImageEnrichRuntimeStage(buildImageEnrichRuntimeStageIndex([]), { requestId: 'legacy-no-row', hex: 'aa' }), null);
});

test('S3 lifecycle snapshot cutover is opt-in until parity is verified, with a rollback path', () => {
  const scouts = source('../lambdas/scouts/function/scouts-service.mjs');
  assert.doesNotMatch(scouts, /touchQueuedRuntimeSnapshot/);
  assert.doesNotMatch(scouts, /appendQueuedRuntimeSnapshot/);
  assert.match(scouts, /LEGACY_RUNTIME_SNAPSHOTS_ENABLED\s*\? await readLegacyRuntimeQueueSnapshots\(bucket\)\s*:\s*null/);
  assert.match(scouts, /if \(Array\.isArray\(response\?\.executions\) && response\.executions\.length > 0\) \{[\s\S]*?listRequestActivity\(\{ activeOnly: true, limit: 100 \}\)/);
  assert.match(scouts, /findImageEnrichRuntimeStage\(runtimeStageIndex, executionInput, execution\?\.startDate\)/);
  assert.doesNotMatch(scouts, /buildActiveProcessingIndex/);
  assert.doesNotMatch(scouts, /mergeProcessingSnapshotIntoIndex/);
  const entry = source('../lambdas/scouts/function/scouts-entry.mjs');
  assert.match(entry, /command\.subject === 'snapshot'/);
  assert.match(entry, /status: 'retired'/);
  assert.match(entry, /getRuntimeQueueStatus/);
  assert.match(entry, /'x-scheduled-refresh': 'true'/);
  assert.match(entry, /runWithS3RequestMetrics\(source/);
  assert.match(entry, /command\.subject === 'queues' && command\.action === 'status'/);
  assert.match(entry, /command\.subject === 'activity'/);
  for (const path of [
    '../lambdas/scouts2sqs/function/request-processor.mjs',
    '../lambdas/sqs2scouts/function/persistence-processor.mjs',
  ]) {
    const worker = source(path);
    assert.doesNotMatch(worker, /scoutsQueued\.json|scoutsProcessing\.json|scoutsComplete\.json/);
    assert.doesNotMatch(worker, /persist(?:Queued|Completed)RequestsRuntimeSnapshot/);
  }
  const admin = source('../website/admin/index.html');
  assert.match(admin, /Legacy Runtime Queued/);
  assert.match(admin, /Use the Activity Centre and Operations views/);
  const adminOperations = source('../website/admin/admin-diagnostics-enhancements.js');
  assert.match(adminOperations, /subject: 'queues', action: 'status'/);
  assert.match(adminOperations, /Live queue depth/);
  assert.match(adminOperations, /Oldest message age/);
  const queueStatus = source('../lambdas/scouts/function/runtime-dlq.mjs');
  assert.match(queueStatus, /export async function getRuntimeQueueStatus/);
  assert.match(queueStatus, /sqs:GetQueueAttributes/);
  assert.match(queueStatus, /ApproximateAgeOfOldestMessage/);
  assert.doesNotMatch(queueStatus.slice(queueStatus.indexOf('export async function getRuntimeQueueStatus'), queueStatus.indexOf('export async function inspectRuntimeDlq')), /ReceiveMessageCommand/);
  for (const path of [
    '../lambdas/scouts/function/agenda-hex-repair.mjs',
    '../lambdas/scouts/function/runtime-schedule.mjs',
  ]) {
    assert.match(source(path), /sendS3Command\(s3,/);
  }
});

test('low-frequency schedule is configurable and the previous cadence can be restored', () => {
  const stack = source('../lambdas/cloudformation/templates/scouts.yaml');
  const deploy = source('../lambdas/scouts/deploy.sh');
  const schedule = source('../lambdas/scouts/function/runtime-schedule.mjs');
  assert.match(stack, /ScheduledRefreshExpression:[\s\S]*?Default: rate\(6 hours\)/);
  assert.match(deploy, /SCHEDULED_REFRESH_EXPRESSION=.*rate\(6 hours\)/);
  assert.match(deploy, /ScheduledRefreshExpression="\$\{SCHEDULED_REFRESH_EXPRESSION\}"/);
  assert.match(deploy, /image-head-memo\.mjs/);
  assert.match(deploy, /runtime-activity-index\.mjs/);
  assert.match(deploy, /s3-request-metrics\.mjs/);
  assert.match(deploy, /LegacyRuntimeSnapshotsEnabled="\$\{LEGACY_RUNTIME_SNAPSHOTS_ENABLED\}"/);
  assert.match(schedule, /rate\(6 hours\)/);
  assert.match(stack, /ScoutsScheduledRefreshRule:[\s\S]*?ScheduleExpression: !Ref ScheduledRefreshExpression/);
  assert.match(stack, /LegacyRuntimeSnapshotsEnabled:\n\s+Type: String\n\s+AllowedValues:\n\s+- 'true'\n\s+- 'false'\n\s+Default: 'true'/);
  assert.match(deploy, /LEGACY_RUNTIME_SNAPSHOTS_ENABLED=\"\$\{LEGACY_RUNTIME_SNAPSHOTS_ENABLED:-true\}\"/);
  assert.match(stack, /SCOUTS_LEGACY_RUNTIME_SNAPSHOTS: !Ref LegacyRuntimeSnapshotsEnabled/);
  assert.match(schedule, /setScheduledRefreshEnabled/);
  assert.match(deploy, /aws sts get-caller-identity/);
});

test('cost work does not alter live SQS mapping or DynamoDB table capacity', () => {
  const stack = source('../lambdas/cloudformation/templates/scouts.yaml');
  assert.match(stack, /ScoutsProcessingDlqActivityMapping:[\s\S]*?Enabled: true/);
  assert.match(stack, /ScoutsRequestActivityTableName/);
});

test('deferred refresh outbox is durable, conditional, bounded and opt-in', () => {
  const stack = source('../lambdas/cloudformation/templates/scouts.yaml');
  const deploy = source('../lambdas/scouts/deploy.sh');
  const service = source('../lambdas/scouts/function/scouts-service.mjs');
  const entry = source('../lambdas/scouts/function/scouts-entry.mjs');
  const outbox = source('../lambdas/scouts/function/runtime-deferred-refresh.mjs');
  const admin = source('../website/admin/admin-diagnostics-enhancements.js');

  assert.match(stack, /DeferredRefreshOutboxEnabled:[\s\S]*?Default: 'false'/);
  assert.match(stack, /ScoutsDeferredRefreshOutbox:[\s\S]*?BillingMode: PAY_PER_REQUEST/);
  assert.match(stack, /ScoutsDeferredRefreshOutbox:[\s\S]*?Condition: ShouldEnableDeferredRefreshOutbox/);
  assert.match(stack, /ScoutsDeferredRefreshOutbox:[\s\S]*?DeletionPolicy: Retain[\s\S]*?UpdateReplacePolicy: Retain/);
  assert.match(stack, /IndexName: state-nextAttemptAt-index[\s\S]*?ProjectionType: INCLUDE/);
  assert.match(stack, /DeferredRefreshDispatchExpression:[\s\S]*?Default: rate\(15 minutes\)/);
  assert.match(stack, /ScoutsDeferredRefreshDispatchRule:[\s\S]*?Condition: ShouldEnableDeferredRefreshOutbox[\s\S]*?ScheduleExpression: !Ref DeferredRefreshDispatchExpression/);
  assert.match(stack, /DeferredRefreshDispatchBatchSize:[\s\S]*?MaxValue: 10/);
  assert.match(deploy, /runtime-deferred-refresh\.mjs/);
  assert.match(deploy, /DeferredRefreshOutboxEnabled="\$\{DEFERRED_REFRESH_OUTBOX_ENABLED\}"/);
  assert.match(service, /options\.deferExcess === true/);
  assert.match(service, /event\?\._scheduledRefresh === true/);
  assert.match(entry, /isDeferredRefreshDispatchInvocation/);
  assert.match(entry, /drainDeferredRefreshQueue\(\{ publish: publishDeferredRefreshMessage, limit \}\)/);
  assert.match(entry, /command\.subject === 'deferredrefresh' && command\.action === 'status'/);
  assert.match(outbox, /ConditionExpression: '#state = :ready AND nextAttemptAt <= :due AND expiresAt > :nowEpoch'/);
  assert.match(outbox, /ADD sourceKeys :sourceKeys/);
  assert.match(outbox, /ConditionExpression: '#state = :leased AND leaseId = :leaseId'/);
  assert.match(outbox, /needs_attention/);
  assert.match(outbox, /retention_elapsed_before_dispatch/);
  assert.match(admin, /subject: 'deferredRefresh', action: 'status'/);
  assert.match(admin, /Deferred enrichment work/);
  assert.match(admin, /Due ready items sampled/);
});
