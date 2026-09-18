import crypto from 'crypto';
import { BatchGetItemCommand, DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { getRequiredSecret } from '/opt/nodejs/ssm-secrets.mjs';
import { recordRequestActivity, withRequestActivityContext } from '/opt/nodejs/request-activity.mjs';
import { coordinateEventApproval } from '/opt/nodejs/approval-coordinator.mjs';
import { buildEventReviewSnapshot } from '/opt/nodejs/event-review.mjs';
import { normaliseEnrichmentStage, retryManualReviewEnrichment } from '/opt/nodejs/enrichment-state.mjs';
import { repairAgendaHexMetadata } from './agenda-hex-repair.mjs';
import { handler as scoutsServiceHandler } from './scouts-service.mjs';
import { buildRuntimeActivity } from './runtime-activity.mjs';
import { inspectRuntimeDlq, redriveRuntimeDlq } from './runtime-dlq.mjs';
import {
  getScheduledRefreshSettings,
  getScheduledRefreshStatus,
  isScheduledRefreshInvocation,
  setScheduledRefreshEnabled,
} from './runtime-schedule.mjs';

const s3 = new S3Client({});
const sqs = new SQSClient({});
const dynamodb = new DynamoDBClient({});
const TARGET_BUCKET = process.env.TARGET_BUCKET || '';
const SCOUTS_REQUESTS_QUEUE_URL = process.env.SCOUTS_REQUESTS_QUEUE_URL || '';
const ENRICHMENT_STATE_TABLE_NAME = String(process.env.GEMINI_ENRICHMENT_STATE_TABLE_NAME || '').trim();
const REQUEST_ACTIVITY_TABLE_NAME = String(process.env.SCOUTS_REQUEST_ACTIVITY_TABLE_NAME || '').trim();
const ENRICHMENT_STAGES = Object.freeze(['tagline', 'imageTheme', 'image']);
const PRIVATE_RUNTIME_SNAPSHOT_KEYS = Object.freeze({
  queued: 'runtime/scoutsQueued.json',
  processing: 'runtime/scoutsProcessing.json',
  completed: 'runtime/scoutsComplete.json',
});

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function decodeBody(event) {
  const raw = event?.body;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const decoded = event?.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}

function getApiKey(event) {
  const headers = event?.headers || {};
  const query = event?.queryStringParameters || {};
  return text(
    headers['x-api-key']
    ?? headers['X-Api-Key']
    ?? headers['X-API-KEY']
    ?? query.apiKey
    ?? query.API_KEY
    ?? query['x-api-key']
    ?? null,
  );
}

function constantTimeEquals(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function privateObjectNotFound(error) {
  return error?.name === 'NoSuchKey'
    || error?.name === 'NotFound'
    || Number(error?.$metadata?.httpStatusCode) === 404;
}

async function readPrivateJsonObject(key) {
  if (!TARGET_BUCKET) {
    const error = new Error('TARGET_BUCKET is not configured');
    error.statusCode = 503;
    throw error;
  }

  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: TARGET_BUCKET, Key: key }));
    const raw = await result.Body.transformToString();
    return JSON.parse(raw);
  } catch (error) {
    if (privateObjectNotFound(error)) return null;
    throw error;
  }
}

