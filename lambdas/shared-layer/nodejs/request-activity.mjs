import { AsyncLocalStorage } from 'node:async_hooks';
import { DynamoDBClient, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const TABLE_NAME = String(process.env.SCOUTS_REQUEST_ACTIVITY_TABLE_NAME || '').trim();
const RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MAX_TIMELINE = 24;
const client = new DynamoDBClient({ region: REGION });
const requestActivityContext = new AsyncLocalStorage();

const TERMINAL = new Set(['completed', 'failed', 'needs_attention', 'manual_review']);
const PRIORITY = Object.freeze({
  accepted: 10,
  queued: 20,
  processing: 40,
  orchestrating: 50,
  waiting_for_retry: 52,
  awaiting_image: 55,
  persisting: 60,
  awaiting_review: 65,
  published: 70,
  completed: 80,
  failed: 90,
  needs_attention: 100,
  manual_review: 100,
});
const RECONCILIATION_ENRICHMENT_ACTIONS = new Set(['new', 'imageenrich']);

function text(value) { return value === undefined || value === null ? '' : String(value).trim(); }
function hexOf(value) {
  const candidate = text(value?.hex || value?.requestHex || (typeof value?.subject === 'object' ? value.subject?.hex : ''));
  return /^[0-9a-f]+$/i.test(candidate) ? candidate.toLowerCase() : '';
}
function titleOf(value) {
  const subject = value?.subject && typeof value.subject === 'object' ? value.subject : {};
  return text(value?.title || value?.summary || subject?.title || subject?.summary || subject?.name) || null;
}
function requestIdOf(value) { return text(value?.requestId || value?.messageId) || null; }
function rootRequestIdOf(value) {
  return text(
    value?.rootRequestId
    || value?.operationId
    || requestActivityContext.getStore()?.rootRequestId
    || requestIdOf(value),
  ) || null;
}
function itemValue(value) { return value == null ? { NULL: true } : { S: String(value) }; }
function reconciliationIdOf(value) {
  return text(value?.reconciliationId || requestActivityContext.getStore()?.reconciliationId) || null;
}
function unmarshall(item = {}) {
  const result = {};
  for (const [key, value] of Object.entries(item)) {
    if ('S' in value) result[key] = value.S;
    else if ('N' in value) result[key] = Number(value.N);
    else if ('L' in value) result[key] = value.L.map((entry) => JSON.parse(entry.S));
  }
  return result;
}

export function requestActivityEnabled() { return Boolean(TABLE_NAME); }

export function withRequestActivityContext(context = {}, callback) {
  if (typeof callback !== 'function') throw new TypeError('Request activity context callback must be a function');
  const store = context && typeof context === 'object' ? context : {};
  const reconciliationId = text(store.reconciliationId);
  if (reconciliationId) store.reconciliationId = reconciliationId;
  const rootRequestId = text(store.rootRequestId || store.operationId);
  if (rootRequestId) store.rootRequestId = rootRequestId;
  if (!(store.enrichmentRequestIds instanceof Set)) store.enrichmentRequestIds = new Set();
  if (!Number.isFinite(Number(store.enrichmentRequestsStarted))) store.enrichmentRequestsStarted = 0;
  return requestActivityContext.run(store, callback);
}

export function trackReconciliationPublication(input = {}) {
  const store = requestActivityContext.getStore();
  if (!text(store?.reconciliationId)) return false;

  const state = text(input.state || 'processing').toLowerCase();
  const stage = text(input.stage || state).toLowerCase();
  const action = text(input.action || input.operation).toLowerCase();
  const requestId = requestIdOf(input);
  if (state !== 'queued' || stage !== 'scoutsrequests' || !RECONCILIATION_ENRICHMENT_ACTIONS.has(action) || !requestId) {
    return false;
  }

  if (!(store.enrichmentRequestIds instanceof Set)) store.enrichmentRequestIds = new Set();
  if (store.enrichmentRequestIds.has(requestId)) return false;
  store.enrichmentRequestIds.add(requestId);
  store.enrichmentRequestsStarted = store.enrichmentRequestIds.size;
  return true;
}

export function buildRequestActivityUpdate(input = {}) {
  if (!TABLE_NAME) return null;
  const requestId = requestIdOf(input);
  if (!requestId) return null;
  const rootRequestId = rootRequestIdOf(input) || requestId;
  const now = input.at instanceof Date ? input.at : new Date();
  const timestamp = now.toISOString();
  const state = text(input.state || 'processing').toLowerCase();
  const stage = text(input.stage || state) || state;
  const failure = input.failure && typeof input.failure === 'object' ? input.failure : null;
  const reconciliationId = reconciliationIdOf(input);
  const timelineEntry = JSON.stringify({
    state,
    stage,
    at: timestamp,
    ...(failure ? { failure: { type: text(failure.type) || 'PROCESSING_FAILED', message: text(failure.message) || null } } : {}),
  });
  const strictTerminal = input.strictTerminal === true;
  const attrs = {
    ':feed': { S: 'activity' }, ':updatedAt': { S: timestamp },
    ':createdAt': { S: text(input.createdAt) || timestamp }, ':state': { S: state }, ':stage': { S: stage },
    ':timeline': { L: [{ S: timelineEntry }] }, ':empty': { L: [] },
    ':expiresAt': { N: String(Math.floor(now.getTime() / 1000) + RETENTION_SECONDS) },
    ':priority': { N: String(PRIORITY[state] || 0) }, ':terminal': { S: TERMINAL.has(state) ? 'true' : 'false' },
    ':hex': itemValue(hexOf(input)), ':title': itemValue(titleOf(input)), ':action': itemValue(text(input.action || input.operation) || null),
    ':rootRequestId': itemValue(rootRequestId), ':reconciliationId': itemValue(reconciliationId),
    ':publication': itemValue(text(input.publication) || (state === 'completed' ? 'published' : null)),
    ':failureType': itemValue(failure ? text(failure.type) || 'PROCESSING_FAILED' : null),
    ':failureMessage': itemValue(failure ? text(failure.message) || null : null),
  };
  if (strictTerminal) {
    attrs[':notTerminal'] = { S: 'false' };
  } else {
    attrs[':completed'] = { S: 'completed' };
    attrs[':published'] = { S: 'published' };
    attrs[':needsAttention'] = { S: 'needs_attention' };
    attrs[':failed'] = { S: 'failed' };
    attrs[':manualReview'] = { S: 'manual_review' };
  }
  return {
    requestId, rootRequestId, state, stage, updatedAt: timestamp, reconciliationId,
    command: new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { requestId: { S: requestId } },
      UpdateExpression: 'SET feed = :feed, updatedAt = :updatedAt, createdAt = if_not_exists(createdAt, :createdAt), #state = :state, stage = :stage, timeline = list_append(if_not_exists(timeline, :empty), :timeline), expiresAt = :expiresAt, priority = :priority, terminal = :terminal, hex = if_not_exists(hex, :hex), title = if_not_exists(title, :title), #action = if_not_exists(#action, :action), rootRequestId = if_not_exists(rootRequestId, :rootRequestId), reconciliationId = if_not_exists(reconciliationId, :reconciliationId), publication = :publication, failureType = :failureType, failureMessage = :failureMessage',
      // A DLQ terminal state is authoritative over delayed processing updates. A
      // later successful publish/completion is the only permitted recovery path.
      ConditionExpression: strictTerminal
        ? 'attribute_not_exists(priority) OR (terminal = :notTerminal AND priority < :priority)'
        : 'attribute_not_exists(priority) OR priority <= :priority OR (#state IN (:needsAttention, :failed, :manualReview) AND (:state = :completed OR :state = :published))',
      ExpressionAttributeNames: { '#state': 'state', '#action': 'action' },
      ExpressionAttributeValues: attrs,
    }),
  };
}

