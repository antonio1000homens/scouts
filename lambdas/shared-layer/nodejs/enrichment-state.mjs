import crypto from 'crypto';
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const TABLE_NAME = String(process.env.GEMINI_ENRICHMENT_STATE_TABLE_NAME || '').trim();
const MAX_ATTEMPTS = Math.max(1, Math.floor(Number(process.env.GEMINI_MAX_ATTEMPTS_PER_STAGE || 3)));
const RETRY_DELAY_ATTEMPT_2_SECONDS = Math.max(0, Math.floor(Number(process.env.GEMINI_RETRY_DELAY_ATTEMPT_2_SECONDS || 3600)));
const RETRY_DELAY_ATTEMPT_3_SECONDS = Math.max(0, Math.floor(Number(process.env.GEMINI_RETRY_DELAY_ATTEMPT_3_SECONDS || 21600)));
const LEASE_SECONDS = Math.max(60, Math.floor(Number(process.env.GEMINI_IN_PROGRESS_LEASE_SECONDS || 1800)));
const TTL_DAYS = 90;
const defaultClient = new DynamoDBClient({ region: REGION });
let client = defaultClient;

export const ENRICHMENT_STAGES = Object.freeze(['tagline', 'imageTheme', 'image']);
export const ENRICHMENT_STATES = Object.freeze([
  'pending',
  'in_progress',
  'retry_wait',
  'succeeded',
  'persist_pending',
  'manual_review',
]);

function normalise(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function setEnrichmentStateClientForTests(nextClient) {
  if (!nextClient || typeof nextClient.send !== 'function') {
    throw new TypeError('Enrichment-state test client must expose send(command)');
  }
  client = nextClient;
}

export function resetEnrichmentStateClientForTests() {
  client = defaultClient;
}

export function normaliseEnrichmentStage(stage) {
  const candidate = normalise(stage);
  if (candidate === 'imageUrl') return 'image';
  return ENRICHMENT_STAGES.includes(candidate) ? candidate : null;
}

export function buildGenerationId(hex, stage, event = {}, promptVersion = '1') {
  const normalisedHex = normalise(hex).toLowerCase();
  const normalisedStage = normaliseEnrichmentStage(stage) || normalise(stage);
  const source = {
    title: event?.title ?? event?.summary ?? event?.name ?? null,
    description: event?.description ?? event?.details ?? null,
    location: event?.location ?? null,
    start: event?.start?.raw ?? event?.start?.sortKey ?? event?.start?.epochMillis ?? null,
    end: event?.end?.raw ?? event?.end?.sortKey ?? event?.end?.epochMillis ?? null,
    section: event?.section ?? event?.metadata?.section ?? null,
  };
  if (normalisedStage === 'image') {
    source.imageTheme = event?.image?.theme ?? event?.metadata?.image?.theme ?? null;
  }
  const input = {
    hex: normalisedHex,
    stage: normalisedStage,
    promptVersion: normalise(promptVersion) || '1',
    source,
  };
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function unmarshallItem(item) {
  if (!item) return null;
  const result = {};
  for (const [key, value] of Object.entries(item)) {
    if (value?.S !== undefined) result[key] = value.S;
    else if (value?.N !== undefined) result[key] = Number(value.N);
    else if (value?.BOOL !== undefined) result[key] = value.BOOL;
    else if (value?.NULL) result[key] = null;
  }
  if (typeof result.generatedValue === 'string') {
    try { result.generatedValue = JSON.parse(result.generatedValue); } catch (_) { /* keep legacy string */ }
  }
  return result;
}

function asString(value) { return { S: String(value) }; }
function asNumber(value) { return { N: String(value) }; }

export async function getEnrichmentState(hex, stage) {
  const normalisedHex = normalise(hex).toLowerCase();
  const normalisedStage = normaliseEnrichmentStage(stage);
  if (!TABLE_NAME || !normalisedHex || !normalisedStage) return null;
  const response = await client.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { hex: asString(normalisedHex), stage: asString(normalisedStage) },
    ConsistentRead: true,
  }));
  return unmarshallItem(response?.Item);
}

