import crypto from 'crypto';
import { getRequiredSecret } from '/opt/nodejs/ssm-secrets.mjs';
import { handler as legacyHandler } from './scouts.mjs';
import { buildRuntimeActivity } from './runtime-activity.mjs';

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

function isRuntimeActivityCommand(event) {
  const body = decodeBody(event);
  return text(body?.realm).toLowerCase() === 'runtime'
    && text(body?.subject).toLowerCase() === 'activity'
    && text(body?.action).toLowerCase() === 'status';
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
  if (!isRuntimeActivityCommand(event)) {
    return legacyHandler(event);
  }

  try {
    const requiredApiKey = await getRequiredSecret('REQUIRED_API_KEY_PARAMETER');
    if (!constantTimeEquals(getApiKey(event), requiredApiKey)) {
      return response(403, { status: 'error', error: 'Forbidden: Invalid API Key' });
    }
    const activity = await buildRuntimeActivity();
    return response(200, { status: 'ok', activity });
  } catch (error) {
    console.error('[RuntimeActivity] Failed to build admin activity status', error?.message || error);
    return response(503, {
      status: 'error',
      error: 'Runtime activity status unavailable',
      detail: error?.message || String(error),
    });
  }
}
