#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const ACCOUNT_ID = '553490163883';
const REGION = 'eu-west-2';
const TABLES = ['scouts-gemini-usage', 'scouts-enrichment-state', 'scouts-request-activity'];
const CUSTOM_NAMESPACES = ['Scouts/Gemini', 'Scouts/ImageGeneration'];
const profileIndex = process.argv.indexOf('--profile');
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : process.env.AWS_PROFILE;
const scanIndex = process.argv.indexOf('--max-scan-items');
const maxScanItems = Math.max(1, Math.min(500, Number(scanIndex >= 0 ? process.argv[scanIndex + 1] : 200) || 200));
const env = { ...process.env, AWS_PROFILE: profile, AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION };
if (!profile) throw new Error('Set AWS_PROFILE or pass --profile for the Scouts account');

function aws(args) {
  const output = execFileSync('aws', [...args, '--region', REGION, '--no-cli-pager', '--output', 'json'], { env, encoding: 'utf8' });
  return JSON.parse(output);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function metricStats(namespace, metricName, dimensions, startTime, endTime) {
  return aws([
    'cloudwatch', 'get-metric-statistics', '--namespace', namespace, '--metric-name', metricName,
    '--dimensions', ...dimensions.flatMap(({ Name, Value }) => [`Name=${Name},Value=${Value}`]),
    '--start-time', startTime, '--end-time', endTime, '--period', '86400', '--statistics', 'Sum',
  ]).Datapoints || [];
}

function scanExpiry(tableName, limit, nowSeconds) {
  const counts = { sampled: 0, missing: 0, invalid: 0, expired: 0, expiresWithin7Days: 0, expiresWithin30Days: 0, expiresLater: 0 };
  const states = {};
  let exclusiveStartKey;
  while (counts.sampled < limit) {
    const remaining = limit - counts.sampled;
    const args = [
      'dynamodb', 'scan', '--table-name', tableName,
      '--projection-expression', 'expiresAt,#state', '--expression-attribute-names', '{"#state":"state"}',
      '--limit', String(Math.min(100, remaining)), '--select', 'SPECIFIC_ATTRIBUTES',
    ];
    if (exclusiveStartKey) args.push('--exclusive-start-key', JSON.stringify(exclusiveStartKey));
    const page = aws(args);
    for (const item of page.Items || []) {
      counts.sampled += 1;
      const state = item.state?.S || '(no state)';
      states[state] = (states[state] || 0) + 1;
      const raw = item.expiresAt?.N;
      if (raw === undefined) { counts.missing += 1; continue; }
      const expiry = Number(raw);
      if (!Number.isFinite(expiry) || !Number.isInteger(expiry)) { counts.invalid += 1; continue; }
      if (expiry <= nowSeconds) counts.expired += 1;
      else if (expiry <= nowSeconds + 7 * 86400) counts.expiresWithin7Days += 1;
      else if (expiry <= nowSeconds + 30 * 86400) counts.expiresWithin30Days += 1;
      else counts.expiresLater += 1;
    }
    exclusiveStartKey = page.LastEvaluatedKey;
    if (!exclusiveStartKey || !(page.Items || []).length) break;
    sleep(1000);
  }
  return { ...counts, stateCounts: states, capped: Boolean(exclusiveStartKey && counts.sampled >= limit) };
}

const identity = aws(['sts', 'get-caller-identity']);
if (identity.Account !== ACCOUNT_ID) {
  throw new Error(`Refusing audit: profile ${profile} resolved to account ${identity.Account}, expected ${ACCOUNT_ID}`);
}

const now = new Date();
const nowSeconds = Math.floor(now.getTime() / 1000);
const start = new Date(now.getTime() - 14 * 86400_000).toISOString();
const end = now.toISOString();
const result = {
  generatedAt: end,
  account: identity.Account,
  region: REGION,
  profile,
  limits: { maxScanItemsPerTable: maxScanItems, scanDelayMs: 1000, usageLookbackDays: 14 },
  tables: [],
  customMetricIdentities: {},
  alarms: [],
  dynamodbUsage14d: [],
};

for (const tableName of TABLES) {
  const [description, ttl] = [
    aws(['dynamodb', 'describe-table', '--table-name', tableName]).Table,
    aws(['dynamodb', 'describe-time-to-live', '--table-name', tableName]).TimeToLiveDescription,
  ];
  result.tables.push({
    tableName,
    status: description.TableStatus,
    billingMode: description.BillingModeSummary?.BillingMode || 'PROVISIONED',
    itemCountEstimate: description.ItemCount,
    tableSizeBytes: description.TableSizeBytes,
    keySchema: description.KeySchema,
    indexes: description.GlobalSecondaryIndexes?.map(({ IndexName, KeySchema, Projection, ProvisionedThroughput }) => ({ IndexName, KeySchema, Projection, ProvisionedThroughput })) || [],
    ttl,
    expirySample: scanExpiry(tableName, maxScanItems, nowSeconds),
  });
}

const alarms = aws(['cloudwatch', 'describe-alarms', '--alarm-name-prefix', 'scouts-']);
result.alarms = (alarms.MetricAlarms || []).map(({ AlarmName, StateValue, Namespace, MetricName, Dimensions, Statistic, Period, EvaluationPeriods, Threshold, ComparisonOperator, TreatMissingData, AlarmActions }) => ({ AlarmName, StateValue, Namespace, MetricName, Dimensions, Statistic, Period, EvaluationPeriods, Threshold, ComparisonOperator, TreatMissingData, AlarmActions }));

for (const namespace of CUSTOM_NAMESPACES) {
  const metrics = aws(['cloudwatch', 'list-metrics', '--namespace', namespace]).Metrics || [];
  result.customMetricIdentities[namespace] = metrics.map(({ MetricName, Dimensions }) => ({ MetricName, Dimensions }));
}

for (const tableName of TABLES) {
  for (const metricName of ['ConsumedReadCapacityUnits', 'ConsumedWriteCapacityUnits', 'ReadThrottleEvents', 'WriteThrottleEvents']) {
    const datapoints = metricStats('AWS/DynamoDB', metricName, [{ Name: 'TableName', Value: tableName }], start, end);
    result.dynamodbUsage14d.push({ tableName, metricName, datapointCount: datapoints.length, sum: datapoints.reduce((total, point) => total + (point.Sum || 0), 0), datapoints });
  }
  if (tableName === 'scouts-request-activity') {
    for (const metricName of ['ConsumedReadCapacityUnits', 'ConsumedWriteCapacityUnits', 'ReadThrottleEvents', 'WriteThrottleEvents']) {
      const datapoints = metricStats('AWS/DynamoDB', metricName, [{ Name: 'TableName', Value: tableName }, { Name: 'GlobalSecondaryIndexName', Value: 'activity-feed' }], start, end);
      result.dynamodbUsage14d.push({ tableName, indexName: 'activity-feed', metricName, datapointCount: datapoints.length, sum: datapoints.reduce((total, point) => total + (point.Sum || 0), 0), datapoints });
    }
  }
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
