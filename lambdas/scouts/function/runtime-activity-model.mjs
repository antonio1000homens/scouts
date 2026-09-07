function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function timestamp(value) {
  const candidate = text(value);
  if (!candidate) return 0;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value) {
  const ms = timestamp(value);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

function requestIdOf(entry) {
  return text(entry?.requestId) || text(entry?.messageId);
}

function hexOf(entry) {
  return text(entry?.hex || entry?.requestHex).toLowerCase();
}

function requestTimeOf(entry) {
  return iso(entry?.completedAt || entry?.processedAt || entry?.updatedAt || entry?.requestTime || entry?.timestamp);
}

function lifecyclePriority(state) {
  const priorities = {
    needs_attention: 100,
    manual_review: 95,
    failed: 90,
    completed: 80,
    persisting: 60,
    waiting_for_image: 55,
    waiting_for_image_theme: 54,
    waiting_for_tagline: 53,
    orchestrating: 50,
    processing: 40,
    waiting_for_retry: 35,
    queued: 20,
    accepted: 10,
  };
  return priorities[state] || 0;
}

function normaliseSnapshotEntry(entry, state, source) {
  const requestId = requestIdOf(entry);
  const hex = hexOf(entry);
  if (!requestId && !hex) return null;
  const createdAt = iso(entry?.requestTime || entry?.createdAt || entry?.timestamp);
  const updatedAt = requestTimeOf(entry) || createdAt;
  return {
    requestId: requestId || null,
    hex: hex || null,
    subject: text(entry?.subject) || null,
    title: text(entry?.title || entry?.summary) || null,
    realm: text(entry?.realm) || null,
    operation: text(entry?.action || entry?.operation) || null,
    state,
    stage: text(entry?.orchestrationStep) || state,
    orchestrationType: text(entry?.orchestrationType) || null,
    createdAt,
    updatedAt,
    queueMessageIds: { [source]: text(entry?.messageId) || null },
    executionArn: null,
    failure: null,
    timeline: [{ state, stage: text(entry?.orchestrationStep) || state, at: updatedAt || createdAt, source }],
  };
}

function mergeTimeline(left = [], right = []) {
  const byKey = new Map();
  for (const item of [...left, ...right]) {
    if (!item || typeof item !== 'object') continue;
    const key = `${item.state || ''}|${item.stage || ''}|${item.at || ''}|${item.source || ''}`;
    byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) => timestamp(a?.at) - timestamp(b?.at));
}

function mergeLifecycle(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const existingPriority = lifecyclePriority(existing.state);
  const incomingPriority = lifecyclePriority(incoming.state);
  const preferIncoming = incomingPriority > existingPriority
    || (incomingPriority === existingPriority && timestamp(incoming.updatedAt) >= timestamp(existing.updatedAt));
  const primary = preferIncoming ? incoming : existing;
  const secondary = preferIncoming ? existing : incoming;
  return {
    ...secondary,
    ...primary,
    requestId: primary.requestId || secondary.requestId || null,
    hex: primary.hex || secondary.hex || null,
    title: primary.title || secondary.title || null,
    subject: primary.subject || secondary.subject || null,
    realm: primary.realm || secondary.realm || null,
    operation: primary.operation || secondary.operation || null,
    createdAt: [existing.createdAt, incoming.createdAt].filter(Boolean).sort((a, b) => timestamp(a) - timestamp(b))[0] || null,
    updatedAt: [existing.updatedAt, incoming.updatedAt].filter(Boolean).sort((a, b) => timestamp(b) - timestamp(a))[0] || null,
    queueMessageIds: { ...(existing.queueMessageIds || {}), ...(incoming.queueMessageIds || {}) },
    timeline: mergeTimeline(existing.timeline, incoming.timeline),
  };
}

function snapshotRequests(snapshot) {
  return Array.isArray(snapshot?.requests) ? snapshot.requests : [];
}

function canonicalKey(entry, fallbackIndex = 0) {
  if (entry?.requestId) return `request:${entry.requestId}`;
  if (entry?.hex) return `hex:${entry.hex}|${entry.realm || ''}|${entry.operation || ''}`;
  return `anonymous:${fallbackIndex}`;
}

function historyForHex(durableHistories, hex) {
  if (!durableHistories || !hex) return [];
  if (durableHistories instanceof Map) return durableHistories.get(hex) || [];
  return durableHistories[hex] || [];
}