async function listPrivateEventObjects() {
  if (!TARGET_BUCKET) {
    const error = new Error('TARGET_BUCKET is not configured');
    error.statusCode = 503;
    throw error;
  }

  const keys = [];
  let continuationToken;
  do {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: TARGET_BUCKET,
      Prefix: 'events/',
      ContinuationToken: continuationToken,
    }));
    for (const object of result?.Contents || []) {
      const key = text(object?.Key);
      if (/^events\/[0-9a-f]+\.json$/i.test(key)) keys.push(key);
    }
    continuationToken = result?.IsTruncated ? result?.NextContinuationToken : undefined;
  } while (continuationToken);

  const events = [];
  const batchSize = 20;
  for (let index = 0; index < keys.length; index += batchSize) {
    const batch = keys.slice(index, index + batchSize);
    const objects = await Promise.all(batch.map((key) => readPrivateJsonObject(key)));
    objects.forEach((eventObject, batchIndex) => {
      if (!eventObject || typeof eventObject !== 'object') return;
      const keyHex = batch[batchIndex].slice('events/'.length, -'.json'.length).toLowerCase();
      const metadata = eventObject.metadata && typeof eventObject.metadata === 'object'
        ? { ...eventObject.metadata }
        : {};
      metadata.hex = text(metadata.hex).toLowerCase() || keyHex;
      events.push({ ...eventObject, metadata });
    });
  }

  events.sort((left, right) => {
    const leftDate = text(left?.dtstart ?? left?.start?.sortKey ?? left?.start?.raw);
    const rightDate = text(right?.dtstart ?? right?.start?.sortKey ?? right?.start?.raw);
    if (leftDate && rightDate && leftDate !== rightDate) return leftDate.localeCompare(rightDate);
    if (leftDate && !rightDate) return -1;
    if (!leftDate && rightDate) return 1;
    return text(left?.summary ?? left?.title).localeCompare(text(right?.summary ?? right?.title));
  });

  return events;
}

function normalizePrivateEventHex(value) {
  const hex = text(value).toLowerCase();
  if (!hex || hex.length % 2 !== 0 || hex.length > 512 || !/^[0-9a-f]+$/.test(hex)) {
    return '';
  }
  return hex;
}

function unmarshallDurableEnrichmentItem(item = {}) {
  const result = {};
  for (const [key, value] of Object.entries(item || {})) {
    if (value?.S !== undefined) result[key] = value.S;
    else if (value?.N !== undefined) result[key] = Number(value.N);
    else if (value?.BOOL !== undefined) result[key] = value.BOOL;
    else if (value?.NULL) result[key] = null;
  }
  return result;
}

function presentDurableEnrichmentState(item) {
  if (!item || typeof item !== 'object') return null;
  const stage = normaliseEnrichmentStage(item.stage);
  const state = text(item.state).toLowerCase();
  if (!stage || !state) return null;
  const failureType = text(item.lastErrorType) || null;
  const failureMessage = text(item.lastErrorMessage) || null;
  const updatedAt = text(item.updatedAt) || null;
  return {
    stage,
    state,
    attemptCount: Number(item.attemptCount || 0),
    updatedAt,
    nextRetryAt: text(item.nextRetryAt) || null,
    failure: failureType || failureMessage
      ? { type: failureType, message: failureMessage, at: updatedAt }
      : null,
    recovery: state === 'manual_review'
      ? {
          type: 'enrichment_retry',
          available: true,
          action: 'retry',
          stage,
          label: `Retry ${stage} enrichment`,
          message: `Retry the ${stage} enrichment from durable manual-review state.`,
        }
      : null,
  };
}

async function loadDurableEnrichmentStatus(hexValues = []) {
  const hexes = [...new Set((Array.isArray(hexValues) ? hexValues : [hexValues])
    .map(normalizePrivateEventHex)
    .filter(Boolean))];
  const result = Object.fromEntries(hexes.map((hex) => [hex, {
    hex,
    stages: {},
    needsAttention: false,
    recoveries: [],
  }]));
  if (!ENRICHMENT_STATE_TABLE_NAME || hexes.length === 0) return result;

  const allKeys = hexes.flatMap((hex) => ENRICHMENT_STAGES.map((stage) => ({
    hex: dynamoString(hex),
    stage: dynamoString(stage),
  })));

  for (let offset = 0; offset < allKeys.length; offset += 100) {
    let pendingKeys = allKeys.slice(offset, offset + 100);
    for (let attempt = 0; pendingKeys.length && attempt < 4; attempt += 1) {
      const response = await dynamodb.send(new BatchGetItemCommand({
        RequestItems: {
          [ENRICHMENT_STATE_TABLE_NAME]: {
            Keys: pendingKeys,
            ConsistentRead: true,
          },
        },
      }));
      for (const rawItem of response?.Responses?.[ENRICHMENT_STATE_TABLE_NAME] || []) {
        const item = unmarshallDurableEnrichmentItem(rawItem);
        const hex = normalizePrivateEventHex(item.hex);
        const stageState = presentDurableEnrichmentState(item);
        if (!hex || !stageState || !result[hex]) continue;
        result[hex].stages[stageState.stage] = stageState;
      }
      pendingKeys = response?.UnprocessedKeys?.[ENRICHMENT_STATE_TABLE_NAME]?.Keys || [];
    }
    if (pendingKeys.length) {
      const error = new Error('Unable to read all enrichment-state rows');
      error.statusCode = 503;
      throw error;
    }
  }

  for (const entry of Object.values(result)) {
    entry.recoveries = Object.values(entry.stages)
      .filter((stageState) => stageState?.recovery?.available === true)
      .map((stageState) => stageState.recovery);
    entry.needsAttention = entry.recoveries.length > 0;
  }
  return result;
}

