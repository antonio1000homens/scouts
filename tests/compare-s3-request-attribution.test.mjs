import assert from 'node:assert/strict';
import test from 'node:test';
import { compareAttributionWindows } from '../scripts/compare-s3-request-attribution.mjs';

const METRIC_IDS = ['s3get', 's3head', 's3list', 's3put', 'lambdaInvocations', 'lambdaErrors'];
const BASELINE_START = '2026-10-27T19:42:00.000Z';
const CUTOVER = '2026-11-03T19:42:00.000Z';
const AFTER_END = '2026-11-10T19:42:00.000Z';

function sample({ start, end, totalGet = 0, totalHead = 0, totalList = 0, totalPut = 0, invocations = 0, errors = 0, bins = 0 } = {}) {
  return {
    account: '553490163883',
    region: 'eu-west-2',
    bucket: 'scouts-2ndtolworth-prod-553490163883',
    requestMetricsId: 'CodexRequestCostAudit',
    functionName: 'scouts',
    range: { start, end },
    metricStatuses: METRIC_IDS.map((Id) => ({ Id, StatusCode: 'Complete' })),
    metricPagination: { pageCount: 1, truncated: false },
    sdkOperationLogsTruncated: false,
    perRefreshLogsTruncated: false,
    timelineSummary: {
      s3RequestTotals: {
        GetRequests: totalGet,
        HeadRequests: totalHead,
        ListRequests: totalList,
        PutRequests: totalPut,
        TotalRequests: totalGet + totalHead + totalList + totalPut,
      },
      scoutsLambdaTotals: { Invocations: invocations, Errors: errors },
      s3RequestMinuteBins: bins,
    },
  };
}

test('compares adjacent complete seven-day attribution windows', () => {
  const baseline = sample({
    start: BASELINE_START, end: CUTOVER,
    totalGet: 10000, totalHead: 200, totalList: 50, totalPut: 100,
    invocations: 28, errors: 0, bins: 1000,
  });
  const after = sample({
    start: CUTOVER, end: AFTER_END,
    totalGet: 9000, totalHead: 150, totalList: 50, totalPut: 90,
    invocations: 28, errors: 1, bins: 900,
  });

  const result = compareAttributionWindows(baseline, after);
  assert.equal(result.windowHours, 168);
  assert.deepEqual(result.s3Requests.GetRequests, {
    before: 10000, after: 9000, delta: -1000, percentChange: -10,
  });
  assert.deepEqual(result.s3Requests.TotalRequests, {
    before: 10350, after: 9290, delta: -1060, percentChange: -10.24,
  });
  assert.deepEqual(result.scoutsLambda.Errors, {
    before: 0, after: 1, delta: 1, percentChange: null,
  });
  assert.deepEqual(result.requestMinuteBins, {
    before: 1000, after: 900, delta: -100, percentChange: -10,
  });
  assert.match(result.interpretation, /bucket-wide/);
});

test('rejects partial, truncated, or unaligned measurement windows', () => {
  const baseline = sample({ start: BASELINE_START, end: CUTOVER, totalGet: 1 });
  const after = sample({ start: CUTOVER, end: AFTER_END, totalGet: 1 });

  const partial = structuredClone(after);
  partial.metricStatuses[0].StatusCode = 'PartialData';
  assert.throws(() => compareAttributionWindows(baseline, partial), /metric s3get is not Complete/);

  const truncated = structuredClone(after);
  truncated.sdkOperationLogsTruncated = true;
  assert.throws(() => compareAttributionWindows(baseline, truncated), /sdkOperationLogsTruncated must be false/);

  const unaligned = structuredClone(after);
  unaligned.range.start = '2026-11-03T19:43:00.000Z';
  unaligned.range.end = '2026-11-10T19:43:00.000Z';
  assert.throws(() => compareAttributionWindows(baseline, unaligned), /begin exactly when/);

  const short = structuredClone(after);
  short.range.end = '2026-11-10T19:41:00.000Z';
  assert.throws(() => compareAttributionWindows(baseline, short), /exactly seven days/);
});

test('rejects different resource identities and inconsistent summary totals', () => {
  const baseline = sample({ start: BASELINE_START, end: CUTOVER, totalGet: 10 });
  const after = sample({ start: CUTOVER, end: AFTER_END, totalGet: 10 });

  const otherBucket = structuredClone(after);
  otherBucket.bucket = 'other-bucket';
  assert.throws(() => compareAttributionWindows(baseline, otherBucket), /different bucket values/);

  const inconsistent = structuredClone(after);
  inconsistent.timelineSummary.s3RequestTotals.TotalRequests = 11;
  assert.throws(() => compareAttributionWindows(baseline, inconsistent), /does not match operation totals/);
});
