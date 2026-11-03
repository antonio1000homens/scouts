import crypto from 'node:crypto';
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const TABLE_NAME = String(process.env.SCOUTS_DEFERRED_REFRESH_TABLE_NAME || '').trim();
const READY_INDEX = 'state-nextAttemptAt-index';
const DEFAULT_RETENTION_SECONDS = 14 * 24 * 60 * 60;
const DIAGNOSTIC_RETENTION_SECONDS = 14 * 24 * 60 * 60;
const LEASE_SECONDS = 5 * 60;
const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 6 * 60 * 60;
const MAX_SUBJECT_BYTES = 200 * 1024;
const clientDefault = new DynamoDBClient({ region: REGION });
let client = clientDefault;

const text = (value) => typeof value === 'string' ? value.trim() : '';
const asString = (value) => ({ S: String(value) });
const asNumber = (value) => ({ N: String(value) });

function tableName() {
  return TABLE_NAME || String(process.env.SCOUTS_DEFERRED_REFRESH_TABLE_NAME || '').trim();
}

function requireTable() {
  const name = tableName();
  if (!name) {
    const error = new Error('Deferred refresh outbox is not configured');
    error.statusCode = 503;
    throw error;
  }
  return name;
}

function unmarshal(item = {}) {
  const output = {};
  for (const [key, value] of Object.entries(item || {})) {
    if (value?.S !== undefined) output[key] = value.S;
    else if (value?.N !== undefined) output[key] = Number(value.N);
    else if (value?.SS !== undefined) output[key] = value.SS;
  }
  return output;
}

function stableId(value, prefix = '') {
  return `${prefix}${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function setDeferredRefreshClientForTests(nextClient) {
  if (!nextClient || typeof nextClient.send !== 'function') throw new TypeError('Deferred refresh test client must expose send(command)');
  client = nextClient;
}

export function resetDeferredRefreshClientForTests() { client = clientDefault; }

export function buildDeferredRefreshWork(input = {}, options = {}) {
  const hex = text(input.hex).toLowerCase();
  const stage = text(input.stage);
  const generationId = text(input.generationId).toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) throw new TypeError('Deferred refresh HEX must be hexadecimal');
  if (!['tagline', 'imageTheme', 'image'].includes(stage)) throw new TypeError('Deferred refresh stage is invalid');
  if (!/^[0-9a-f]{64}$/.test(generationId)) throw new TypeError('Deferred refresh generation ID must be a SHA-256 hex digest');
  if (!input.subject || typeof input.subject !== 'object' || Array.isArray(input.subject)) throw new TypeError('Deferred refresh subject must be an object');

  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new TypeError('Deferred refresh time is invalid');
  const retentionSeconds = Math.max(3600, Math.trunc(Number(options.retentionSeconds ?? DEFAULT_RETENTION_SECONDS)));
  const canonical = `${hex}\0${stage}\0${generationId}`;
  const workKey = stableId(canonical);
  const requestId = stableId(canonical, 'deferred-');
  const sourceKey = text(input.sourceKey);
  if (!/^[a-zA-Z0-9_./-]{1,100}#[a-zA-Z0-9_-]{1,32}$/.test(sourceKey)) {
    throw new TypeError('Deferred refresh source key must be a feed identifier and realm, not a URL');
  }
  const sourceSubject = input.subject;
  const metadata = sourceSubject.metadata && typeof sourceSubject.metadata === 'object' ? sourceSubject.metadata : {};
  const hexMetadata = metadata.hex ? { hex: metadata.hex } : {};
  const subject = {
    title: text(sourceSubject.title) || text(sourceSubject.summary) || text(input.title) || hex,
    hex,
    metadata: {
      ...hexMetadata,
      tagline: metadata.tagline ?? sourceSubject.tagline ?? null,
      image: metadata.image && typeof metadata.image === 'object'
        ? { theme: metadata.image.theme ?? null, url: metadata.image.url ?? null }
        : { theme: sourceSubject.image?.theme ?? null, url: sourceSubject.image?.url ?? null },
      status: metadata.status && typeof metadata.status === 'object'
        ? { isHidden: metadata.status.isHidden === true, isApproved: metadata.status.isApproved === true }
        : { isHidden: false, isApproved: sourceSubject.approved === true },
    },
  };
  const subjectJson = JSON.stringify(subject);
  if (Buffer.byteLength(subjectJson, 'utf8') > MAX_SUBJECT_BYTES) throw new RangeError('Deferred refresh subject exceeds the 200 KiB outbox limit');

  const createdAt = now.toISOString();
  const expiresAt = Math.floor(now.getTime() / 1000) + retentionSeconds;
  return {
    workKey,
    requestId,
    rootRequestId: requestId,
    hex,
    stage,
    generationId,
    title: text(input.title) || text(subject.title) || hex,
    subjectJson,
    sourceKey,
    createdAt,
    expiresAt,
    nextAttemptAt: `${createdAt}#${workKey}`,
  };
}