export function evaluateEnrichmentEligibility(state, now = new Date(), generationId = null) {
  if (!state) return { eligible: true, reason: null };
  if (state.state === 'manual_review') return { eligible: false, reason: 'manual_review' };
  if (state.state === 'succeeded' && state.geminiSucceeded !== false && (!generationId || state.generationId === generationId)) return { eligible: false, reason: 'already_succeeded' };
  if (Number(state.attemptCount || 0) >= MAX_ATTEMPTS && state.state !== 'succeeded') return { eligible: false, reason: 'max_attempts_reached' };
  if (state.state === 'in_progress' && Number(state.inProgressExpiresAt || 0) > now.getTime()) return { eligible: false, reason: 'in_progress' };
  if (state.state === 'retry_wait' && state.nextRetryAt) {
    const next = new Date(state.nextRetryAt).getTime();
    if (Number.isFinite(next) && now.getTime() < next) return { eligible: false, reason: 'cooldown_active' };
  }
  return { eligible: true, reason: null };
}

export function classifyGeminiError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.code);
  const message = String(error?.message || error || '').toLowerCase();
  if ([401, 403].includes(status) || /api.?key|unauthori[sz]|permission|billing|quota exceeded/.test(message)) return 'AUTH_FAILURE';
  if (status === 429 || /rate.?limit|too many requests/.test(message)) return 'RATE_LIMIT';
  if ([500, 502, 503, 504].includes(status) || /temporar|unavailable|internal server/.test(message)) return 'PROVIDER_5XX';
  if (/timeout|timed out|socket|econn|connection reset|network/.test(message)) return 'NETWORK_TIMEOUT';
  if (status === 404 || /model.*not found|not found/.test(message)) return 'MODEL_CONFIGURATION';
  if (/invalid|missing|required|unsupported|prompt/.test(message)) return 'INVALID_EVENT_DATA';
  return 'UNKNOWN';
}

export function retryDelaySeconds(attemptCount) {
  if (attemptCount <= 1) return RETRY_DELAY_ATTEMPT_2_SECONDS;
  return RETRY_DELAY_ATTEMPT_3_SECONDS;
}

export async function reserveEnrichmentAttempt({ hex, stage, generationId, requestId, now = new Date() }) {
  const normalisedHex = normalise(hex).toLowerCase();
  const normalisedStage = normaliseEnrichmentStage(stage);
  if (!TABLE_NAME || !normalisedHex || !normalisedStage) return { reserved: false, reason: 'state_table_not_configured' };
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const values = {
    ':inProgress': asString('in_progress'), ':manual': asString('manual_review'), ':max': asNumber(MAX_ATTEMPTS),
    ':zero': asNumber(0), ':one': asNumber(1), ':now': asString(nowIso), ':nowMs': asNumber(nowMs),
    ':lease': asNumber(nowMs + LEASE_SECONDS * 1000), ':generationId': asString(generationId || ''),
    ':requestId': asString(requestId || ''), ':expiresAt': asNumber(Math.floor(nowMs / 1000) + TTL_DAYS * 86400),
  };
  const existing = await getEnrichmentState(normalisedHex, normalisedStage).catch(() => null);
  if (existing?.state === 'succeeded' && existing.generationId && existing.generationId !== generationId) {
    try {
      await client.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: { hex: asString(normalisedHex), stage: asString(normalisedStage) },
        UpdateExpression: 'SET #state = :pending, #attemptCount = :zero, #generationId = :generationId, #updatedAt = :now REMOVE #geminiSucceeded, #generatedValue, #nextRetryAt, #inProgressExpiresAt',
        ConditionExpression: '#state = :succeeded AND #generationId = :previousGenerationId',
        ExpressionAttributeNames: { '#state': 'state', '#attemptCount': 'attemptCount', '#generationId': 'generationId', '#updatedAt': 'updatedAt', '#geminiSucceeded': 'geminiSucceeded', '#generatedValue': 'generatedValue', '#nextRetryAt': 'nextRetryAt', '#inProgressExpiresAt': 'inProgressExpiresAt' },
        ExpressionAttributeValues: { ':pending': asString('pending'), ':zero': asNumber(0), ':generationId': asString(generationId || ''), ':now': asString(nowIso), ':succeeded': asString('succeeded'), ':previousGenerationId': asString(existing.generationId) },
      }));
    } catch (error) {
      if (error?.name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  try {
    const response = await client.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { hex: asString(normalisedHex), stage: asString(normalisedStage) },
      UpdateExpression: 'SET #state = :inProgress, #attemptCount = if_not_exists(#attemptCount, :zero) + :one, #firstAttemptAt = if_not_exists(#firstAttemptAt, :now), #lastAttemptAt = :now, #inProgressExpiresAt = :lease, #generationId = :generationId, #lastRequestId = :requestId, #updatedAt = :now, #expiresAt = :expiresAt REMOVE #nextRetryAt',
      ConditionExpression: '(attribute_not_exists(#state) OR (#state <> :inProgress OR attribute_not_exists(#inProgressExpiresAt) OR #inProgressExpiresAt <= :nowMs)) AND (attribute_not_exists(#state) OR #state <> :manual) AND (attribute_not_exists(#attemptCount) OR #attemptCount < :max) AND (attribute_not_exists(#nextRetryAt) OR #nextRetryAt <= :now)',
      ExpressionAttributeNames: { '#state': 'state', '#attemptCount': 'attemptCount', '#firstAttemptAt': 'firstAttemptAt', '#lastAttemptAt': 'lastAttemptAt', '#inProgressExpiresAt': 'inProgressExpiresAt', '#generationId': 'generationId', '#lastRequestId': 'lastRequestId', '#updatedAt': 'updatedAt', '#expiresAt': 'expiresAt', '#nextRetryAt': 'nextRetryAt' },
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return { reserved: true, state: unmarshallItem(response?.Attributes) };
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      const current = await getEnrichmentState(normalisedHex, normalisedStage).catch(() => null);
      const evaluation = evaluateEnrichmentEligibility(current, now, generationId);
      return { reserved: false, reason: evaluation.reason || 'concurrent_reservation', state: current };
    }
    throw error;
  }
}

