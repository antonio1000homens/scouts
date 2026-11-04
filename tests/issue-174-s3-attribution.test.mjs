import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAttributionTimeline,
  buildMetricDataQueries,
  collectAttribution,
  parseAttributionOptions,
  summarizeAttributionTimeline,
} from '../scripts/scouts-s3-request-attribution.mjs';

const START = '2026-11-03T18:00:00Z';
const END = '2026-11-03T19:00:00Z';

test('attribution options default to a bounded day and require an AWS profile', () => {
  const options = parseAttributionOptions([], { AWS_PROFILE: 'scouts' }, new Date('2026-11-03T19:00:00Z'));
  assert.deepEqual(options, {
    profile: 'scouts',
    start: '2026-11-02T19:00:00.000Z',
    end: '2026-11-03T19:00:00.000Z',
  });
  assert.throws(() => parseAttributionOptions([], {}, new Date()), /Set AWS_PROFILE/);
});

test('attribution time ranges require timezone-aware endpoints and are capped at seven days', () => {
  assert.throws(() => parseAttributionOptions(['--profile', 'scouts', '--start', '2026-11-03T18:00:00', '--end', END]), /must include a timezone/);
  assert.throws(() => parseAttributionOptions(['--profile', 'scouts', '--hours', '169']), /from 1 to 168/);
  assert.throws(() => parseAttributionOptions(['--profile', 'scouts', '--start', '2026-10-20T00:00:00Z', '--end', END]), /cannot exceed/);
});

test('one-minute metrics query S3 bucket requests and Scouts Lambda activity', () => {
  const queries = buildMetricDataQueries();
  assert.equal(queries.length, 6);
  assert.ok(queries.every((query) => query.MetricStat.Period === 60 && query.MetricStat.Stat === 'Sum'));
  assert.deepEqual(queries[0].MetricStat.Metric.Dimensions, [
    { Name: 'BucketName', Value: 'scouts-2ndtolworth-prod-553490163883' },
    { Name: 'FilterId', Value: 'CodexRequestCostAudit' },
  ]);
  assert.deepEqual(queries[4].MetricStat.Metric.Dimensions, [
    { Name: 'FunctionName', Value: 'scouts' },
  ]);
});

test('minute timeline joins bucket requests and Lambda invocations by timestamp', () => {
  const timeline = buildAttributionTimeline([
    { Id: 's3head', Timestamps: [START], Values: [3] },
    { Id: 's3get', Timestamps: [START], Values: [7] },
    { Id: 'lambdaInvocations', Timestamps: [START], Values: [1] },
  ]);
  assert.deepEqual(timeline, [{
    timestamp: '2026-11-03T18:00:00.000Z',
    s3: { HeadRequests: 3, GetRequests: 7 },
    scoutsLambda: { Invocations: 1 },
  }]);
});

test('timeline summary totals bucket requests and exposes same-minute correlation limits', () => {
  const summary = summarizeAttributionTimeline([
    {
      timestamp: START,
      s3: { GetRequests: 10, HeadRequests: 0 },
      scoutsLambda: { Invocations: 1, Errors: 0 },
    },
    {
      timestamp: '2026-11-03T18:01:00.000Z',
      s3: { GetRequests: 20, HeadRequests: 2, ListRequests: 1, PutRequests: 3 },
      scoutsLambda: {},
    },
    {
      timestamp: '2026-11-03T18:02:00.000Z',
      s3: {},
      scoutsLambda: { Invocations: 2, Errors: 1 },
    },
    {
      timestamp: '2026-11-03T18:03:00.000Z',
      s3: { GetRequests: 0, PutRequests: 0 },
      scoutsLambda: { Invocations: 0, Errors: 0 },
    },
  ]);

  assert.deepEqual(summary, {
    s3RequestTotals: {
      GetRequests: 30,
      HeadRequests: 2,
      ListRequests: 1,
      PutRequests: 3,
      TotalRequests: 36,
    },
    scoutsLambdaTotals: { Invocations: 3, Errors: 1 },
    s3MetricDataMinuteBins: 3,
    s3RequestMinuteBins: 2,
    s3RequestMinuteBinsWithLambdaInvocations: 1,
    s3RequestMinuteBinsWithoutLambdaInvocations: 1,
    latestS3RequestMinute: '2026-11-03T18:01:00.000Z',
    latestScoutsLambdaInvocationMinute: '2026-11-03T18:02:00.000Z',
  });
});

test('audit stops before other AWS reads when the verified account is wrong', () => {
  const calls = [];
  assert.throws(() => collectAttribution({
    profile: 'wrong', start: START, end: END,
    run(args, profile) { calls.push({ args, profile }); return { Account: '243857182133' }; },
  }), /expected 553490163883/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profile, 'wrong');
});

