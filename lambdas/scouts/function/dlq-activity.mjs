import { createHash } from 'node:crypto';

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function parseJson(value) {
  try {
    return JSON.parse(text(value));
  } catch {
    return null;
  }
}

function subjectHex(subject) {
  if (subject && typeof subject === 'object') {
    return text(subject.hex || subject.hexId || subject.requestHex).toLowerCase();
  }
  const candidate = text(subject).toLowerCase();
  return /^[0-9a-f]+$/i.test(candidate) ? candidate : '';
}

export function activityInputFromDlqRecord(record = {}) {
  const messageId = text(record.messageId || record.messageID);
  if (!messageId) return null;

  const payload = parseJson(record.body || record.Body);
  const validPayload = Boolean(payload && typeof payload === 'object' && !Array.isArray(payload));

  const subject = validPayload ? payload.subject : null;
  const requestId = text(
    payload?.requestId || payload?.metadata?.requestId || subject?.requestId || payload?.message?.requestId,
  );
  const trackableRequestId = requestId || `dlq-malformed#${createHash('sha256').update(messageId).digest('hex')}`;

  const hex = text(
    payload?.hex || payload?.hexId || payload?.requestHex || payload?.metadata?.hex || subjectHex(subject),
  ).toLowerCase();
  const title = text(
    payload?.title || payload?.summary || subject?.title || subject?.summary || subject?.name,
  );
  const action = text(payload?.action || payload?.operation || payload?.message?.action);
  const failureType = requestId
    ? 'WORKER_DELIVERY_EXHAUSTED'
    : (validPayload ? 'WORKER_DELIVERY_MISSING_REQUEST_ID' : 'WORKER_DELIVERY_INVALID_PAYLOAD');
  const failureMessage = requestId
    ? 'Delivery to the Scouts worker exhausted its retry limit. Inspect Operations before redriving this request.'
    : (validPayload
      ? 'Delivery to the Scouts worker exhausted its retry limit, but the message had no request ID. Inspect Operations using the DLQ message ID.'
      : 'Delivery to the Scouts worker exhausted its retry limit, but the message payload was invalid. Inspect Operations using the DLQ message ID.');

  return {
    requestId: trackableRequestId,
    hex: /^[0-9a-f]+$/i.test(hex) ? hex : null,
    title: title || null,
    action: requestId ? (action || null) : null,
    state: 'needs_attention',
    stage: 'scoutsProcessingDLQ',
    publication: 'failed',
    failure: {
      type: failureType,
      message: failureMessage,
    },
  };
}