function runtimeCommand(body) {
  if (text(body?.realm).toLowerCase() !== 'runtime') return null;
  return {
    subject: text(body?.subject).toLowerCase(),
    action: text(body?.action).toLowerCase(),
    body,
  };
}

function revisionedApprovalCommand(body) {
  if (text(body?.realm).toLowerCase() !== 'scouts') return null;
  if (text(body?.action).toLowerCase() !== 'approve') return null;
  const reviewSnapshot = body?.reviewSnapshot
    ?? (body?.subject && typeof body.subject === 'object' ? body.subject.reviewSnapshot : null);
  if (!reviewSnapshot || typeof reviewSnapshot !== 'object') return null;
  return { body, reviewSnapshot };
}

function isCalendarRefreshInvocation(event) {
  const body = decodeBody(event);
  if (text(body?.realm).toLowerCase() !== 'scouts') return false;
  const subject = text(body?.subject).toLowerCase();
  const action = text(body?.action).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return ['calendar', 'calendars', 'all'].includes(subject) && action.startsWith('refresh');
}

function calendarSelectorTokens(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => calendarSelectorTokens(entry));
  if (typeof value === 'object') return [];
  const raw = text(value).toLowerCase();
  if (!raw) return [];
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      return calendarSelectorTokens(JSON.parse(raw));
    } catch {
      // Fall through to comma-separated parsing.
    }
  }
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function isFullCalendarRefreshInvocation(event) {
  if (!isCalendarRefreshInvocation(event)) return false;
  const body = decodeBody(event);
  const query = event?.queryStringParameters || {};
  const selectors = [
    ...calendarSelectorTokens(body?.calendar),
    ...calendarSelectorTokens(body?.calendars),
    ...calendarSelectorTokens(body?.feed),
    ...calendarSelectorTokens(query?.calendar),
    ...calendarSelectorTokens(query?.calendars),
    ...calendarSelectorTokens(query?.feed),
  ];
  // No selector means scouts-service resolves all configured feeds. An explicit
  // `all` selector is the other destructive-reconciliation-safe case.
  return selectors.length === 0 || selectors.includes('all');
}

function isAgendaRefreshInvocation(event) {
  const body = decodeBody(event);
  if (text(body?.realm).toLowerCase() !== 'scouts') return false;
  if (text(body?.subject).toLowerCase() !== 'agenda') return false;
  const action = body?.action;
  if (typeof action === 'number') return true;
  const normalizedAction = text(action).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return !normalizedAction || normalizedAction.startsWith('refresh') || /^\d+$/.test(normalizedAction);
}

function isAgendaReconciliationInvocation(event) {
  return isCalendarRefreshInvocation(event) || isAgendaRefreshInvocation(event);
}

function addEnrichmentAccounting(result, reconciliationContext) {
  const enrichmentRequestsStarted = Number.isFinite(Number(reconciliationContext?.enrichmentRequestsStarted))
    ? Number(reconciliationContext.enrichmentRequestsStarted)
    : 0;
  const accounting = {
    reconciliationId: text(reconciliationContext?.reconciliationId) || null,
    enrichmentRequestsStarted,
    enrichmentRequestAccountingSource: 'reconciliation-publication-context',
  };

  if (result && typeof result === 'object' && typeof result.body === 'string') {
    try {
      const body = JSON.parse(result.body);
      return {
        ...result,
        body: JSON.stringify({ ...body, ...accounting }),
      };
    } catch {
      return result;
    }
  }
  if (result && typeof result === 'object') {
    return { ...result, ...accounting };
  }
  return result;
}