async function updateState(hex, stage, updateExpression, values, names, now = new Date()) {
  const normalisedHex = normalise(hex).toLowerCase();
  const normalisedStage = normaliseEnrichmentStage(stage);
  if (!TABLE_NAME || !normalisedHex || !normalisedStage) return null;
  const response = await client.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { hex: asString(normalisedHex), stage: asString(normalisedStage) },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: { ...values, ':updatedAt': asString(now.toISOString()), ':expiresAt': asNumber(Math.floor(now.getTime() / 1000) + TTL_DAYS * 86400) },
    ReturnValues: 'ALL_NEW',
  }));
  return unmarshallItem(response?.Attributes);
}

export async function markGeminiSucceeded({ hex, stage, generationId, generatedValue, now = new Date() }) {
  return updateState(hex, stage, 'SET #state = :state, #geminiSucceeded = :true, #generatedValue = :generatedValue, #generationId = :generationId, #updatedAt = :updatedAt, #expiresAt = :expiresAt REMOVE #inProgressExpiresAt, #nextRetryAt, #lastErrorType, #lastErrorMessage', {
    ':state': asString('persist_pending'), ':true': { BOOL: true }, ':generatedValue': asString(JSON.stringify(generatedValue)), ':generationId': asString(generationId),
  }, { '#state': 'state', '#geminiSucceeded': 'geminiSucceeded', '#generatedValue': 'generatedValue', '#generationId': 'generationId', '#updatedAt': 'updatedAt', '#expiresAt': 'expiresAt', '#inProgressExpiresAt': 'inProgressExpiresAt', '#nextRetryAt': 'nextRetryAt', '#lastErrorType': 'lastErrorType', '#lastErrorMessage': 'lastErrorMessage' }, now);
}

export async function markEnrichmentSucceeded({ hex, stage, generationId, now = new Date() }) {
  return updateState(hex, stage, 'SET #state = :state, #generationId = :generationId, #updatedAt = :updatedAt, #expiresAt = :expiresAt REMOVE #inProgressExpiresAt, #nextRetryAt', {
    ':state': asString('succeeded'), ':generationId': asString(generationId),
  }, { '#state': 'state', '#generationId': 'generationId', '#updatedAt': 'updatedAt', '#expiresAt': 'expiresAt', '#inProgressExpiresAt': 'inProgressExpiresAt', '#nextRetryAt': 'nextRetryAt' }, now);
}