export async function enqueueDeferredRefresh(input, options = {}) {
  const work = buildDeferredRefreshWork(input, options);
  const name = requireTable();
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  try {
    const response = await client.send(new UpdateItemCommand({
      TableName: name,
      Key: { workKey: asString(work.workKey) },
      UpdateExpression: 'SET #state = if_not_exists(#state, :ready), createdAt = if_not_exists(createdAt, :createdAt), nextAttemptAt = if_not_exists(nextAttemptAt, :nextAttemptAt), expiresAt = if_not_exists(expiresAt, :expiresAt), attemptCount = if_not_exists(attemptCount, :zero), requestId = if_not_exists(requestId, :requestId), rootRequestId = if_not_exists(rootRequestId, :rootRequestId), hex = if_not_exists(hex, :hex), stage = if_not_exists(stage, :stage), generationId = if_not_exists(generationId, :generationId), title = if_not_exists(title, :title), subjectJson = if_not_exists(subjectJson, :subjectJson), updatedAt = :updatedAt ADD sourceKeys :sourceKeys',
      ConditionExpression: '(attribute_not_exists(#state) OR #state IN (:ready, :leased)) AND (attribute_not_exists(expiresAt) OR expiresAt > :nowEpoch)',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':ready': asString('ready'), ':leased': asString('leased'),
        ':createdAt': asString(work.createdAt), ':nextAttemptAt': asString(work.nextAttemptAt),
        ':expiresAt': asNumber(work.expiresAt), ':zero': asNumber(0),
        ':requestId': asString(work.requestId), ':rootRequestId': asString(work.rootRequestId),
        ':hex': asString(work.hex), ':stage': asString(work.stage), ':generationId': asString(work.generationId),
        ':title': asString(work.title), ':subjectJson': asString(work.subjectJson),
        ':updatedAt': asString(now.toISOString()), ':sourceKeys': { SS: [work.sourceKey] },
        ':nowEpoch': asNumber(Math.floor(now.getTime() / 1000)),
      },
      ReturnValues: 'ALL_NEW',
    }));
    const item = unmarshal(response?.Attributes);
    return { enqueued: item.state === 'ready' || item.state === 'leased', state: item.state || 'ready', workKey: work.workKey, requestId: work.requestId };
  } catch (error) {
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
    const existing = await client.send(new GetItemCommand({
      TableName: name,
      Key: { workKey: asString(work.workKey) },
      ConsistentRead: true,
      ProjectionExpression: '#state',
      ExpressionAttributeNames: { '#state': 'state' },
    }));
    const state = unmarshal(existing?.Item).state || 'expired';
    return { enqueued: false, state, workKey: work.workKey, requestId: work.requestId };
  }
}

function dueToken(date) { return `${date.toISOString()}#~`; }