export async function recordRequestActivity(input = {}) {
  // scouts-service calls this only after SQS SendMessage succeeds. Count the
  // publication before the best-effort ledger write so the per-invocation metric
  // remains exact even if DynamoDB activity persistence is temporarily degraded.
  trackReconciliationPublication(input);
  const update = buildRequestActivityUpdate(input);
  if (!update) return null;
  await client.send(update.command);
  return {
    requestId: update.requestId,
    rootRequestId: update.rootRequestId,
    state: update.state,
    stage: update.stage,
    updatedAt: update.updatedAt,
    reconciliationId: update.reconciliationId,
  };
}

export async function recordWorkerDeliveryExhausted(input = {}) {
  const update = buildRequestActivityUpdate({ ...input, strictTerminal: true });
  if (!update) return null;
  try {
    await client.send(update.command);
    return {
      requestId: update.requestId,
      rootRequestId: update.rootRequestId,
      state: update.state,
      stage: update.stage,
      updatedAt: update.updatedAt,
      recorded: true,
    };
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return {
        requestId: update.requestId,
        rootRequestId: update.rootRequestId,
        state: update.state,
        stage: update.stage,
        recorded: false,
      };
    }
    throw error;
  }
}

export async function listRequestActivity({ requestIds = [], rootRequestId = '', hex = '', states = [], cursor = null, limit = 50, activeOnly = false } = {}) {
  if (!TABLE_NAME) return { requests: [], nextCursor: null };
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  const normalizedIds = [...new Set((Array.isArray(requestIds) ? requestIds : []).map(text).filter(Boolean))];
  if (normalizedIds.length) {
    const results = await Promise.all(normalizedIds.slice(0, 50).map(async (requestId) => {
      const response = await client.send(new QueryCommand({ TableName: TABLE_NAME, KeyConditionExpression: 'requestId = :requestId', ExpressionAttributeValues: { ':requestId': { S: requestId } }, Limit: 1 }));
      return unmarshall(response.Items?.[0]);
    }));
    return { requests: results.filter((entry) => entry.requestId), nextCursor: null };
  }
  const values = { ':feed': { S: 'activity' } };
  const filters = [];
  if (text(rootRequestId)) { values[':rootRequestId'] = { S: text(rootRequestId) }; filters.push('rootRequestId = :rootRequestId'); }
  if (text(hex)) { values[':hex'] = { S: text(hex).toLowerCase() }; filters.push('hex = :hex'); }
  const allowedStates = [...new Set((Array.isArray(states) ? states : []).map((state) => text(state).toLowerCase()).filter(Boolean))];
  if (activeOnly) { values[':terminal'] = { S: 'false' }; filters.push('terminal = :terminal'); }
  if (allowedStates.length) {
    const predicates = allowedStates.slice(0, 8).map((state, index) => {
      const key = `:state${index}`;
      values[key] = { S: state };
      return `#state = ${key}`;
    });
    filters.push(`(${predicates.join(' OR ')})`);
  }
  const response = await client.send(new QueryCommand({
    TableName: TABLE_NAME, IndexName: 'activity-feed', KeyConditionExpression: 'feed = :feed',
    ...(filters.length ? { FilterExpression: filters.join(' AND '), ExpressionAttributeNames: { '#state': 'state' } } : {}),
    ExpressionAttributeValues: values, ScanIndexForward: false, Limit: safeLimit,
    ...(cursor ? { ExclusiveStartKey: JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } : {}),
  }));
  return { requests: (response.Items || []).map(unmarshall), nextCursor: response.LastEvaluatedKey ? Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString('base64url') : null };
}
