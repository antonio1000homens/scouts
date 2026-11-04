#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ACCOUNT_ID = '553490163883';
const REGION = 'eu-west-2';
const BUCKET = 'scouts-2ndtolworth-prod-553490163883';
const METRICS_ID = 'CodexRequestCostAudit';
const FUNCTION_NAME = 'scouts';
const LOG_GROUP = '/aws/lambda/scouts';
const MAX_HOURS = 7 * 24;
const MAX_PAGES = 10;
const LOG_WINDOW_MS = 60 * 60 * 1000;
const METRIC_IDS = Object.freeze({
  s3get: ['s3', 'GetRequests'],
  s3head: ['s3', 'HeadRequests'],
  s3list: ['s3', 'ListRequests'],
  s3put: ['s3', 'PutRequests'],
  lambdaInvocations: ['lambda', 'Invocations'],
  lambdaErrors: ['lambda', 'Errors'],
});

function runAws(args, profile) {
  const env = {
    ...process.env,
    AWS_PROFILE: profile,
    AWS_REGION: REGION,
    AWS_DEFAULT_REGION: REGION,
  };
  const output = execFileSync('aws', [
    ...args,
    '--region', REGION,
    '--no-cli-pager',
    '--output', 'json',
  ], { env, encoding: 'utf8' });
  return JSON.parse(output);
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function parseTimestamp(value, name) {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`${name} must include a timezone, for example 2026-11-03T18:00:00Z`);
  }
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) throw new Error(`${name} is not a valid timestamp`);
  return time;
}

