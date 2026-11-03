import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createImageHeadMemo } from '../lambdas/scouts/function/image-head-memo.mjs';

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
});

test('retired unconditional queued snapshot writes do not remove compatibility reads', () => {
  const scouts = source('../lambdas/scouts/function/scouts-service.mjs');
  assert.doesNotMatch(scouts, /touchQueuedRuntimeSnapshot/);
  assert.doesNotMatch(scouts, /appendQueuedRuntimeSnapshot/);
  assert.match(scouts, /const runtimeQueueSnapshots = await readRuntimeQueueSnapshots\(bucket\)/);
  assert.match(scouts, /pruneQueuedRuntimeRequests\(queuedRequests, processingSnapshot, completedSnapshot, Date\.now\(\)\)/);
  assert.match(scouts, /if \(prunedQueuedResult\.removedCount > 0\)/);
  assert.match(scouts, /mergeProcessingSnapshotIntoIndex\(processingSnapshot, activeProcessingByHex, eventByHex\)/);
  const entry = source('../lambdas/scouts/function/scouts-entry.mjs');
  assert.match(entry, /command\.subject === 'snapshot'/);
  assert.match(entry, /command\.subject === 'activity'/);
});

test('low-frequency schedule is configurable and the previous cadence can be restored', () => {
  const stack = source('../lambdas/cloudformation/templates/scouts.yaml');
  const deploy = source('../lambdas/scouts/deploy.sh');
  const schedule = source('../lambdas/scouts/function/runtime-schedule.mjs');
  assert.match(stack, /ScheduledRefreshExpression:[\s\S]*?Default: rate\(6 hours\)/);
  assert.match(deploy, /SCHEDULED_REFRESH_EXPRESSION=.*rate\(6 hours\)/);
  assert.match(deploy, /ScheduledRefreshExpression="\$\{SCHEDULED_REFRESH_EXPRESSION\}"/);
  assert.match(deploy, /image-head-memo\.mjs/);
  assert.match(schedule, /rate\(6 hours\)/);
  assert.match(stack, /ScoutsScheduledRefreshRule:[\s\S]*?ScheduleExpression: !Ref ScheduledRefreshExpression/);
  assert.match(schedule, /setScheduledRefreshEnabled/);
  assert.match(deploy, /aws sts get-caller-identity/);
});

test('cost work does not alter live SQS mapping or DynamoDB table capacity', () => {
  const stack = source('../lambdas/cloudformation/templates/scouts.yaml');
  assert.match(stack, /ScoutsProcessingDlqActivityMapping:[\s\S]*?Enabled: true/);
  assert.match(stack, /ScoutsRequestActivityTableName/);
});
