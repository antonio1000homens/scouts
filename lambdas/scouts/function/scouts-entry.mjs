import crypto from 'crypto';
import { getRequiredSecret } from '/opt/nodejs/ssm-secrets.mjs';
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

function isInterceptedRuntimeCommand(command) {
  if (!command) return false;
  if (command.subject === 'activity' && command.action === 'status') return true;
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
    return scoutsServiceHandler(trustedInternalEvent);
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
    return scoutsServiceHandler(event);
  }

  try {
    const requiredApiKey = await getRequiredSecret('REQUIRED_API_KEY_PARAMETER');
    if (!constantTimeEquals(getApiKey(event), requiredApiKey)) {
      return response(403, { status: 'error', error: 'Forbidden: Invalid API Key' });
    }

    if (command.subject === 'activity') {
      const activity = await buildRuntimeActivity();
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
