#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const EXPECTED_METRIC_IDS = Object.freeze([
  's3get', 's3head', 's3list', 's3put', 'lambdaInvocations', 'lambdaErrors',
]);
const REQUEST_NAMES = Object.freeze([
  'GetRequests', 'HeadRequests', 'ListRequests', 'PutRequests',
]);

function readTimestamp(value, label) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`${label} must be a timezone-aware timestamp`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`${label} is invalid`);
  return timestamp;
}

function requireCount(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite nonnegative number`);
  }
  return value;
}

function validateSample(sample, label) {
  if (!sample || typeof sample !== 'object') throw new Error(`${label} sample must be an object`);
  const start = readTimestamp(sample.range?.start, `${label} range.start`);
  const end = readTimestamp(sample.range?.end, `${label} range.end`);
  if (end.getTime() - start.getTime() !== SEVEN_DAYS_MS) {
    throw new Error(`${label} window must be exactly seven days`);
  }

  for (const field of ['account', 'region', 'bucket', 'requestMetricsId', 'functionName']) {
    if (typeof sample[field] !== 'string' || !sample[field]) {
      throw new Error(`${label} sample is missing ${field}`);
    }
  }

  const statuses = sample.metricStatuses;
  if (!Array.isArray(statuses) || statuses.length !== EXPECTED_METRIC_IDS.length) {
    throw new Error(`${label} sample must contain all six metric query statuses`);
  }
  for (const id of EXPECTED_METRIC_IDS) {
    const status = statuses.find((item) => item.Id === id);
    if (!status || status.StatusCode !== 'Complete') {
      throw new Error(`${label} metric ${id} is not Complete`);
    }
  }
  if (sample.metricPagination?.truncated !== false) {
    throw new Error(`${label} metric results are missing or truncated`);
  }
  for (const field of ['sdkOperationLogsTruncated', 'perRefreshLogsTruncated']) {
    if (sample[field] !== false) throw new Error(`${label} ${field} must be false`);
  }

  const summary = sample.timelineSummary;
  const requestTotals = summary?.s3RequestTotals;
  if (!requestTotals || !summary?.scoutsLambdaTotals) {
    throw new Error(`${label} sample is missing timelineSummary`);
  }
  const validatedRequests = Object.fromEntries(REQUEST_NAMES.map((name) => [
    name,
    requireCount(requestTotals[name], `${label} ${name}`),
  ]));
  const calculatedTotal = REQUEST_NAMES.reduce((sum, name) => sum + validatedRequests[name], 0);
  const total = requireCount(requestTotals.TotalRequests, `${label} TotalRequests`);
  if (total !== calculatedTotal) throw new Error(`${label} TotalRequests does not match operation totals`);

  return {
    start,
    end,
    requestTotals: { ...validatedRequests, TotalRequests: total },
    lambdaTotals: {
      Invocations: requireCount(summary.scoutsLambdaTotals.Invocations, `${label} Invocations`),
      Errors: requireCount(summary.scoutsLambdaTotals.Errors, `${label} Errors`),
    },
    requestMinuteBins: requireCount(summary.s3RequestMinuteBins, `${label} s3RequestMinuteBins`),
  };
}

function change(before, after) {
  const delta = after - before;
  return {
    before,
    after,
    delta,
    percentChange: before === 0 ? null : Math.round((delta / before) * 10000) / 100,
  };
}

export function compareAttributionWindows(baseline, after) {
  const baselineData = validateSample(baseline, 'baseline');
  const afterData = validateSample(after, 'after');
  for (const field of ['account', 'region', 'bucket', 'requestMetricsId', 'functionName']) {
    if (baseline[field] !== after[field]) throw new Error(`Samples have different ${field} values`);
  }
  if (afterData.start.getTime() !== baselineData.end.getTime()) {
    throw new Error('After window must begin exactly when the baseline window ends');
  }

  return {
    account: baseline.account,
    region: baseline.region,
    bucket: baseline.bucket,
    requestMetricsId: baseline.requestMetricsId,
    functionName: baseline.functionName,
    windowHours: 168,
    baseline: { start: baselineData.start.toISOString(), end: baselineData.end.toISOString() },
    after: { start: afterData.start.toISOString(), end: afterData.end.toISOString() },
    s3Requests: Object.fromEntries([
      ...REQUEST_NAMES,
      'TotalRequests',
    ].map((name) => [name, change(baselineData.requestTotals[name], afterData.requestTotals[name])])),
    scoutsLambda: {
      Invocations: change(baselineData.lambdaTotals.Invocations, afterData.lambdaTotals.Invocations),
      Errors: change(baselineData.lambdaTotals.Errors, afterData.lambdaTotals.Errors),
    },
    requestMinuteBins: change(baselineData.requestMinuteBins, afterData.requestMinuteBins),
    interpretation: 'S3 metrics are bucket-wide and cannot attribute differences to Scouts. This comparison does not calculate bill charges; compare posted Cost Explorer charges separately.',
  };
}

function helpText() {
  return [
    'Compare two adjacent seven-day S3 attribution samples from the Scouts collector.',
    '',
    'Usage: node scripts/compare-s3-request-attribution.mjs <baseline.json> <after.json>',
    '',
    'Both samples must have complete, untruncated metrics and logs. The after window must begin exactly when the baseline window ends.',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (argv.length !== 2) throw new Error(helpText());
  const baseline = JSON.parse(readFileSync(argv[0], 'utf8'));
  const after = JSON.parse(readFileSync(argv[1], 'utf8'));
  process.stdout.write(`${JSON.stringify(compareAttributionWindows(baseline, after), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}