async function callScoutsService(event, reconciliationContext = null) {
  if (!reconciliationContext) {
    // Keep the direct call explicit: scheduled-refresh safety contracts verify
    // the wrapper still delegates to the canonical service handler.
    const result = await scoutsServiceHandler(event);
    return result;
  }
  return withRequestActivityContext(
    reconciliationContext,
    () => scoutsServiceHandler(event),
  );
}

async function invokeScoutsService(event) {
  const isCalendarRefresh = isCalendarRefreshInvocation(event);
  const isFullCalendarRefresh = isFullCalendarRefreshInvocation(event);
  const isReconciliation = isAgendaReconciliationInvocation(event);
  const reconciliationContext = isReconciliation
    ? {
        reconciliationId: crypto.randomUUID(),
        enrichmentRequestsStarted: 0,
        enrichmentRequestIds: new Set(),
      }
    : null;

  // On full refreshes, reconcile against the last fresh complete cache before
  // enrichment starts. This prevents stable-UID title changes already present
  // in the cache from carrying title-keyed enrichment into the replacement.
  if (isFullCalendarRefresh) {
    try {
      await repairAgendaHexMetadata({
        allowSourceReconciliation: true,
        allowDestructiveReconciliation: false,
      });
    } catch (error) {
      console.warn('[AgendaHexRepair] Pre-refresh reconciliation skipped.', error?.message || error);
    }
  }

  const result = await callScoutsService(event, reconciliationContext);
  let responseResult = result;

  if (isCalendarRefresh) {
    try {
      const repair = await repairAgendaHexMetadata({
        // Targeted refreshes must not reconcile/prune unrelated source feeds.
        allowSourceReconciliation: isFullCalendarRefresh,
        allowDestructiveReconciliation: isFullCalendarRefresh,
      });
      if (
        repair.repairedCount > 0
        || repair.missingCount > 0
        || repair.prunedCount > 0
        || repair.renamedHexResetCount > 0
      ) {
        console.log('[AgendaHexRepair] Refresh post-processing result.', repair);
      }
    } catch (error) {
      // The calendar refresh itself has already completed. Keep its original
      // result, but make a failed canonical-HEX repair explicit in Lambda logs.
      console.error('[AgendaHexRepair] Unable to repair agenda HEX metadata after refresh.', error?.message || error);
    }
  }

  if (isReconciliation) {
    responseResult = addEnrichmentAccounting(result, reconciliationContext);
  }

  return responseResult;
}