async function queryState(state, now, limit) {
  const response = await client.send(new QueryCommand({
    TableName: requireTable(),
    IndexName: READY_INDEX,
    KeyConditionExpression: '#state = :state AND nextAttemptAt <= :due',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: { ':state': asString(state), ':due': asString(dueToken(now)) },
    ScanIndexForward: true,
    Limit: limit,
  }));
  return (response?.Items || []).map(unmarshal);
}

async function loadWorkItem(workKey) {
  const response = await client.send(new GetItemCommand({
    TableName: requireTable(),
    Key: { workKey: asString(workKey) },
    ConsistentRead: true,
  }));
  return unmarshal(response?.Item);
}

async function recoverExpiredLease(item, now) {
  const nextState = Number(item.attemptCount || 0) >= MAX_ATTEMPTS ? 'needs_attention' : 'ready';
  const nowIso = now.toISOString();
  const nextAttemptAt = `${nowIso}#${item.workKey}`;
  await client.send(new UpdateItemCommand({
    TableName: requireTable(), Key: { workKey: asString(item.workKey) },
    UpdateExpression: nextState === 'needs_attention'
      ? 'SET #state = :nextState, nextAttemptAt = :nextAttemptAt, updatedAt = :now, lastError = :reason, ttlAt = :terminalTtl REMOVE leaseId'
      : 'SET #state = :nextState, nextAttemptAt = :nextAttemptAt, updatedAt = :now, lastError = :reason REMOVE leaseId',
    ConditionExpression: '#state = :leased AND nextAttemptAt <= :due',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: {
      ':leased': asString('leased'), ':nextState': asString(nextState), ':nextAttemptAt': asString(nextAttemptAt),
      ':now': asString(nowIso), ':due': asString(dueToken(now)), ':reason': asString('dispatch_lease_expired'),
      ...(nextState === 'needs_attention' ? { ':terminalTtl': asNumber(Math.floor(now.getTime() / 1000) + DIAGNOSTIC_RETENTION_SECONDS) } : {}),
    },
  }));
  return nextState;
}

async function claimReadyItem(item, now) {
  const leaseId = crypto.randomUUID();
  const leaseUntilDate = new Date(now.getTime() + LEASE_SECONDS * 1000);
  const leaseUntil = `${leaseUntilDate.toISOString()}#${item.workKey}`;
  const response = await client.send(new UpdateItemCommand({
    TableName: requireTable(), Key: { workKey: asString(item.workKey) },
    UpdateExpression: 'SET #state = :leased, nextAttemptAt = :leaseUntil, leaseUntil = :leaseUntil, leaseId = :leaseId, updatedAt = :now ADD attemptCount :one',
    ConditionExpression: '#state = :ready AND nextAttemptAt <= :due AND expiresAt > :nowEpoch',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: {
      ':ready': asString('ready'), ':leased': asString('leased'), ':leaseUntil': asString(leaseUntil),
      ':leaseId': asString(leaseId), ':now': asString(now.toISOString()), ':due': asString(dueToken(now)),
      ':nowEpoch': asNumber(Math.floor(now.getTime() / 1000)), ':one': asNumber(1),
    },
    ReturnValues: 'ALL_NEW',
  }));
  const claimed = unmarshal(response?.Attributes);
  return { ...item, ...claimed, leaseId };
}

async function setTerminal(item, state, now, reason = null) {
  await client.send(new UpdateItemCommand({
    TableName: requireTable(), Key: { workKey: asString(item.workKey) },
    UpdateExpression: 'SET #state = :state, updatedAt = :now, nextAttemptAt = :terminalAt, ttlAt = :terminalTtl, terminalReason = :reason REMOVE leaseUntil, leaseId',
    ConditionExpression: '#state = :ready AND expiresAt <= :nowEpoch',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: {
      ':state': asString(state), ':now': asString(now.toISOString()),
      ':ready': asString('ready'), ':nowEpoch': asNumber(Math.floor(now.getTime() / 1000)),
      ':terminalAt': asString(`${now.toISOString()}#${item.workKey}`), ':reason': asString(reason || state),
      ':terminalTtl': asNumber(Math.floor(now.getTime() / 1000) + DIAGNOSTIC_RETENTION_SECONDS),
    },
  }));
}