function findDurableCompletion(request, durableHistories) {
  if (!request?.requestId || !request?.hex) return null;
  return historyForHex(durableHistories, request.hex).find((entry) => text(entry?.requestId) === request.requestId) || null;
}

function executionState(execution) {
  const status = text(execution?.status).toUpperCase();
  if (['FAILED', 'TIMED_OUT', 'ABORTED'].includes(status)) return 'needs_attention';
  if (status === 'SUCCEEDED') return 'completed';
  return 'orchestrating';
}

function executionStage(execution) {
  const explicit = text(execution?.currentStage || execution?.orchestrationStep);
  if (explicit) return explicit;
  const type = text(execution?.orchestrationType);
  return type === 'fullEnrich' ? 'full-enrich' : (type === 'imageEnrich' ? 'image-enrich' : 'workflow');
}

export function buildCanonicalActivity({
  queuedSnapshot = null,
  processingSnapshot = null,
  completedSnapshot = null,
  durableHistories = new Map(),
  executions = [],
  now = new Date(),
  limit = 50,
} = {}) {
  const byKey = new Map();
  const add = (entry) => {
    if (!entry) return;
    const key = canonicalKey(entry, byKey.size);
    byKey.set(key, mergeLifecycle(byKey.get(key), entry));
  };

  snapshotRequests(queuedSnapshot).forEach((entry) => add(normaliseSnapshotEntry(entry, 'queued', 'requests')));
  snapshotRequests(processingSnapshot).forEach((entry) => add(normaliseSnapshotEntry(entry, 'processing', 'processing')));
  snapshotRequests(completedSnapshot).forEach((entry) => add(normaliseSnapshotEntry(entry, 'completed', 'completed')));

  for (const [key, request] of byKey.entries()) {
    const durable = findDurableCompletion(request, durableHistories);
    if (!durable) continue;
    const at = iso(durable.timestamp || durable.appliedAt) || request.updatedAt;
    byKey.set(key, mergeLifecycle(request, {
      ...request,
      state: 'completed',
      stage: text(durable.status) || 'persisted',
      updatedAt: at,
      timeline: [{ state: 'completed', stage: text(durable.status) || 'persisted', at, source: 'event-history' }],
    }));
  }

  for (const execution of Array.isArray(executions) ? executions : []) {
    const requestId = text(execution?.requestId);
    const hex = text(execution?.hex).toLowerCase();
    let key = requestId ? `request:${requestId}` : '';
    if (!key || !byKey.has(key)) {
      const candidates = [...byKey.entries()]
        .filter(([, item]) => hex && item.hex === hex && lifecyclePriority(item.state) < lifecyclePriority('completed'))
        .sort((a, b) => timestamp(b[1]?.updatedAt) - timestamp(a[1]?.updatedAt));
      key = candidates[0]?.[0] || key || `execution:${text(execution?.executionArn) || byKey.size}`;
    }
    const existing = byKey.get(key) || null;
    const state = executionState(execution);
    const stage = executionStage(execution);
    const at = iso(execution?.updatedAt || execution?.startDate) || now.toISOString();
    const executionEntry = {
      ...(existing || {}),
      requestId: existing?.requestId || requestId || null,
      hex: existing?.hex || hex || null,
      orchestrationType: text(execution?.orchestrationType) || existing?.orchestrationType || null,
      state,
      stage,
      executionArn: text(execution?.executionArn) || existing?.executionArn || null,
      updatedAt: at,
      failure: state === 'needs_attention' ? {
        type: text(execution?.status) || 'FAILED',
        message: text(execution?.error || execution?.cause) || null,
      } : null,
      timeline: [{ state, stage, at, source: 'step-functions' }],
    };
    byKey.set(key, mergeLifecycle(existing, executionEntry));
  }

  const nowMs = now.getTime();
  return [...byKey.values()]
    .map((request) => ({
      ...request,
      ageSeconds: request.updatedAt ? Math.max(0, Math.floor((nowMs - timestamp(request.updatedAt)) / 1000)) : null,
      health: request.state === 'needs_attention' || request.state === 'manual_review' || request.state === 'failed'
        ? 'needs_attention'
        : 'unknown',
    }))
    .sort((a, b) => timestamp(b.updatedAt || b.createdAt) - timestamp(a.updatedAt || a.createdAt))
    .slice(0, limit);
}