function isInterceptedRuntimeCommand(command) {
  if (!command) return false;
  if (command.subject === 'activity' && ['status', 'history', 'lookup'].includes(command.action)) return true;
  if (command.subject === 'snapshot' && command.action === 'get') return true;
  if (command.subject === 'event' && ['get', 'review', 'list'].includes(command.action)) return true;
  if (command.subject === 'enrichment' && ['status', 'retry'].includes(command.action)) return true;
  if (command.subject === 'dlq' && ['inspect', 'redrive'].includes(command.action)) return true;
  return command.subject === 'schedule' && ['status', 'enable', 'disable'].includes(command.action);
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

function appendResponseBodyFields(result, extra) {
  if (!result || typeof result !== 'object' || typeof result.body !== 'string') return result;
  try {
    const body = JSON.parse(result.body);
    return { ...result, body: JSON.stringify({ ...body, ...extra }) };
  } catch {
    return result;
  }
}

function enrichmentRetrySubject(stage) {
  if (stage === 'image') return 'imageUrl';
  if (stage === 'tagline' || stage === 'imageTheme') return stage;
  return '';
}

function recoveryActivityId(body) {
  return text(body?.activityId || body?.requestId || body?.operationId);
}

function activityRecoveryCoordinates(request, recovery, activityId) {
  const hex = normalizePrivateEventHex(request.hex);
  const stage = normaliseEnrichmentStage(recovery.stage);
  const rootRequestId = text(request.rootRequestId || request.requestId || activityId);
  return { hex, stage, rootRequestId };
}

function activityMatchesId(request, activityId) {
  return text(request?.requestId) === activityId
    || text(request?.rootRequestId) === activityId
    || (Array.isArray(request?.childRequestIds) && request.childRequestIds.some((id) => text(id) === activityId));
}

async function loadRecoveryActivity(activityId) {
  let activity = await buildRuntimeActivity({ rootRequestId: activityId, limit: 50 });
  let request = activity.requests.find((candidate) => activityMatchesId(candidate, activityId));
  if (request) return request;

  activity = await buildRuntimeActivity({ requestIds: [activityId], limit: 50 });
  request = activity.requests.find((candidate) => activityMatchesId(candidate, activityId));
  return request || null;
}

function dynamoString(value) {
  return { S: String(value) };
}

function dynamoNumber(value) {
  return { N: String(value) };
}

async function restoreManualReviewAfterEnqueueFailure({ hex, stage, reset, error, now = new Date() }) {
  const retryCount = Number(reset?.state?.manualReviewRetryCount || 0);
  if (!ENRICHMENT_STATE_TABLE_NAME || !hex || !stage || !Number.isFinite(retryCount) || retryCount < 1) {
    return false;
  }

  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: ENRICHMENT_STATE_TABLE_NAME,
      Key: { hex: dynamoString(hex), stage: dynamoString(stage) },
      UpdateExpression: 'SET #state = :manualReview, #lastErrorType = :errorType, #lastErrorMessage = :errorMessage, #updatedAt = :now',
      ConditionExpression: '#state = :pending AND #manualReviewRetryCount = :retryCount',
      ExpressionAttributeNames: {
        '#state': 'state',
        '#lastErrorType': 'lastErrorType',
        '#lastErrorMessage': 'lastErrorMessage',
        '#updatedAt': 'updatedAt',
        '#manualReviewRetryCount': 'manualReviewRetryCount',
      },
      ExpressionAttributeValues: {
        ':manualReview': dynamoString('manual_review'),
        ':pending': dynamoString('pending'),
        ':retryCount': dynamoNumber(retryCount),
        ':errorType': dynamoString('MANUAL_RETRY_ENQUEUE_FAILED'),
        ':errorMessage': dynamoString(`Manual retry enqueue failed: ${String(error?.message || error || 'unknown error').slice(0, 420)}`),
        ':now': dynamoString(now.toISOString()),
      },
    }));
    return true;
  } catch (restoreError) {
    if (restoreError?.name === 'ConditionalCheckFailedException') return false;
    throw restoreError;
  }
}

async function reopenManualRecoveryActivity({ requestId, stage, now = new Date() }) {
  if (!REQUEST_ACTIVITY_TABLE_NAME || !requestId) return false;
  const at = now.toISOString();
  const timelineEntry = JSON.stringify({
    state: 'queued',
    stage: 'scoutsRequests',
    at,
    source: 'admin-manual-review-retry',
    recoveryStage: stage,
  });

  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: REQUEST_ACTIVITY_TABLE_NAME,
      Key: { requestId: dynamoString(requestId) },
      UpdateExpression: 'SET #state = :queued, stage = :stage, updatedAt = :now, priority = :priority, terminal = :notTerminal, timeline = list_append(if_not_exists(timeline, :empty), :timeline), publication = :nullValue, failureType = :nullValue, failureMessage = :nullValue',
      ConditionExpression: '#state = :manualReview',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':queued': dynamoString('queued'),
        ':stage': dynamoString('scoutsRequests'),
        ':now': dynamoString(at),
        ':priority': dynamoNumber(20),
        ':notTerminal': dynamoString('false'),
        ':empty': { L: [] },
        ':timeline': { L: [{ S: timelineEntry }] },
        ':nullValue': { NULL: true },
        ':manualReview': dynamoString('manual_review'),
      },
    }));
    return true;
  } catch (activityError) {
    if (activityError?.name === 'ConditionalCheckFailedException') return false;
    throw activityError;
  }
}