async function recordDispatchFailure(item, error, now) {
  const attemptCount = Number(item.attemptCount || 1);
  const terminal = attemptCount >= MAX_ATTEMPTS;
  const backoffSeconds = Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * (2 ** Math.max(0, attemptCount - 1)));
  const expiryMs = Number(item.expiresAt || 0) * 1000;
  const retryMs = now.getTime() + backoffSeconds * 1000;
  const nextAt = terminal ? null : new Date(expiryMs > 0 ? Math.min(retryMs, expiryMs) : retryMs);
  const failure = text(error?.name || error?.code || 'dispatch_failed').slice(0, 80);
  const values = {
    ':leased': asString('leased'), ':now': asString(now.toISOString()), ':lastError': asString(failure),
    ...(terminal
      ? {
          ':nextState': asString('needs_attention'), ':terminalReason': asString(failure),
          ':terminalAt': asString(`${now.toISOString()}#${item.workKey}`),
          ':terminalTtl': asNumber(Math.floor(now.getTime() / 1000) + DIAGNOSTIC_RETENTION_SECONDS),
        }
      : { ':nextState': asString('ready'), ':nextAttemptAt': asString(`${nextAt.toISOString()}#${item.workKey}`) }),
  };
  await client.send(new UpdateItemCommand({
    TableName: requireTable(), Key: { workKey: asString(item.workKey) },
    UpdateExpression: terminal
      ? 'SET #state = :nextState, updatedAt = :now, nextAttemptAt = :terminalAt, ttlAt = :terminalTtl, lastError = :lastError, terminalReason = :terminalReason REMOVE leaseUntil, leaseId'
      : 'SET #state = :nextState, updatedAt = :now, lastError = :lastError, nextAttemptAt = :nextAttemptAt REMOVE leaseUntil, leaseId',
    ConditionExpression: '#state = :leased AND leaseId = :leaseId',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: { ...values, ':leaseId': asString(item.leaseId) },
  }));
  return terminal ? 'needs_attention' : 'ready';
}

async function markDispatched(item, now, messageId) {
  await client.send(new UpdateItemCommand({
    TableName: requireTable(), Key: { workKey: asString(item.workKey) },
    UpdateExpression: 'SET #state = :dispatched, updatedAt = :now, dispatchedAt = :now, nextAttemptAt = :terminalAt, ttlAt = :terminalTtl, sqsMessageId = :messageId REMOVE leaseUntil, leaseId',
    ConditionExpression: '#state = :leased AND leaseId = :leaseId',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: {
      ':leased': asString('leased'), ':dispatched': asString('dispatched'), ':now': asString(now.toISOString()),
      ':messageId': asString(messageId || ''), ':leaseId': asString(item.leaseId),
      ':terminalAt': asString(`${now.toISOString()}#${item.workKey}`),
      ':terminalTtl': asNumber(Math.floor(now.getTime() / 1000) + DIAGNOSTIC_RETENTION_SECONDS),
    },
  }));
}

