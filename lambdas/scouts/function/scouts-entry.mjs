import crypto from 'crypto';
import { getRequiredSecret } from '/opt/nodejs/ssm-secrets.mjs';
import { handler as legacyHandler } from './scouts.mjs';
import { buildRuntimeActivity } from './runtime-activity.mjs';
import { inspectRuntimeDlq, redriveRuntimeDlq } from './runtime-dlq.mjs';

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
  return command.subject === 'dlq' && ['inspect', 'redrive'].includes(command.action);
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

export async function handler(event = {}) {
  const command = runtimeCommand(decodeBody(event));
  if (!isInterceptedRuntimeCommand(command)) {
    return legacyHandler(event);
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

    const queueName = text(command.body?.queueName ?? command.body?.queue);
    if (command.action === 'inspect') {
      const dlq = await inspectRuntimeDlq(queueName, command.body?.maxMessages);
      return response(200, { status: 'ok', dlq });
    }

    const redrive = await redriveRuntimeDlq(queueName, command.body?.expectedVisible);
    return response(200, { status: 'ok', redrive });
  } catch (error) {
    const statusCode = Number.isFinite(Number(error?.statusCode)) ? Number(error.statusCode) : 503;
    const subject = command?.subject === 'dlq' ? 'DLQ diagnostics' : 'Runtime activity status';
    console.error(`[RuntimeActivity] ${subject} command failed`, error?.message || error);
    return response(statusCode, {
      status: 'error',
      error: `${subject} unavailable`,
      detail: error?.message || String(error),
      ...(Number.isFinite(Number(error?.currentVisible)) ? { currentVisible: Number(error.currentVisible) } : {}),
    });
  }
}