async function queueManualRecovery({ requestId, hex, retrySubject }) {
  if (!SCOUTS_REQUESTS_QUEUE_URL) {
    const error = new Error('SCOUTS_REQUESTS_QUEUE_URL is not configured');
    error.statusCode = 503;
    throw error;
  }

  const payload = {
    realm: 'scoutsRequest',
    subject: retrySubject,
    subjectLabel: retrySubject,
    hex,
    requestHex: hex,
    action: 'request',
    requestId,
    rootRequestId: requestId,
    source: 'admin-manual-review-retry',
    requestMode: 'manual',
    approvalMode: 'auto',
  };
  const sendResult = await sqs.send(new SendMessageCommand({
    QueueUrl: SCOUTS_REQUESTS_QUEUE_URL,
    MessageBody: JSON.stringify(payload),
  }));
  return { payload, messageId: text(sendResult?.MessageId) || null };
}

async function handleRevisionedApproval(event, command) {
  const requiredApiKey = await getRequiredSecret('REQUIRED_API_KEY_PARAMETER');
  if (!constantTimeEquals(getApiKey(event), requiredApiKey)) {
    return response(403, { status: 'error', error: 'Forbidden: Invalid API Key' });
  }

  const result = await coordinateEventApproval({
    reviewSnapshot: command.reviewSnapshot,
    baseRevision: command.body?.baseRevision || command.body?.reviewBaseRevision || command.reviewSnapshot?.baseRevision,
    rootRequestId: command.body?.rootRequestId || command.body?.operationId,
    source: 'scouts-approval',
  });

  if (!result.ok) {
    const { currentEvent: _privateCurrentEvent, ok: _ok, statusCode: _statusCode, ...publicResult } = result;
    return response(result.statusCode || 503, publicResult);
  }

  return response(200, result);
}

async function handleScheduledInvocation() {
  try {
    const schedule = await getScheduledRefreshSettings();
    if (!schedule.enabled) {
      console.log('[ScheduledRefresh] EventBridge invocation skipped because scheduled refresh is disabled.');
      return {
        status: 'disabled',
        scheduledRefresh: schedule,
      };
    }

    const requiredApiKey = await getRequiredSecret('REQUIRED_API_KEY_PARAMETER');
    const trustedInternalEvent = {
      requestContext: { http: { method: 'POST' } },
      headers: { 'x-api-key': requiredApiKey },
      body: JSON.stringify({
        realm: 'scouts',
        subject: 'calendars',
        action: 'refreshAllCalendars',
        calendar: 'all',
        maxEvents: schedule.maxQueuePublishesPerRun,
      }),
    };

    console.log('[ScheduledRefresh] Running EventBridge calendar refresh.', {
      scheduleExpression: schedule.scheduleExpression,
      maxQueuePublishesPerRun: schedule.maxQueuePublishesPerRun,
    });
    return invokeScoutsService(trustedInternalEvent);
  } catch (error) {
    // Fail closed: a schedule-state/secret read problem should not accidentally
    // trigger calendar/network/enrichment work. Returning successfully also
    // avoids an EventBridge retry storm while configuration is unavailable.
    console.error('[ScheduledRefresh] Unable to prepare scheduled refresh; skipping run.', error?.message || error);
    return {
      status: 'skipped',
      reason: 'schedule_state_unavailable',
      error: error?.message || String(error),
    };
  }
}