export function parseAttributionOptions(argv = [], env = process.env, now = new Date()) {
  if (argv.includes('--help')) return { help: true };
  const allowed = new Set(['--profile', '--hours', '--start', '--end']);
  for (let index = 0; index < argv.length; index += 1) {
    if (!allowed.has(argv[index])) throw new Error(`Unknown argument: ${argv[index]}`);
    index += 1;
  }

  const profile = optionValue(argv, '--profile') || env.AWS_PROFILE || '';
  if (!profile.trim()) throw new Error('Set AWS_PROFILE or pass --profile for the Scouts account');

  const startValue = optionValue(argv, '--start');
  const endValue = optionValue(argv, '--end');
  if (Boolean(startValue) !== Boolean(endValue)) {
    throw new Error('Pass both --start and --end, or neither');
  }

  let start;
  let end;
  if (startValue && endValue) {
    start = parseTimestamp(startValue, '--start');
    end = parseTimestamp(endValue, '--end');
  } else {
    const rawHours = optionValue(argv, '--hours');
    const hours = rawHours === undefined ? 24 : Number(rawHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) {
      throw new Error(`--hours must be an integer from 1 to ${MAX_HOURS}`);
    }
    end = new Date(now);
    start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  }
  if (end <= start) throw new Error('--end must be later than --start');
  if (end.getTime() - start.getTime() > MAX_HOURS * 60 * 60 * 1000) {
    throw new Error(`The requested range cannot exceed ${MAX_HOURS} hours`);
  }

  return {
    profile: profile.trim(),
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

export function buildMetricDataQueries() {
  const queries = [];
  for (const [id, [service, metricName]] of Object.entries(METRIC_IDS)) {
    const isS3 = service === 's3';
    queries.push({
      Id: id,
      Label: isS3 ? metricName : `Scouts${metricName}`,
      MetricStat: {
        Metric: {
          Namespace: isS3 ? 'AWS/S3' : 'AWS/Lambda',
          MetricName: metricName,
          Dimensions: isS3
            ? [
                { Name: 'BucketName', Value: BUCKET },
                { Name: 'FilterId', Value: METRICS_ID },
              ]
            : [{ Name: 'FunctionName', Value: FUNCTION_NAME }],
        },
        Period: 60,
        Stat: 'Sum',
      },
      ReturnData: true,
    });
  }
  return queries;
}

export function buildAttributionTimeline(metricResults = []) {
  const rows = new Map();
  for (const result of metricResults) {
    const key = result.Id;
    if (!Object.hasOwn(METRIC_IDS, key)) continue;
    const [group, name] = METRIC_IDS[key];
    for (let index = 0; index < (result.Timestamps || []).length; index += 1) {
      const timestamp = new Date(result.Timestamps[index]).toISOString();
      const row = rows.get(timestamp) || {
        timestamp,
        s3: {},
        scoutsLambda: {},
      };
      const destination = group === 's3' ? row.s3 : row.scoutsLambda;
      destination[name] = result.Values?.[index] ?? null;
      rows.set(timestamp, row);
    }
  }
  return [...rows.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export function summarizeAttributionTimeline(timeline = []) {
  const requestNames = ['GetRequests', 'HeadRequests', 'ListRequests', 'PutRequests'];
  const s3RequestTotals = Object.fromEntries(requestNames.map((name) => [name, 0]));
  const scoutsLambdaTotals = { Invocations: 0, Errors: 0 };
  let s3MetricDataMinuteBins = 0;
  let s3RequestMinuteBins = 0;
  let s3RequestMinuteBinsWithLambdaInvocations = 0;
  let s3RequestMinuteBinsWithoutLambdaInvocations = 0;
  let latestS3RequestMinute = null;
  let latestScoutsLambdaInvocationMinute = null;

  for (const row of timeline) {
    let hasS3MetricData = false;
    let hasS3Requests = false;
    for (const name of requestNames) {
      const value = row.s3?.[name];
      if (value === null || value === undefined || !Number.isFinite(Number(value))) continue;
      const count = Number(value);
      s3RequestTotals[name] += count;
      hasS3MetricData = true;
      if (count > 0) hasS3Requests = true;
    }

    const invocations = row.scoutsLambda?.Invocations;
    const errors = row.scoutsLambda?.Errors;
    if (invocations !== null && invocations !== undefined && Number.isFinite(Number(invocations))) {
      scoutsLambdaTotals.Invocations += Number(invocations);
    }
    if (errors !== null && errors !== undefined && Number.isFinite(Number(errors))) {
      scoutsLambdaTotals.Errors += Number(errors);
    }

    if (hasS3MetricData) s3MetricDataMinuteBins += 1;
    if (hasS3Requests) {
      s3RequestMinuteBins += 1;
      latestS3RequestMinute = row.timestamp;
      if (Number(invocations) > 0) s3RequestMinuteBinsWithLambdaInvocations += 1;
      else s3RequestMinuteBinsWithoutLambdaInvocations += 1;
    }
    if (Number(invocations) > 0) latestScoutsLambdaInvocationMinute = row.timestamp;
  }

  s3RequestTotals.TotalRequests = requestNames.reduce((sum, name) => sum + s3RequestTotals[name], 0);
  return {
    s3RequestTotals,
    scoutsLambdaTotals,
    s3MetricDataMinuteBins,
    s3RequestMinuteBins,
    s3RequestMinuteBinsWithLambdaInvocations,
    s3RequestMinuteBinsWithoutLambdaInvocations,
    latestS3RequestMinute,
    latestScoutsLambdaInvocationMinute,
  };
}

function collectPagedResults(run, command, args, resultKey, nextTokenKey = 'NextToken') {
  const collected = [];
  let nextToken;
  let pageCount = 0;
  let truncated = false;
  do {
    const pageArgs = [...args, '--no-paginate'];
    if (nextToken) pageArgs.push('--next-token', nextToken);
    const page = run([command[0], command[1], ...pageArgs]);
    collected.push(...(page[resultKey] || []));
    nextToken = page[nextTokenKey];
    pageCount += 1;
    if (nextToken && pageCount >= MAX_PAGES) {
      truncated = true;
      break;
    }
  } while (nextToken);
  return { items: collected, truncated, pageCount };
}

function collectMetricData(run, start, end) {
  const result = collectPagedResults(run, ['cloudwatch', 'get-metric-data'], [
    '--metric-data-queries', JSON.stringify(buildMetricDataQueries()),
    '--start-time', start,
    '--end-time', end,
    '--scan-by', 'TimestampAscending',
    '--max-datapoints', '100000',
  ], 'MetricDataResults');
  return {
    metrics: result.items,
    timeline: buildAttributionTimeline(result.items),
    truncated: result.truncated,
    pageCount: result.pageCount,
  };
}

function aggregateLogMessages(events) {
  return events.map((event) => {
    const message = String(event.message || '');
    const startIndex = message.indexOf('[S3 Request Reduction]');
    return {
      timestamp: new Date(event.timestamp).toISOString(),
      summary: startIndex >= 0 ? message.slice(startIndex).trim() : '[S3 Request Reduction] aggregate event',
    };
  });
}

function collectAggregateLogs(run, start, end, phrase) {
  const endMs = new Date(end).getTime();
  let windowStartMs = new Date(start).getTime();
  const events = [];
  let truncated = false;
  let pageCount = 0;

  // FilterLogEvents returns events in chronological order. On a busy Lambda
  // log group, a single multi-day query can spend its bounded page budget on
  // older events before it reaches the aggregate summaries we need. Partition
  // the range so every hour gets its own bounded pagination budget.
  while (windowStartMs < endMs) {
    const windowEndMs = Math.min(windowStartMs + LOG_WINDOW_MS, endMs);
    const result = collectPagedResults(run, ['logs', 'filter-log-events'], [
      '--log-group-name', LOG_GROUP,
      '--start-time', String(windowStartMs),
      '--end-time', String(windowEndMs),
      '--filter-pattern', `"${phrase}"`,
      '--limit', '1000',
    ], 'events', 'nextToken');
    events.push(...result.items);
    truncated ||= result.truncated;
    pageCount += result.pageCount;
    windowStartMs = windowEndMs;
  }

  return {
    events: aggregateLogMessages(events),
    truncated,
    pageCount,
  };
}

export function collectAttribution({ profile, start, end, run = runAws, now = new Date() }) {
  if (!profile) throw new Error('Set AWS_PROFILE or pass --profile for the Scouts account');
  const startDate = parseTimestamp(start, 'start');
  const endDate = parseTimestamp(end, 'end');
  if (endDate <= startDate) throw new Error('end must be later than start');
  if (endDate.getTime() - startDate.getTime() > MAX_HOURS * 60 * 60 * 1000) {
    throw new Error(`The requested range cannot exceed ${MAX_HOURS} hours`);
  }

  const aws = (args) => run(args, profile);
  const identity = aws(['sts', 'get-caller-identity']);
  if (identity.Account !== ACCOUNT_ID) {
    throw new Error(`Refusing audit: profile ${profile} resolved to account ${identity.Account}, expected ${ACCOUNT_ID}`);
  }

  const metricsConfiguration = aws([
    's3api', 'get-bucket-metrics-configuration',
    '--bucket', BUCKET,
    '--id', METRICS_ID,
  ]);
  if (metricsConfiguration.MetricsConfiguration?.Id !== METRICS_ID) {
    throw new Error(`S3 request metrics configuration ${METRICS_ID} was not found`);
  }

  const metrics = collectMetricData(aws, startDate.toISOString(), endDate.toISOString());
  const sdkLogs = collectAggregateLogs(aws, startDate.toISOString(), endDate.toISOString(), 'SDK calls by operation');
  const refreshLogs = collectAggregateLogs(aws, startDate.toISOString(), endDate.toISOString(), 'Per-refresh avoided requests');

  return {
    generatedAt: now.toISOString(),
    account: identity.Account,
    region: REGION,
    profile,
    bucket: BUCKET,
    requestMetricsId: METRICS_ID,
    functionName: FUNCTION_NAME,
    logGroup: LOG_GROUP,
    range: { start: startDate.toISOString(), end: endDate.toISOString() },
    resolutionSeconds: 60,
    note: 'S3 request metrics are bucket-wide and can be delayed. Compare these minute bins with Scouts Lambda invocations and low-cardinality SDK logs; do not infer caller identity from bucket metrics alone.',
    timeline: metrics.timeline,
    timelineSummary: summarizeAttributionTimeline(metrics.timeline),
    metricStatuses: metrics.metrics.map(({ Id, Label, StatusCode, Messages }) => ({ Id, Label, StatusCode, Messages })),
    metricPagination: { pageCount: metrics.pageCount, truncated: metrics.truncated },
    sdkOperationLogs: sdkLogs.events,
    sdkOperationLogsTruncated: sdkLogs.truncated,
    perRefreshAvoidedRequestLogs: refreshLogs.events,
    perRefreshLogsTruncated: refreshLogs.truncated,
  };
}

export function helpText() {
  return [
    'Read-only S3 request attribution for the Scouts account.',
    '',
    'Usage: AWS_PROFILE=scouts node scripts/scouts-s3-request-attribution.mjs [--hours 24]',
    '       node scripts/scouts-s3-request-attribution.mjs --profile scouts --start 2026-11-03T00:00:00Z --end 2026-11-03T23:59:00Z',
    '',
    `The range is capped at ${MAX_HOURS} hours. The command verifies account ${ACCOUNT_ID} and only reads CloudWatch, CloudWatch Logs, S3 metrics configuration, and STS.`,
  ].join('\n');
}

export function main(argv = process.argv.slice(2), env = process.env, run = runAws) {
  const options = parseAttributionOptions(argv, env);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return null;
  }
  const result = collectAttribution({ ...options, run });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}
