import crypto from 'crypto';
import { getRequiredSecret } from '/opt/nodejs/ssm-secrets.mjs';
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

function runtimeCommand(body) {
  if (text(body?.realm).toLowerCase() !== 'runtime') return null;
  return {
    subject: text(body?.subject).toLowerCase(),
    action: text(body?.action).toLowerCase(),
    body,
  };
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

async function captureActivitySnapshot() {
  try {
    return await buildRuntimeActivity({ limit: 200 });
  } catch (error) {
    console.warn('[AgendaRefresh] Unable to capture request-activity snapshot for enrichment accounting.', error?.message || error);
    return null;
  }
}

function countNewEnrichmentRequests(beforeActivity, afterActivity, startedAtMs) {
  if (!beforeActivity || !afterActivity) return null;
  const beforeIds = new Set(
    (Array.isArray(beforeActivity.requests) ? beforeActivity.requests : [])
      .map((request) => text(request?.requestId))
      .filter(Boolean),
  );
  const validActions = new Set(['new', 'imageenrich']);
  let count = 0;
  for (const request of Array.isArray(afterActivity.requests) ? afterActivity.requests : []) {
    const requestId = text(request?.requestId);
    if (!requestId || beforeIds.has(requestId)) continue;
    const action = text(request?.action).toLowerCase();
    if (!validActions.has(action)) continue;
    const createdAtMs = Date.parse(request?.createdAt || '');
    if (Number.isFinite(createdAtMs) && createdAtMs < startedAtMs - 2000) continue;
    count += 1;
  }
  return count;
}

function addEnrichmentAccounting(result, enrichmentRequestsStarted) {
  const accounting = {
    enrichmentRequestsStarted,
    enrichmentRequestAccountingSource: enrichmentRequestsStarted === null ? 'unavailable' : 'request-activity-ledger',
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

async function invokeScoutsService(event) {
  const isReconciliation = isAgendaReconciliationInvocation(event);
  const startedAtMs = Date.now();
  const beforeActivity = isReconciliation ? await captureActivitySnapshot() : null;
  let result = await scoutsServiceHandler(event);

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
    const afterActivity = await captureActivitySnapshot();
    const enrichmentRequestsStarted = countNewEnrichmentRequests(beforeActivity, afterActivity, startedAtMs);
    result = addEnrichmentAccounting(result, enrichmentRequestsStarted);
  }

  return result;
}

function isInterceptedRuntimeCommand(command) {
  if (!command) return false;
  if (command.subject === 'activity' && ['status', 'history', 'lookup'].includes(command.action)) return true;
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

  const command = runtimeCommand(decodeBody(event));
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
        hex: command.body?.hex,
        states: command.body?.states,
        cursor: command.action === 'history' ? command.body?.cursor : undefined,
        limit: command.action === 'history' ? command.body?.limit : 50,
        activeOnly: command.action === 'status' && command.body?.activeOnly === true,
      });
      return response(200, { status: 'ok', activity });
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