test('audit returns bounded aggregate logs without exposing Lambda request IDs', () => {
  const calls = [];
  let sdkLogPage = 0;
  const run = (args, profile) => {
    calls.push({ args, profile });
    if (args[0] === 'sts') return { Account: '553490163883' };
    if (args[0] === 's3api') return { MetricsConfiguration: { Id: 'CodexRequestCostAudit' } };
    if (args[0] === 'cloudwatch') return { MetricDataResults: [
      { Id: 's3get', Label: 'GetRequests', Timestamps: [START], Values: [7], StatusCode: 'Complete' },
      { Id: 'lambdaInvocations', Label: 'ScoutsInvocations', Timestamps: [START], Values: [1], StatusCode: 'Complete' },
    ] };
    if (args[0] === 'logs') {
      const pattern = args[args.indexOf('--filter-pattern') + 1];
      const sdkPattern = pattern.includes('SDK calls');
      if (sdkPattern) sdkLogPage += 1;
      if (sdkPattern && sdkLogPage === 1) {
        return {
          events: [{
            timestamp: Date.parse(START),
            message: `2026-11-03T18:00:00Z\tprivate-request-id\tINFO\t[S3 Request Reduction] SDK calls by operation { source: scheduled-refresh }`,
          }],
          nextToken: 'next-log-page',
        };
      }
      return { events: [{
        timestamp: Date.parse(START),
        message: `2026-11-03T18:00:00Z\tprivate-request-id\tINFO\t[S3 Request Reduction] ${sdkPattern ? 'SDK calls by operation { source: scheduled-refresh, operationCounts: { GetObject: 2 } }' : 'Per-refresh avoided requests { reusedHexReads: 2 }'}`,
      }] };
    }
    throw new Error(`Unexpected AWS command: ${args[0]}`);
  };

  const result = collectAttribution({ profile: 'scouts', start: START, end: END, run, now: new Date(END) });
  assert.equal(result.account, '553490163883');
  assert.deepEqual(result.timeline[0].s3, { GetRequests: 7 });
  assert.deepEqual(result.timeline[0].scoutsLambda, { Invocations: 1 });
  assert.equal(result.sdkOperationLogs.length, 2);
  assert.ok(result.sdkOperationLogs.every((event) => /SDK calls by operation/.test(event.summary)));
  assert.doesNotMatch(JSON.stringify(result), /private-request-id/);
  assert.equal(calls[0].profile, 'scouts');
  assert.equal(calls.filter((call) => call.args[0] === 'logs').length, 3);
  assert.equal(calls.some((call) => call.args.includes('--next-token') && call.args.includes('next-log-page')), true);
});

test('aggregate log collection partitions multi-hour windows before bounded pagination', () => {
  const calls = [];
  const run = (args, profile) => {
    calls.push({ args, profile });
    if (args[0] === 'sts') return { Account: '553490163883' };
    if (args[0] === 's3api') return { MetricsConfiguration: { Id: 'CodexRequestCostAudit' } };
    if (args[0] === 'cloudwatch') return { MetricDataResults: [] };
    if (args[0] === 'logs') {
      const pattern = args[args.indexOf('--filter-pattern') + 1];
      const phrase = pattern.includes('SDK calls') ? 'SDK calls by operation' : 'Per-refresh avoided requests';
      const start = Number(args[args.indexOf('--start-time') + 1]);
      return { events: [{ timestamp: start, message: `[S3 Request Reduction] ${phrase} { source: scheduled-refresh }` }] };
    }
    throw new Error(`Unexpected AWS command: ${args[0]}`);
  };

  const result = collectAttribution({
    profile: 'scouts', start: START, end: '2026-11-03T20:00:00Z', run, now: new Date('2026-11-03T20:00:00Z'),
  });

  const logCalls = calls.filter((call) => call.args[0] === 'logs');
  assert.equal(logCalls.length, 4);
  assert.deepEqual(logCalls.map(({ args }) => [
    new Date(Number(args[args.indexOf('--start-time') + 1])).toISOString(),
    new Date(Number(args[args.indexOf('--end-time') + 1])).toISOString(),
  ]), [
    ['2026-11-03T18:00:00.000Z', '2026-11-03T19:00:00.000Z'],
    ['2026-11-03T19:00:00.000Z', '2026-11-03T20:00:00.000Z'],
    ['2026-11-03T18:00:00.000Z', '2026-11-03T19:00:00.000Z'],
    ['2026-11-03T19:00:00.000Z', '2026-11-03T20:00:00.000Z'],
  ]);
  assert.equal(result.sdkOperationLogs.length, 2);
  assert.equal(result.perRefreshAvoidedRequestLogs.length, 2);
  assert.equal(result.sdkOperationLogsTruncated, false);
  assert.equal(result.perRefreshLogsTruncated, false);
});