export async function drainDeferredRefreshQueue({ publish, now = new Date(), limit = 10 } = {}) {
  if (typeof publish !== 'function') throw new TypeError('Deferred refresh dispatcher requires a publish callback');
  const at = now instanceof Date ? now : new Date(now);
  const batchLimit = Math.max(1, Math.min(10, Math.trunc(Number(limit) || 10)));
  const result = { scanned: 0, dispatched: 0, expired: 0, retried: 0, needsAttention: 0, leaseRecovered: 0 };

  const staleLeases = await queryState('leased', at, batchLimit);
  for (const indexedItem of staleLeases) {
    const item = await loadWorkItem(indexedItem.workKey);
    if (!item?.workKey) continue;
    result.scanned += 1;
    try {
      const state = await recoverExpiredLease(item, at);
      if (state === 'ready') result.leaseRecovered += 1;
      else result.needsAttention += 1;
    } catch (error) {
      if (error?.name !== 'ConditionalCheckFailedException') throw error;
    }
  }

  const readyItems = await queryState('ready', at, batchLimit);
  for (const indexedItem of readyItems) {
    const candidate = await loadWorkItem(indexedItem.workKey);
    if (!candidate?.workKey) continue;
    result.scanned += 1;
    if (Number(candidate.expiresAt || 0) <= Math.floor(at.getTime() / 1000)) {
      try {
        await setTerminal(candidate, 'expired', at, 'retention_elapsed_before_dispatch');
        result.expired += 1;
      } catch (error) {
        if (error?.name !== 'ConditionalCheckFailedException') throw error;
      }
      continue;
    }

    let item;
    try {
      item = await claimReadyItem(candidate, at);
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') continue;
      throw error;
    }

    try {
      const subject = JSON.parse(item.subjectJson);
      const response = await publish({
        realm: 'scoutsRequest', subject,
        action: item.stage === 'tagline' ? 'new' : 'imageEnrich',
        requestMode: 'auto', approvalMode: 'auto',
        requestId: item.requestId, rootRequestId: item.rootRequestId,
      }, item);
      await markDispatched(item, at, response?.messageId || null);
      result.dispatched += 1;
    } catch (error) {
      try {
        const state = await recordDispatchFailure(item, error, at);
        if (state === 'ready') result.retried += 1;
        else result.needsAttention += 1;
      } catch (recordError) {
        console.error('[DeferredRefresh] Failed to record dispatch failure; lease expiry will recover it.', recordError?.message || recordError);
        throw recordError;
      }
    }
  }

  return result;
}

export async function getDeferredRefreshStatus({ limit = 50 } = {}) {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 50)));
  const states = ['ready', 'leased', 'needs_attention', 'expired'];
  const output = { source: 'deferred-refresh-outbox', bounded: true, sampleLimitPerState: boundedLimit, states: {} };
  for (const state of states) {
    const response = await client.send(new QueryCommand({
      TableName: requireTable(), IndexName: READY_INDEX,
      KeyConditionExpression: '#state = :state',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':state': asString(state) },
      ScanIndexForward: true, Limit: boundedLimit,
    }));
    const items = (response?.Items || []).map(unmarshal);
    const oldestAt = items[0]?.nextAttemptAt?.split('#')[0] || null;
    output.states[state] = {
      sampledItems: items.length,
      hasMore: Boolean(response?.LastEvaluatedKey),
      oldestAt,
      oldestReadyAt: state === 'ready' ? oldestAt : null,
      sampledRetryCount: items.reduce((sum, item) => sum + Number(item.attemptCount || 0), 0),
      actionableSamples: items.slice(0, 5).map((item) => ({
        hex: item.hex || null,
        stage: item.stage || null,
        attemptCount: Number(item.attemptCount || 0),
        createdAt: item.createdAt || null,
        expiresAt: Number(item.expiresAt || 0) || null,
        reason: item.terminalReason || item.lastError || null,
      })),
    };
    if (state === 'ready' || state === 'leased') {
      const dueResponse = await client.send(new QueryCommand({
        TableName: requireTable(), IndexName: READY_INDEX,
        KeyConditionExpression: '#state = :state AND nextAttemptAt <= :due',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':state': asString(state),
          ':due': asString(dueToken(new Date())),
        },
        ScanIndexForward: true,
        Limit: boundedLimit,
        Select: 'COUNT',
      }));
      output.states[state].dueSampledItems = Number(dueResponse?.Count || 0);
      output.states[state].dueHasMore = Boolean(dueResponse?.LastEvaluatedKey);
    }
  }
  return output;
}