export async function markEnrichmentFailure({ hex, stage, error, attemptCount, now = new Date() }) {
  const category = classifyGeminiError(error);
  const terminal = category === 'AUTH_FAILURE' || category === 'MODEL_CONFIGURATION' || category === 'INVALID_EVENT_DATA' || category === 'PROMPT_BUILD_FAILURE' || Number(attemptCount) >= MAX_ATTEMPTS;
  const state = terminal ? 'manual_review' : 'retry_wait';
  const nextRetryAt = terminal ? null : new Date(now.getTime() + retryDelaySeconds(Number(attemptCount) || 1) * 1000).toISOString();
  return updateState(hex, stage, terminal
    ? 'SET #state = :state, #lastErrorType = :errorType, #lastErrorMessage = :errorMessage, #updatedAt = :updatedAt, #expiresAt = :expiresAt REMOVE #inProgressExpiresAt, #nextRetryAt'
    : 'SET #state = :state, #lastErrorType = :errorType, #lastErrorMessage = :errorMessage, #nextRetryAt = :nextRetryAt, #updatedAt = :updatedAt, #expiresAt = :expiresAt REMOVE #inProgressExpiresAt', {
      ':state': asString(state), ':errorType': asString(category), ':errorMessage': asString(String(error?.message || error || '').slice(0, 500)), ...(nextRetryAt ? { ':nextRetryAt': asString(nextRetryAt) } : {}),
    }, { '#state': 'state', '#lastErrorType': 'lastErrorType', '#lastErrorMessage': 'lastErrorMessage', '#nextRetryAt': 'nextRetryAt', '#inProgressExpiresAt': 'inProgressExpiresAt', '#updatedAt': 'updatedAt', '#expiresAt': 'expiresAt' }, now);
}

export async function claimEnrichmentEscalation({ hex, stage, now = new Date() }) {
  const normalisedHex = normalise(hex).toLowerCase();
  const normalisedStage = normaliseEnrichmentStage(stage);
  if (!TABLE_NAME || !normalisedHex || !normalisedStage) return false;
  try {
    await client.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { hex: asString(normalisedHex), stage: asString(normalisedStage) },
      UpdateExpression: 'SET #escalatedAt = :escalatedAt, #updatedAt = :updatedAt, #expiresAt = :expiresAt',
      ConditionExpression: 'attribute_not_exists(#escalatedAt)',
      ExpressionAttributeNames: { '#escalatedAt': 'escalatedAt', '#updatedAt': 'updatedAt', '#expiresAt': 'expiresAt' },
      ExpressionAttributeValues: { ':escalatedAt': asString(now.toISOString()), ':updatedAt': asString(now.toISOString()), ':expiresAt': asNumber(Math.floor(now.getTime() / 1000) + TTL_DAYS * 86400) },
    }));
    return true;
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

export async function loadReusableGeneration({ hex, stage, generationId }) {
  const state = await getEnrichmentState(hex, stage);
  if (!state || state.generationId !== generationId || state.geminiSucceeded !== true || state.generatedValue === undefined) return null;
  return { state, generatedValue: state.generatedValue };
}

export async function resetEnrichmentState(hex, stage, now = new Date()) {
  return updateState(hex, stage, 'SET #state = :state, #attemptCount = :zero, #updatedAt = :updatedAt, #expiresAt = :expiresAt REMOVE #nextRetryAt, #inProgressExpiresAt, #geminiSucceeded, #generatedValue, #generationId', {
    ':state': asString('pending'), ':zero': asNumber(0),
  }, { '#state': 'state', '#attemptCount': 'attemptCount', '#updatedAt': 'updatedAt', '#expiresAt': 'expiresAt', '#nextRetryAt': 'nextRetryAt', '#inProgressExpiresAt': 'inProgressExpiresAt', '#geminiSucceeded': 'geminiSucceeded', '#generatedValue': 'generatedValue', '#generationId': 'generationId' }, now);
}

export const enrichmentStateConfig = Object.freeze({ TABLE_NAME, MAX_ATTEMPTS, RETRY_DELAY_ATTEMPT_2_SECONDS, RETRY_DELAY_ATTEMPT_3_SECONDS, LEASE_SECONDS });
