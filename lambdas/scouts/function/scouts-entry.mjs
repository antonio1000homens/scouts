import crypto from 'crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { getRequiredSecret } from '/opt/nodejs/ssm-secrets.mjs';
import { recordRequestActivity, withRequestActivityContext } from '/opt/nodejs/request-activity.mjs';
import {
  approvalIdempotencyKey,
  approvalOperationId,
  buildApprovedSnapshotPatch,
  compareEventReviewRevision,
} from '/opt/nodejs/event-review.mjs';
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
const TARGET_BUCKET = process.env.TARGET_BUCKET || '';
const SCOUTS_REQUESTS_QUEUE_URL = process.env.SCOUTS_REQUESTS_QUEUE_URL || '';
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

function normalizePrivateEventHex(value) {
  const hex = text(value).toLowerCase();
  if (!hex || hex.length % 2 !== 0 || hex.length > 512 || !/^[0-9a-f]+$/.test(hex)) {
    return '';
  }
  return hex;
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
  const isReconciliation = isAgendaReconciliationInvocation(event);
  const reconciliationContext = isReconciliation
    ? {
        reconciliationId: crypto.randomUUID(),
        enrichmentRequestsStarted: 0,
        enrichmentRequestIds: new Set(),
      }
    : null;
  const result = await callScoutsService(event, reconciliationContext);
  let responseResult = result;

  if (isCalendarRefreshInvocation(event)) {
    try {
      const repair = await repairAgendaHexMetadata();
      if (repair.repairedCount > 0 || repair.missingCount > 0) {
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
  if (command.subject === 'event' && command.action === 'get') return true;
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

async function publishApprovalMessage(payload, activityState = 'queued', activityStage = 'scoutsRequests') {
  if (!SCOUTS_REQUESTS_QUEUE_URL) {
    const error = new Error('SCOUTS_REQUESTS_QUEUE_URL is not configured');
    error.statusCode = 503;
    throw error;
  }
  const result = await sqs.send(new SendMessageCommand({
    QueueUrl: SCOUTS_REQUESTS_QUEUE_URL,
    MessageBody: JSON.stringify(payload),
  }));
  try {
    await recordRequestActivity({
      ...payload,
      messageId: result?.MessageId || null,
      state: activityState,
      stage: activityStage,
      title: payload?.title || payload?.subject?.title || null,
    });
  } catch (error) {
    // Queue publication is authoritative. Activity telemetry must never turn a
    // successful at-least-once delivery into a client retry that duplicates work.
    console.warn('[Approval] Unable to record request activity after queue publication', error?.message || error);
  }
  return result?.MessageId || null;
}

async function recordApprovalRoot({ rootRequestId, hex, title, state, stage, revision }) {
  try {
    await recordRequestActivity({
      requestId: rootRequestId,
      rootRequestId,
      hex,
      title,
      action: 'approve',
      state,
      stage,
      publication: null,
      approvalRevision: revision,
    });
  } catch (error) {
    console.warn('[Approval] Unable to record root workflow activity', error?.message || error);
  }
}

async function handleRevisionedApproval(event, command) {
  const requiredApiKey = await getRequiredSecret('REQUIRED_API_KEY_PARAMETER');
  if (!constantTimeEquals(getApiKey(event), requiredApiKey)) {
    return response(403, { status: 'error', error: 'Forbidden: Invalid API Key' });
  }

  const snapshot = command.reviewSnapshot;
  const hex = normalizePrivateEventHex(snapshot?.hex ?? command.body?.subject?.hex);
  if (!hex || normalizePrivateEventHex(snapshot?.hex) !== hex) {
    return response(400, { status: 'error', error: 'Approval review snapshot requires a valid canonical HEX' });
  }

  let patch;
  try {
    patch = buildApprovedSnapshotPatch(snapshot);
  } catch (error) {
    return response(400, { status: 'error', error: error?.message || 'Invalid approval review snapshot' });
  }

  const canonical = await readPrivateJsonObject(`events/${hex}.json`);
  if (!canonical) {
    return response(404, { status: 'error', error: 'Event object not found', hex });
  }

  const comparison = compareEventReviewRevision(canonical, snapshot.revision);
  if (!comparison.ok) {
    return response(409, {
      status: 'conflict',
      error: 'STALE_REVIEW',
      message: 'This event changed after the review was rendered. Reload the current review before approving.',
      submittedRevision: comparison.submittedRevision,
      currentRevision: comparison.currentRevision,
      currentReview: comparison.current,
    });
  }

  const requestedRoot = text(command.body?.rootRequestId || command.body?.operationId);
  const rootRequestId = requestedRoot || approvalOperationId({
    hex,
    revision: snapshot.revision,
    action: 'approve',
  });
  const idempotencyKey = approvalIdempotencyKey({
    rootRequestId,
    revision: snapshot.revision,
    action: 'approve',
  });
  const title = text(snapshot.title || canonical?.title || canonical?.summary) || null;
  const persistRequestId = `${rootRequestId}:persist`;

  const persistPayload = {
    realm: 'persist',
    action: 'persist',
    subject: { metadata: patch.metadata },
    hex,
    requestHex: hex,
    requestId: persistRequestId,
    rootRequestId,
    source: 'scouts-approval',
    title,
    approvalRevision: snapshot.revision,
    approvalState: patch.approval.nextState,
    approvalIdempotencyKey: idempotencyKey,
  };

  await publishApprovalMessage(persistPayload);

  const queuedMessages = [{
    requestId: persistRequestId,
    type: 'persist',
  }];

  if (patch.approval.requiresGeneratedImage) {
    const imageRequestId = `${rootRequestId}:image`;
    await publishApprovalMessage({
      realm: 'scoutsRequest',
      action: 'imageEnrich',
      subject: { hex },
      hex,
      requestHex: hex,
      requestId: imageRequestId,
      rootRequestId,
      source: 'scouts-approval',
      title,
      requestMode: 'auto',
      approvalMode: 'review_generated_image',
      approvalRevision: snapshot.revision,
      approvalIdempotencyKey: idempotencyKey,
    });
    queuedMessages.push({ requestId: imageRequestId, type: 'image' });
    await recordApprovalRoot({
      rootRequestId,
      hex,
      title,
      state: 'awaiting_image',
      stage: 'approval_accepted',
      revision: snapshot.revision,
    });
  } else {
    await recordApprovalRoot({
      rootRequestId,
      hex,
      title,
      state: 'processing',
      stage: 'approval_persisting',
      revision: snapshot.revision,
    });
  }

  return response(200, {
    status: 'ok',
    message: patch.approval.requiresGeneratedImage
      ? 'Approved shown metadata. Generating image — final review required.'
      : 'Approved shown changes.',
    queueAccepted: true,
    rootRequestId,
    requestId: rootRequestId,
    revision: snapshot.revision,
    workflowState: patch.approval.nextState,
    requiresGeneratedImage: patch.approval.requiresGeneratedImage,
    requiresFinalImageReview: patch.approval.requiresFinalImageReview,
    queuedMessages,
  });
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

    if (command.subject === 'event') {
      const hex = normalizePrivateEventHex(command.body?.hex);
      if (!hex) {
        return response(400, { status: 'error', error: 'Invalid event HEX' });
      }
      const eventObject = await readPrivateJsonObject(`events/${hex}.json`);
      if (!eventObject) {
        return response(404, { status: 'error', error: 'Event object not found' });
      }
      return response(200, { status: 'ok', event: eventObject });
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
