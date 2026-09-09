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
  const payload = parseJson(record.body || record.Body);
  if (!payload || typeof payload !== 'object') return null;

  const subject = payload.subject;
  const requestId = text(
    payload.requestId || payload.metadata?.requestId || subject?.requestId || payload.message?.requestId,
  );
  if (!requestId) return null;

  const hex = text(
    payload.hex || payload.hexId || payload.requestHex || payload.metadata?.hex || subjectHex(subject),
  ).toLowerCase();
  const title = text(
    payload.title || payload.summary || subject?.title || subject?.summary || subject?.name,
  );
  const action = text(payload.action || payload.operation || payload.message?.action);

  return {
    requestId,
    hex: /^[0-9a-f]+$/i.test(hex) ? hex : null,
    title: title || null,
    action: action || null,
    state: 'needs_attention',
    stage: 'scoutsProcessingDLQ',
    publication: 'failed',
    failure: {
      type: 'WORKER_DELIVERY_EXHAUSTED',
      message: 'Delivery to the Scouts worker exhausted its retry limit. Inspect Operations before redriving this request.',
    },
  };
}