export async function handler(event = {}) {
  if (isScheduledRefreshInvocation(event)) {
    return handleScheduledInvocation();
  }

  const body = decodeBody(event);
  const approvalCommand = revisionedApprovalCommand(body);
  if (approvalCommand) {
    try {
      return await handleRevisionedApproval(event, approvalCommand);
    } catch (error) {
      const statusCode = Number.isFinite(Number(error?.statusCode)) ? Number(error.statusCode) : 503;
      console.error('[Approval] Revisioned approval failed', error?.message || error);
      return response(statusCode, {
        status: 'error',
        error: 'Approval workflow unavailable',
        detail: error?.message || String(error),
      });
    }
  }

  const command = runtimeCommand(body);
  if (!isInterceptedRuntimeCommand(command)) {
    return invokeScoutsService(event);
  }

  try {
    const requiredApiKey = await getRequiredSecret('REQUIRED_API_KEY_PARAMETER');
    if (!constantTimeEquals(getApiKey(event), requiredApiKey)) {
      return response(403, { status: 'error', error: 'Forbidden: Invalid API Key' });
    }

    if (command.subject === 'activity') {
      const activity = await buildRuntimeActivity({
        requestIds: command.action === 'lookup' ? command.body?.requestIds : undefined,
        rootRequestId: command.body?.rootRequestId || command.body?.operationId,
        hex: command.body?.hex,
        states: command.body?.states,
        cursor: command.action === 'history' ? command.body?.cursor : undefined,
        limit: command.action === 'history' ? command.body?.limit : 50,
        activeOnly: command.action === 'status' && command.body?.activeOnly === true,
      });
      return response(200, { status: 'ok', activity });
    }

    if (command.subject === 'snapshot') {
      const snapshotName = text(command.body?.snapshot).toLowerCase();
      const key = PRIVATE_RUNTIME_SNAPSHOT_KEYS[snapshotName];
      if (!key) {
        return response(400, { status: 'error', error: 'Unsupported runtime snapshot' });
      }
      const snapshot = await readPrivateJsonObject(key);
      if (!snapshot) {
        return response(404, { status: 'error', error: 'Runtime snapshot not found' });
      }
      return response(200, { status: 'ok', snapshot });
    }

    if (command.subject === 'enrichment' && command.action === 'status') {
      const requestedHexes = Array.isArray(command.body?.hexes)
        ? command.body.hexes
        : [command.body?.hex];
      const enrichment = await loadDurableEnrichmentStatus(requestedHexes);
      return response(200, { status: 'ok', enrichment });
    }

    if (command.subject === 'event') {
      if (command.action === 'list') {
        const events = await listPrivateEventObjects();
        return response(200, { status: 'ok', events, count: events.length });
      }

      const hex = normalizePrivateEventHex(command.body?.hex);
      if (!hex) {
        return response(400, { status: 'error', error: 'Invalid event HEX' });
      }
      const eventObject = await readPrivateJsonObject(`events/${hex}.json`);
      if (!eventObject) {
        return response(404, { status: 'error', error: 'Event object not found' });
      }
      if (command.action === 'review') {
        return response(200, {
          status: 'ok',
          review: buildEventReviewSnapshot(eventObject),
          approvalWorkflow: eventObject?.approvalWorkflow && typeof eventObject.approvalWorkflow === 'object'
            ? eventObject.approvalWorkflow
            : null,
        });
      }
      return response(200, { status: 'ok', event: eventObject });
    }

    if (command.subject === 'enrichment' && command.action === 'retry') {
      const activityId = recoveryActivityId(command.body);
      let request = null;
      let hex = '';
      let stage = '';
      let rootRequestId = '';

      if (activityId) {
        request = await loadRecoveryActivity(activityId);
        if (!request) {
          return response(404, { status: 'error', error: 'Activity record not found' });
        }

        const recovery = request.recovery;
        if (recovery?.type !== 'enrichment_retry' || recovery.available !== true) {
          return response(409, {
            status: 'error',
            error: recovery?.type === 'dlq_recovery'
              ? 'This failure must be recovered through Operations DLQ controls'
              : 'Manual recovery is not supported for this terminal failure',
            recovery: recovery || { type: 'unsupported', available: false, action: 'none' },
          });
        }

        ({ hex, stage, rootRequestId } = activityRecoveryCoordinates(request, recovery, activityId));
      } else {
        hex = normalizePrivateEventHex(command.body?.hex);
        stage = normaliseEnrichmentStage(command.body?.stage);
        rootRequestId = crypto.randomUUID();
      }

      const retrySubject = enrichmentRetrySubject(stage);
      if (!hex || !stage || !retrySubject || !rootRequestId) {
        return response(activityId ? 409 : 400, {
          status: 'error',
          error: activityId
            ? 'Activity recovery metadata is no longer valid'
            : 'A valid HEX and enrichment stage are required',
        });
      }

      // Re-read and conditionally reset the durable enrichment row. This remains
      // the concurrency gate: stale cards and double-clicks cannot reserve a
      // second retry once manual_review has already been reopened.
      const reset = await retryManualReviewEnrichment({
        hex,
        stage,
        requestedBy: 'admin',
      });
      if (!reset.reset) {
        const statusCode = reset.reason === 'not_found' ? 404 : reset.reason === 'invalid_request' ? 400 : 409;
        return response(statusCode, {
          status: 'error',
          error: reset.reason === 'not_found'
            ? 'Enrichment state not found'
            : reset.reason === 'not_manual_review'
              ? 'Enrichment stage is no longer in manual review'
              : reset.reason === 'state_changed'
                ? 'Enrichment state changed before retry could be reserved'
                : 'Enrichment retry could not be prepared',
          retry: { reset: false, reason: reset.reason, activityId },
        });
      }

      let queued;
      try {
        // Reuse the canonical root request ID so the recovered work continues
        // the same Activity lifecycle instead of creating a second operation.
        queued = await queueManualRecovery({ requestId: rootRequestId, hex, retrySubject });
      } catch (queueError) {
        let restored = false;
        try {
          restored = await restoreManualReviewAfterEnqueueFailure({ hex, stage, reset, error: queueError });
        } catch (restoreError) {
          console.error('[ManualRecovery] Failed to restore manual-review state after enqueue failure.', restoreError?.message || restoreError);
        }
        const error = new Error(restored
          ? 'Enrichment retry could not be queued; manual-review state was restored'
          : 'Enrichment retry could not be queued; recovery state requires inspection');
        error.statusCode = 503;
        throw error;
      }

      try {
        if (request) {
          await reopenManualRecoveryActivity({ requestId: rootRequestId, stage });
        } else {
          await recordRequestActivity({
            requestId: rootRequestId,
            rootRequestId,
            hex,
            action: 'request',
            state: 'queued',
            stage: 'scoutsRequests',
            at: new Date(),
          });
        }
      } catch (activityError) {
        // The queue submission is authoritative. If Activity persistence is
        // temporarily unavailable, downstream success/failure on the same root
        // request ID will still reconcile the operation later.
        console.warn('[ManualRecovery] Retry queued but Activity could not be recorded immediately.', activityError?.message || activityError);
      }

      return response(200, {
        status: 'ok',
        message: `${stage} enrichment retry queued`,
        requestId: rootRequestId,
        rootRequestId,
        queueAccepted: true,
        queuedMessageId: queued.messageId,
        retry: {
          reset: true,
          activityId: activityId || null,
          stage,
          retryCount: Number(reset.state?.manualReviewRetryCount || 1),
        },
      });
    }

    if (command.subject === 'schedule') {
      if (command.action === 'status') {
        const schedule = await getScheduledRefreshStatus();
        return response(200, {
          status: schedule.health === 'ok' ? 'ok' : 'degraded',
          schedule,
        });
      }
      const schedule = await setScheduledRefreshEnabled(command.action === 'enable', 'admin');
      return response(200, { status: 'ok', schedule });
    }

    const queueName = text(command.body?.queueName ?? command.body?.queue);
    if (command.action === 'inspect') {
      const dlq = await inspectRuntimeDlq(queueName, command.body?.maxMessages);
      return response(200, { status: 'ok', dlq });
    }

    const redrive = await redriveRuntimeDlq(queueName, command.body?.expectedVisible);
    return response(200, { status: 'ok', redrive });
  } catch (error) {
    const statusCode = Number.isFinite(Number(error?.statusCode)) ? Number(error.statusCode) : 503;
    const subject = command?.subject === 'dlq'
      ? 'DLQ diagnostics'
      : command?.subject === 'schedule'
        ? 'Scheduled refresh controls'
        : command?.subject === 'snapshot'
          ? 'Private runtime snapshot'
          : command?.subject === 'event'
            ? 'Private event object'
            : command?.subject === 'enrichment'
              ? 'Enrichment retry'
              : 'Runtime activity status';
    console.error(`[RuntimeActivity] ${subject} command failed`, error?.message || error);
    return response(statusCode, {
      status: 'error',
      error: `${subject} unavailable`,
      detail: error?.message || String(error),
      ...(Number.isFinite(Number(error?.currentVisible)) ? { currentVisible: Number(error.currentVisible) } : {}),
    });
  }
}
