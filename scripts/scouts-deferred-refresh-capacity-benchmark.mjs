#!/usr/bin/env node
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ACCOUNT_ID = '553490163883';
const REGION = 'eu-west-2';
const FREE_RCU_LIMIT = 25;
const FREE_WCU_LIMIT = 25;
const ITEM_COUNT = 100;
const ENQUEUE_CONCURRENCY = 10;
const DISPATCH_BATCH = 10;
const DISPATCH_INTERVAL_MS = 15 * 60 * 1000;
const RETENTION_SECONDS = 14 * 24 * 60 * 60;
const DIAGNOSTIC_RETENTION_SECONDS = 14 * 24 * 60 * 60;
const THROTTLE_NAMES = [
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'ThrottlingException',
  'Throttling',
];

function parseOptions(argv = process.argv.slice(2), env = process.env) {
  const options = { help: argv.includes('--help'), apply: argv.includes('--apply') };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--help' || name === '--apply') continue;
    if (name !== '--profile' && name !== '--confirm-account') throw new Error(`Unknown argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    options[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  options.profile ||= env.AWS_PROFILE || '';
  return options;
}

function helpText() {
  return [
    'Bounded DynamoDB capacity benchmark for the Scouts deferred-refresh outbox.',
    '',
    'Dry run (read-only): AWS_PROFILE=scouts node scripts/scouts-deferred-refresh-capacity-benchmark.mjs',
    'Execute (writes an isolated table): AWS_PROFILE=scouts node scripts/scouts-deferred-refresh-capacity-benchmark.mjs --apply --confirm-account 553490163883',
    '',
    'The benchmark uses a temporary PROVISIONED table and GSI at 1 RCU/1 WCU each,',
    'creates up to 100 synthetic rows, simulates 10-item dispatches with no SQS sends,',
    'records consumed capacity and throttles, then deletes its table. It never enables',
    'the production outbox or reads production event data. Run only after owner approval.',
  ].join('\n');
}

function makeAwsRunner(profile) {
  const env = {
    ...process.env,
    AWS_PROFILE: profile,
    AWS_REGION: REGION,
    AWS_DEFAULT_REGION: REGION,
    AWS_RETRY_MODE: 'standard',
    AWS_MAX_ATTEMPTS: '3',
  };
  return async (args, { json = true } = {}) => {
    const { stdout } = await execFileAsync('aws', [
      ...args,
      '--region', REGION,
      '--no-cli-pager',
      '--output', 'json',
    ], { env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    return json ? JSON.parse(stdout || '{}') : stdout;
  };
}

function getErrorName(error) {
  const text = `${error?.stderr || ''}\n${error?.message || ''}`;
  const known = [
    ...THROTTLE_NAMES,
    'ConditionalCheckFailedException',
    'ResourceInUseException',
    'ResourceNotFoundException',
  ];
  return known.find((name) => text.includes(name)) || 'AwsCommandFailed';
}

function isThrottle(error) {
  const text = `${error?.stderr || ''}\n${error?.message || ''}`;
  return THROTTLE_NAMES.some((name) => text.includes(name));
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function addCapacity(report, operation, output) {
  const capacity = output?.ConsumedCapacity;
  if (!capacity) return;
  const row = report.consumedCapacity[operation] ||= {
    calls: 0,
    tableReadUnits: 0,
    tableWriteUnits: 0,
    indexReadUnits: 0,
    indexWriteUnits: 0,
    totalUnits: 0,
  };
  row.calls += 1;
  row.totalUnits += Number(capacity.CapacityUnits || 0);
  row.tableReadUnits += Number(capacity.Table?.ReadCapacityUnits || 0);
  row.tableWriteUnits += Number(capacity.Table?.WriteCapacityUnits || 0);
  for (const indexCapacity of Object.values(capacity.GlobalSecondaryIndexes || {})) {
    row.indexReadUnits += Number(indexCapacity.ReadCapacityUnits || 0);
    row.indexWriteUnits += Number(indexCapacity.WriteCapacityUnits || 0);
  }
}

function makeWorkItem(index, runId, startedAt) {
  const hex = digest(`${runId}#hex#${index}`).slice(0, 32);
  const stage = ['tagline', 'imageTheme', 'image'][index % 3];
  const generationId = digest(`${runId}#generation#${index}`);
  const workKey = digest(`${hex}\0${stage}\0${generationId}`);
  const requestId = `deferred-${workKey}`;
  const createdAt = startedAt.toISOString();
  const subject = {
    title: 'Synthetic issue 174 capacity benchmark event',
    hex,
    metadata: {
      hex,
      tagline: null,
      image: { theme: null, url: null },
      status: { isHidden: false, isApproved: false },
    },
  };
  return {
    hex,
    stage,
    generationId,
    workKey,
    requestId,
    createdAt,
    expiresAt: Math.floor(startedAt.getTime() / 1000) + RETENTION_SECONDS,
    nextAttemptAt: `${createdAt}#${workKey}`,
    subjectJson: JSON.stringify(subject),
    title: subject.title,
    sourceKey: 'benchmark#beavers',
  };
}

function updateValues(item, startedAt) {
  return {
    ':ready': { S: 'ready' },
    ':leased': { S: 'leased' },
    ':createdAt': { S: item.createdAt },
    ':nextAttemptAt': { S: item.nextAttemptAt },
    ':expiresAt': { N: String(item.expiresAt) },
    ':zero': { N: '0' },
    ':requestId': { S: item.requestId },
    ':rootRequestId': { S: item.requestId },
    ':hex': { S: item.hex },
    ':stage': { S: item.stage },
    ':generationId': { S: item.generationId },
    ':title': { S: item.title },
    ':subjectJson': { S: item.subjectJson },
    ':updatedAt': { S: startedAt.toISOString() },
    ':sourceKeys': { SS: [item.sourceKey] },
    ':nowEpoch': { N: String(Math.floor(startedAt.getTime() / 1000)) },
  };
}

function addThrottle(report, operation, error) {
  report.throttles.total += 1;
  report.throttles.byOperation[operation] = (report.throttles.byOperation[operation] || 0) + 1;
  const errorName = getErrorName(error);
  report.throttles.byError[errorName] = (report.throttles.byError[errorName] || 0) + 1;
}

async function tableInventory(aws) {
  const listed = await aws(['dynamodb', 'list-tables']);
  const tables = [];
  for (const tableName of listed.TableNames || []) {
    const table = (await aws(['dynamodb', 'describe-table', '--table-name', tableName])).Table;
    const billingMode = table.BillingModeSummary?.BillingMode
      || (Number(table.ProvisionedThroughput?.ReadCapacityUnits || 0) > 0 ? 'PROVISIONED' : 'PAY_PER_REQUEST');
    if (billingMode !== 'PROVISIONED') continue;
    const tableThroughput = table.ProvisionedThroughput || {};
    let read = Number(tableThroughput.ReadCapacityUnits || 0);
    let write = Number(tableThroughput.WriteCapacityUnits || 0);
    for (const index of table.GlobalSecondaryIndexes || []) {
      read += Number(index.ProvisionedThroughput?.ReadCapacityUnits || 0);
      write += Number(index.ProvisionedThroughput?.WriteCapacityUnits || 0);
    }
    tables.push({ tableName, readCapacityUnits: read, writeCapacityUnits: write, status: table.TableStatus });
  }
  return tables;
}

async function verifyPayerScope(aws, accountId) {
  const organization = await aws(['organizations', 'describe-organization']);
  const payerId = organization.Organization?.ManagementAccountId || organization.Organization?.MasterAccountId;
  if (payerId !== accountId) {
    throw new Error('Refusing benchmark: the verified account is not the Organizations management/payer account.');
  }
  const response = await aws(['organizations', 'list-accounts']);
  const activeAccounts = (response.Accounts || []).filter((account) => account.Status === 'ACTIVE');
  if (activeAccounts.length !== 1 || activeAccounts[0]?.Id !== accountId) {
    throw new Error('Refusing benchmark: the verified account is not the only active account in its AWS Organization; provisioned Free Tier usage could be shared.');
  }
}

async function createBenchmarkTable(aws, tableName) {
  return aws([
    'dynamodb', 'create-table',
    '--table-name', tableName,
    '--attribute-definitions',
    'AttributeName=workKey,AttributeType=S',
    'AttributeName=state,AttributeType=S',
    'AttributeName=nextAttemptAt,AttributeType=S',
    '--key-schema', 'AttributeName=workKey,KeyType=HASH',
    '--billing-mode', 'PROVISIONED',
    '--provisioned-throughput', 'ReadCapacityUnits=1,WriteCapacityUnits=1',
    '--global-secondary-indexes', JSON.stringify([{
      IndexName: 'state-nextAttemptAt-index',
      KeySchema: [
        { AttributeName: 'state', KeyType: 'HASH' },
        { AttributeName: 'nextAttemptAt', KeyType: 'RANGE' },
      ],
      Projection: {
        ProjectionType: 'INCLUDE',
        NonKeyAttributes: ['createdAt', 'expiresAt', 'attemptCount', 'hex', 'stage', 'lastError', 'terminalReason'],
      },
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
    }]),
    '--tags', JSON.stringify([
      { Key: 'Purpose', Value: 'issue-174-capacity-benchmark' },
      { Key: 'Owner', Value: 'codex-temporary' },
    ]),
  ]);
}

async function enqueueOne(aws, report, tableName, item, startedAt) {
  const names = { '#state': 'state' };
  const values = updateValues(item, startedAt);
  try {
    const output = await aws([
      'dynamodb', 'update-item',
      '--table-name', tableName,
      '--key', JSON.stringify({ workKey: { S: item.workKey } }),
      '--update-expression', 'SET #state = if_not_exists(#state, :ready), createdAt = if_not_exists(createdAt, :createdAt), nextAttemptAt = if_not_exists(nextAttemptAt, :nextAttemptAt), expiresAt = if_not_exists(expiresAt, :expiresAt), attemptCount = if_not_exists(attemptCount, :zero), requestId = if_not_exists(requestId, :requestId), rootRequestId = if_not_exists(rootRequestId, :rootRequestId), hex = if_not_exists(hex, :hex), stage = if_not_exists(stage, :stage), generationId = if_not_exists(generationId, :generationId), title = if_not_exists(title, :title), subjectJson = if_not_exists(subjectJson, :subjectJson), updatedAt = :updatedAt ADD sourceKeys :sourceKeys',
      '--condition-expression', '(attribute_not_exists(#state) OR #state IN (:ready, :leased)) AND (attribute_not_exists(expiresAt) OR expiresAt > :nowEpoch)',
      '--expression-attribute-names', JSON.stringify(names),
      '--expression-attribute-values', JSON.stringify(values),
      '--return-values', 'ALL_NEW',
      '--return-consumed-capacity', 'INDEXES',
    ]);
    addCapacity(report, 'enqueue', output);
    return { ok: true };
  } catch (error) {
    if (!isThrottle(error)) return { ok: false, fatal: getErrorName(error) };
    addThrottle(report, 'enqueue', error);
    return { ok: false, throttled: true };
  }
}

async function queryState(aws, report, tableName, state, at) {
  const output = await aws([
    'dynamodb', 'query',
    '--table-name', tableName,
    '--index-name', 'state-nextAttemptAt-index',
    '--key-condition-expression', '#state = :state AND nextAttemptAt <= :due',
    '--expression-attribute-names', JSON.stringify({ '#state': 'state' }),
    '--expression-attribute-values', JSON.stringify({
      ':state': { S: state },
      ':due': { S: `${at.toISOString()}#~` },
    }),
    '--limit', String(DISPATCH_BATCH),
    '--return-consumed-capacity', 'INDEXES',
  ]);
  addCapacity(report, `query-${state}`, output);
  return output.Items || [];
}

async function countState(aws, report, tableName, state, at) {
  const output = await aws([
    'dynamodb', 'query',
    '--table-name', tableName,
    '--index-name', 'state-nextAttemptAt-index',
    '--key-condition-expression', '#state = :state AND nextAttemptAt <= :due',
    '--expression-attribute-names', JSON.stringify({ '#state': 'state' }),
    '--expression-attribute-values', JSON.stringify({
      ':state': { S: state },
      ':due': { S: `${at.toISOString()}#~` },
    }),
    '--select', 'COUNT',
    '--return-consumed-capacity', 'INDEXES',
  ]);
  addCapacity(report, `count-${state}`, output);
  return Number(output.Count || 0);
}

async function recoverExpiredLease(aws, report, tableName, indexedItem, at) {
  const workKey = indexedItem.workKey?.S;
  if (!workKey) return false;
  const loaded = await aws([
    'dynamodb', 'get-item',
    '--table-name', tableName,
    '--key', JSON.stringify({ workKey: { S: workKey } }),
    '--consistent-read',
    '--return-consumed-capacity', 'INDEXES',
  ]);
  addCapacity(report, 'load-expired-lease', loaded);
  const item = loaded.Item;
  if (!item?.workKey?.S || item.state?.S !== 'leased') return false;
  const nextState = Number(item.attemptCount?.N || 0) >= 6 ? 'needs_attention' : 'ready';
  const now = at.toISOString();
  const values = {
    ':leased': { S: 'leased' },
    ':nextState': { S: nextState },
    ':nextAttemptAt': { S: `${now}#${workKey}` },
    ':now': { S: now },
    ':due': { S: `${now}#~` },
    ':reason': { S: 'dispatch_lease_expired' },
    ...(nextState === 'needs_attention'
      ? { ':terminalTtl': { N: String(Math.floor(at.getTime() / 1000) + DIAGNOSTIC_RETENTION_SECONDS) } }
      : {}),
  };
  try {
    const output = await aws([
      'dynamodb', 'update-item',
      '--table-name', tableName,
      '--key', JSON.stringify({ workKey: { S: workKey } }),
      '--update-expression', nextState === 'needs_attention'
        ? 'SET #state = :nextState, nextAttemptAt = :nextAttemptAt, updatedAt = :now, lastError = :reason, ttlAt = :terminalTtl REMOVE leaseId'
        : 'SET #state = :nextState, nextAttemptAt = :nextAttemptAt, updatedAt = :now, lastError = :reason REMOVE leaseId',
      '--condition-expression', '#state = :leased AND nextAttemptAt <= :due',
      '--expression-attribute-names', JSON.stringify({ '#state': 'state' }),
      '--expression-attribute-values', JSON.stringify(values),
      '--return-consumed-capacity', 'INDEXES',
    ]);
    addCapacity(report, 'recover-expired-lease', output);
    return true;
  } catch (error) {
    if (isThrottle(error)) {
      addThrottle(report, 'recover-expired-lease', error);
      return false;
    }
    if (getErrorName(error) === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

async function dispatchOne(aws, report, tableName, indexedItem, at) {
  const workKey = indexedItem.workKey?.S;
  if (!workKey) return false;
  const loaded = await aws([
    'dynamodb', 'get-item',
    '--table-name', tableName,
    '--key', JSON.stringify({ workKey: { S: workKey } }),
    '--consistent-read',
    '--return-consumed-capacity', 'INDEXES',
  ]);
  addCapacity(report, 'load-ready-item', loaded);
  if (!loaded.Item?.workKey?.S || loaded.Item.state?.S !== 'ready') return false;

  const leaseId = crypto.randomUUID();
  const leaseUntilDate = new Date(at.getTime() + 5 * 60 * 1000);
  const leaseUntil = `${leaseUntilDate.toISOString()}#${workKey}`;
  let claimed;
  try {
    claimed = await aws([
      'dynamodb', 'update-item',
      '--table-name', tableName,
      '--key', JSON.stringify({ workKey: { S: workKey } }),
      '--update-expression', 'SET #state = :leased, nextAttemptAt = :leaseUntil, leaseUntil = :leaseUntil, leaseId = :leaseId, updatedAt = :now ADD attemptCount :one',
      '--condition-expression', '#state = :ready AND nextAttemptAt <= :due AND expiresAt > :nowEpoch',
      '--expression-attribute-names', JSON.stringify({ '#state': 'state' }),
      '--expression-attribute-values', JSON.stringify({
        ':ready': { S: 'ready' },
        ':leased': { S: 'leased' },
        ':leaseUntil': { S: leaseUntil },
        ':leaseId': { S: leaseId },
        ':now': { S: at.toISOString() },
        ':due': { S: `${at.toISOString()}#~` },
        ':nowEpoch': { N: String(Math.floor(at.getTime() / 1000)) },
        ':one': { N: '1' },
      }),
      '--return-values', 'ALL_NEW',
      '--return-consumed-capacity', 'INDEXES',
    ]);
    addCapacity(report, 'claim-ready-item', claimed);
  } catch (error) {
    if (isThrottle(error)) {
      addThrottle(report, 'claim-ready-item', error);
      return false;
    }
    if (getErrorName(error) === 'ConditionalCheckFailedException') return false;
    throw error;
  }

  const now = at.toISOString();
  try {
    const output = await aws([
      'dynamodb', 'update-item',
      '--table-name', tableName,
      '--key', JSON.stringify({ workKey: { S: workKey } }),
      '--update-expression', 'SET #state = :dispatched, updatedAt = :now, dispatchedAt = :now, nextAttemptAt = :terminalAt, ttlAt = :terminalTtl, sqsMessageId = :messageId REMOVE leaseUntil, leaseId',
      '--condition-expression', '#state = :leased AND leaseId = :leaseId',
      '--expression-attribute-names', JSON.stringify({ '#state': 'state' }),
      '--expression-attribute-values', JSON.stringify({
        ':leased': { S: 'leased' },
        ':dispatched': { S: 'dispatched' },
        ':now': { S: now },
        ':messageId': { S: `benchmark-${workKey.slice(0, 12)}` },
        ':leaseId': { S: leaseId },
        ':terminalAt': { S: `${now}#${workKey}` },
        ':terminalTtl': { N: String(Math.floor(at.getTime() / 1000) + DIAGNOSTIC_RETENTION_SECONDS) },
      }),
      '--return-consumed-capacity', 'INDEXES',
    ]);
    addCapacity(report, 'mark-dispatched', output);
    return true;
  } catch (error) {
    if (isThrottle(error)) {
      addThrottle(report, 'mark-dispatched', error);
      return false;
    }
    throw error;
  }
}

async function runBenchmark(aws, report, tableName, startedAt) {
  const runId = crypto.randomUUID();
  const items = Array.from({ length: ITEM_COUNT }, (_, index) => makeWorkItem(index, runId, startedAt));
  let next = 0;
  const workers = Array.from({ length: ENQUEUE_CONCURRENCY }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const result = await enqueueOne(aws, report, tableName, items[index], startedAt);
      if (result.ok) report.enqueue.succeeded += 1;
      else if (result.throttled) report.enqueue.throttled += 1;
      else report.enqueue.fatal.push(result.fatal);
    }
  });
  await Promise.all(workers);
  if (report.enqueue.fatal.length) throw new Error(`Benchmark enqueue failed with ${report.enqueue.fatal.length} non-throttle AWS errors`);

  await new Promise((resolve) => setTimeout(resolve, 3000));
  const maxRuns = Math.ceil(ITEM_COUNT / DISPATCH_BATCH) + 2;
  for (let run = 0; run < maxRuns; run += 1) {
    const at = new Date(startedAt.getTime() + (run + 1) * DISPATCH_INTERVAL_MS);
    report.dispatch.runs += 1;
    let leasedItems;
    let readyItems;
    try {
      leasedItems = await queryState(aws, report, tableName, 'leased', at);
      for (const leasedItem of leasedItems) {
        await recoverExpiredLease(aws, report, tableName, leasedItem, at);
      }
      readyItems = await queryState(aws, report, tableName, 'ready', at);
    } catch (error) {
      if (!isThrottle(error)) throw error;
      addThrottle(report, 'dispatch-query', error);
      continue;
    }
    if (!readyItems.length && !leasedItems.length) break;
    for (const item of readyItems) {
      try {
        const dispatched = await dispatchOne(aws, report, tableName, item, at);
        if (dispatched) {
          report.dispatch.dispatched += 1;
          report.dispatch.simulatedPublishCount += 1;
          report.dispatch.maxSimulatedQueueAgeMinutes = Math.max(
            report.dispatch.maxSimulatedQueueAgeMinutes,
            (run + 1) * 15,
          );
        }
      } catch (error) {
        if (!isThrottle(error)) throw error;
        addThrottle(report, 'dispatch-item', error);
      }
    }
  }
  const finalAt = new Date(startedAt.getTime() + (maxRuns + 1) * DISPATCH_INTERVAL_MS);
  report.dispatch.remainingReady = await countState(aws, report, tableName, 'ready', finalAt);
  report.dispatch.remainingLeased = await countState(aws, report, tableName, 'leased', finalAt);
}

async function main() {
  const options = parseOptions();
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (!options.profile) throw new Error('Set AWS_PROFILE or pass --profile for the Scouts account');
  if (options.apply && options.confirmAccount !== ACCOUNT_ID) {
    throw new Error(`Applying the benchmark requires --confirm-account ${ACCOUNT_ID}`);
  }
  if (!options.apply && options.confirmAccount && options.confirmAccount !== ACCOUNT_ID) {
    throw new Error(`Refusing mismatched confirmation account ${options.confirmAccount}`);
  }

  const aws = makeAwsRunner(options.profile);
  const identity = await aws(['sts', 'get-caller-identity']);
  if (identity.Account !== ACCOUNT_ID) {
    throw new Error(`Refusing benchmark: profile ${options.profile} resolved to ${identity.Account}, expected ${ACCOUNT_ID}`);
  }
  await verifyPayerScope(aws, identity.Account);

  const existingProvisioned = await tableInventory(aws);
  const currentRcu = existingProvisioned.reduce((sum, table) => sum + table.readCapacityUnits, 0);
  const currentWcu = existingProvisioned.reduce((sum, table) => sum + table.writeCapacityUnits, 0);
  const proposedRcu = 2;
  const proposedWcu = 2;
  if (currentRcu + proposedRcu > FREE_RCU_LIMIT || currentWcu + proposedWcu > FREE_WCU_LIMIT) {
    throw new Error('Refusing benchmark: current provisioned table/index capacity plus this benchmark exceeds the 25/25 Always Free allowance.');
  }

  const suffix = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const tableName = `scouts-174-capacity-benchmark-${suffix}`;
  const report = {
    mode: options.apply ? 'apply' : 'dry-run',
    account: identity.Account,
    region: REGION,
    profile: options.profile,
    tableName,
    benchmark: {
      syntheticItems: ITEM_COUNT,
      enqueueConcurrency: ENQUEUE_CONCURRENCY,
      dispatchBatch: DISPATCH_BATCH,
      simulatedDispatchIntervalMinutes: 15,
      publisher: 'no-op; no SQS messages are sent',
      tableCapacity: { read: 1, write: 1 },
      gsiCapacity: { read: 1, write: 1 },
      totalProvisionedCapacity: { read: proposedRcu, write: proposedWcu },
    },
    payerInventory: {
      activeAccounts: 1,
      existingProvisionedTablesAndIndexes: existingProvisioned,
      existingCapacity: { read: currentRcu, write: currentWcu },
      freeTierLimit: { read: FREE_RCU_LIMIT, write: FREE_WCU_LIMIT },
    },
    enqueue: { succeeded: 0, throttled: 0, fatal: [] },
    dispatch: {
      runs: 0,
      dispatched: 0,
      simulatedPublishCount: 0,
      maxSimulatedQueueAgeMinutes: 0,
      remainingReady: null,
      remainingLeased: null,
    },
    throttles: { total: 0, byOperation: {}, byError: {} },
    consumedCapacity: {},
    cleanup: { attempted: false, deleted: false },
  };

  if (!options.apply) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  let tableCreated = false;
  let failed = false;
  try {
    process.stderr.write(`Creating temporary benchmark table ${tableName}; if interrupted, inspect and remove this table before retrying.\n`);
    await createBenchmarkTable(aws, tableName);
    tableCreated = true;
    await aws(['dynamodb', 'wait', 'table-exists', '--table-name', tableName], { json: false });
    report.tableStatus = (await aws(['dynamodb', 'describe-table', '--table-name', tableName])).Table.TableStatus;
    await runBenchmark(aws, report, tableName, new Date());
  } catch (error) {
    failed = true;
    report.error = getErrorName(error);
  } finally {
    if (tableCreated) {
      report.cleanup.attempted = true;
      try {
        await aws(['dynamodb', 'delete-table', '--table-name', tableName]);
        await aws(['dynamodb', 'wait', 'table-not-exists', '--table-name', tableName], { json: false });
        report.cleanup.deleted = true;
      } catch (error) {
        if (getErrorName(error) === 'ResourceNotFoundException') report.cleanup.deleted = true;
        else {
          failed = true;
          report.cleanup.error = getErrorName(error);
        }
      }
    }
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failed || !report.cleanup.deleted) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});
