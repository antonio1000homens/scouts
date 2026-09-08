import { DynamoDBClient, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const TABLE_NAME = String(process.env.SCOUTS_REQUEST_ACTIVITY_TABLE_NAME || '').trim();
const RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MAX_TIMELINE = 24;
const client = new DynamoDBClient({ region: REGION });

const TERMINAL = new Set(['completed', 'failed', 'needs_attention', 'manual_review']);
const PRIORITY = Object.freeze({ accepted: 10, queued: 20, processing: 40, orchestrating: 50, persisting: 60, published: 70, completed: 80, failed: 90, needs_attention: 100, manual_review: 100 });

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
function itemValue(value) { return value == null ? { NULL: true } : { S: String(value) }; }
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

export async function recordRequestActivity(input = {}) {
  if (!TABLE_NAME) return null;
  const requestId = requestIdOf(input);
  if (!requestId) return null;
  const now = input.at instanceof Date ? input.at : new Date();
  const timestamp = now.toISOString();
  const state = text(input.state || 'processing').toLowerCase();
  const stage = text(input.stage || state) || state;
  const failure = input.failure && typeof input.failure === 'object' ? input.failure : null;
  const timelineEntry = JSON.stringify({ state, stage, at: timestamp, ...(failure ? { failure: { type: text(failure.type) || 'PROCESSING_FAILED', message: text(failure.message) || null } } : {}) });
  const attrs = {
    ':requestId': { S: requestId }, ':feed': { S: 'activity' }, ':updatedAt': { S: timestamp },
    ':createdAt': { S: text(input.createdAt) || timestamp }, ':state': { S: state }, ':stage': { S: stage },
    ':timeline': { L: [{ S: timelineEntry }] }, ':empty': { L: [] },
    ':expiresAt': { N: String(Math.floor(now.getTime() / 1000) + RETENTION_SECONDS) },
    ':priority': { N: String(PRIORITY[state] || 0) }, ':terminal': { S: TERMINAL.has(state) ? 'true' : 'false' },
    ':hex': itemValue(hexOf(input)), ':title': itemValue(titleOf(input)), ':action': itemValue(text(input.action || input.operation) || null),
    ':publication': itemValue(text(input.publication) || (state === 'completed' ? 'published' : null)),
    ':failureType': itemValue(failure ? text(failure.type) || 'PROCESSING_FAILED' : null),
    ':failureMessage': itemValue(failure ? text(failure.message) || null : null),
  };
  await client.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { requestId: { S: requestId } },
    UpdateExpression: 'SET feed = :feed, updatedAt = :updatedAt, createdAt = if_not_exists(createdAt, :createdAt), #state = :state, stage = :stage, timeline = list_append(if_not_exists(timeline, :empty), :timeline), expiresAt = :expiresAt, priority = :priority, terminal = :terminal, hex = if_not_exists(hex, :hex), title = if_not_exists(title, :title), #action = if_not_exists(#action, :action), publication = :publication, failureType = :failureType, failureMessage = :failureMessage',
    ConditionExpression: 'attribute_not_exists(priority) OR priority <= :priority',
    ExpressionAttributeNames: { '#state': 'state', '#action': 'action' },
    ExpressionAttributeValues: attrs,
  }));
  return { requestId, state, stage, updatedAt: timestamp };
}

export async function listRequestActivity({ requestIds = [], hex = '', states = [], cursor = null, limit = 50, activeOnly = false } = {}) {
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
