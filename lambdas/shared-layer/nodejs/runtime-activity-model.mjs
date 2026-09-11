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

function rootRequestIdOf(entry) {
  return text(entry?.rootRequestId) || text(entry?.operationId);
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
    published: 70,
    awaiting_review: 65,
    persisting: 60,
    awaiting_image: 55,
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

function isTerminalState(state) {
  return ['completed', 'needs_attention', 'manual_review', 'failed'].includes(state);
}

function isStepFunctionsLifecycle(entry) {
  return Boolean(text(entry?.executionArn));
}

function snapshotLifecycleState(entry, fallbackState) {
  const explicit = text(entry?.status).toLowerCase();
  return ['failed', 'manual_review', 'needs_attention', 'awaiting_image', 'awaiting_review'].includes(explicit)
    ? explicit
    : fallbackState;
}

function normaliseSnapshotEntry(entry, state, source) {
  const requestId = requestIdOf(entry);
  const rootRequestId = rootRequestIdOf(entry);
  const hex = hexOf(entry);
  if (!requestId && !rootRequestId && !hex) return null;
  const lifecycleState = snapshotLifecycleState(entry, state);
  const createdAt = iso(entry?.requestTime || entry?.createdAt || entry?.timestamp);
  const updatedAt = requestTimeOf(entry) || createdAt;
  return {
    requestId: requestId || null,
    rootRequestId: rootRequestId || null,
    childRequestIds: requestId ? [requestId] : [],
    hex: hex || null,
    subject: text(entry?.subject) || null,
    title: text(entry?.title || entry?.summary) || null,
    realm: text(entry?.realm) || null,
    operation: text(entry?.action || entry?.operation) || null,
    state: lifecycleState,
    stage: text(entry?.orchestrationStep) || lifecycleState,
    orchestrationType: text(entry?.orchestrationType) || null,
    createdAt,
    updatedAt,
    queueMessageIds: { [source]: text(entry?.messageId) || null },
    executionArn: null,
    failure: ['failed', 'manual_review', 'needs_attention'].includes(lifecycleState)
      ? {
          type: text(entry?.failure?.type) || 'PROCESSING_FAILED',
          message: text(entry?.failure?.message) || null,
        }
      : null,
    timeline: [{ state: lifecycleState, stage: text(entry?.orchestrationStep) || lifecycleState, at: updatedAt || createdAt, source }],
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

function mergeChildRequestIds(left = [], right = [], requestIds = []) {
  return [...new Set([...left, ...right, ...requestIds].map(text).filter(Boolean))];
}

function mergeLifecycle(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingExecution = isStepFunctionsLifecycle(existing);
  const incomingExecution = isStepFunctionsLifecycle(incoming);
  const existingPriority = lifecyclePriority(existing.state);
  const incomingPriority = lifecyclePriority(incoming.state);
  const bothTerminal = isTerminalState(existing.state) && isTerminalState(incoming.state);

  let preferIncoming;
  if (existingExecution || incomingExecution) {
    // Step Functions owns the end-to-end orchestration lifecycle. Runtime
    // "completed" snapshots only mean an individual worker message finished,
    // so they must never hide a still-running/deferred/failed execution.
    if (existingExecution && incomingExecution) {
      preferIncoming = timestamp(incoming.updatedAt) >= timestamp(existing.updatedAt);
    } else {
      preferIncoming = incomingExecution;
    }
  } else if (bothTerminal) {
    preferIncoming = timestamp(incoming.updatedAt) >= timestamp(existing.updatedAt);
  } else {
    preferIncoming = incomingPriority > existingPriority
      || (incomingPriority === existingPriority && timestamp(incoming.updatedAt) >= timestamp(existing.updatedAt));
  }

  const primary = preferIncoming ? incoming : existing;
  const secondary = preferIncoming ? existing : incoming;
  return {
    ...secondary,
    ...primary,
    requestId: primary.requestId || secondary.requestId || null,
    rootRequestId: primary.rootRequestId || secondary.rootRequestId || null,
    childRequestIds: mergeChildRequestIds(
      existing.childRequestIds,
      incoming.childRequestIds,
      [existing.requestId, incoming.requestId],
    ),
    hex: primary.hex || secondary.hex || null,
    title: primary.title || secondary.title || null,
    subject: primary.subject || secondary.subject || null,
    realm: primary.realm || secondary.realm || null,
    operation: primary.operation || secondary.operation || null,
    createdAt: [existing.createdAt, incoming.createdAt].filter(Boolean).sort((a, b) => timestamp(a) - timestamp(b))[0] || null,
    // updatedAt describes the currently selected lifecycle state, rather than
    // whichever telemetry source happened to write most recently.
    updatedAt: primary.updatedAt || secondary.updatedAt || null,
    queueMessageIds: { ...(existing.queueMessageIds || {}), ...(incoming.queueMessageIds || {}) },
    timeline: mergeTimeline(existing.timeline, incoming.timeline),
  };
}

function snapshotRequests(snapshot) {
  return Array.isArray(snapshot?.requests) ? snapshot.requests : [];
}

function canonicalKey(entry, fallbackIndex = 0) {
  if (entry?.rootRequestId) return `root:${entry.rootRequestId}`;
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
  if (!request?.hex) return null;
  const requestIds = new Set([
    request.requestId,
    ...(Array.isArray(request.childRequestIds) ? request.childRequestIds : []),
  ].map(text).filter(Boolean));
  if (!requestIds.size) return null;
  return historyForHex(durableHistories, request.hex).find((entry) => requestIds.has(text(entry?.requestId))) || null;
}

function executionStage(execution) {
  const explicit = text(execution?.currentStage || execution?.orchestrationStep);
  if (explicit) return explicit;
  const type = text(execution?.orchestrationType);
  return type === 'fullEnrich' ? 'full-enrich' : (type === 'imageEnrich' ? 'image-enrich' : 'workflow');
}

function executionState(execution, stage) {
  const status = text(execution?.status).toUpperCase();
  if (['FAILED', 'TIMED_OUT', 'ABORTED'].includes(status)) return 'needs_attention';

  const normalisedStage = text(stage).toLowerCase();
  if (normalisedStage === 'manual_review' || normalisedStage === 'awaiting_review') return 'awaiting_review';
  if (normalisedStage === 'awaiting_image') return 'awaiting_image';
  if (normalisedStage === 'waiting_for_retry') return 'waiting_for_retry';
  if (status === 'SUCCEEDED') return 'completed';
  if (normalisedStage === 'persisting') return 'persisting';
  if (normalisedStage === 'tagline') return 'waiting_for_tagline';
  if (normalisedStage === 'imagetheme') return 'waiting_for_image_theme';
  if (normalisedStage === 'image') return 'waiting_for_image';
  return 'orchestrating';
}

function queueEmpty(queue) {
  return queue?.ok === true
    && Number(queue?.visible || 0) === 0
    && Number(queue?.inFlight || 0) === 0
    && Number(queue?.delayed || 0) === 0;
}

function reconcileOrphanedTracking(request, queueHealth, nowMs) {
  if (!request?.updatedAt) return request;
  const ageMs = nowMs - timestamp(request.updatedAt);
  if (ageMs < 5 * 60 * 1000) return request;
  const queueName = request.state === 'queued' ? 'scoutsRequests' : (request.state === 'processing' ? 'scoutsProcessing' : null);
  if (!queueName || !queueEmpty(queueHealth?.[queueName])) return request;
  return {
    ...request,
    state: 'needs_attention',
    stage: 'tracking_orphaned',
    failure: {
      type: 'ORPHANED_TRACKING',
      message: `${queueName} is empty but this request has no later lifecycle evidence.`,
    },
    timeline: mergeTimeline(request.timeline, [{
      state: 'needs_attention',
      stage: 'tracking_orphaned',
      at: new Date(nowMs).toISOString(),
      source: 'queue-health',
    }]),
  };
}

function canCorrelateExecutionByHex(execution, request) {
  if (execution?.rootRequestId || request?.rootRequestId) return false;
  if (!execution?.hex || execution.hex !== request?.hex) return false;
  if (lifecyclePriority(request.state) >= lifecyclePriority('completed')) return false;

  const executionStartedAt = timestamp(execution?.startDate);
  const requestCreatedAt = timestamp(request?.createdAt || request?.updatedAt);
  if (!executionStartedAt || !requestCreatedAt) return true;

  // Legacy executions used an execution-derived request ID. Permit HEX fallback
  // only for requests started near that execution, preventing an old execution
  // for the same event from attaching to a newer admin request.
  return Math.abs(executionStartedAt - requestCreatedAt) <= 6 * 60 * 60 * 1000;
}

export function buildCanonicalActivity({
  queuedSnapshot = null,
  processingSnapshot = null,
  completedSnapshot = null,
  durableHistories = new Map(),
  executions = [],
  queueHealth = null,
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
    const rootRequestId = rootRequestIdOf(execution);
    const hex = text(execution?.hex).toLowerCase();
    const normalisedExecution = { ...execution, requestId, rootRequestId, hex };
    let key = rootRequestId ? `root:${rootRequestId}` : (requestId ? `request:${requestId}` : '');
    if (!key || !byKey.has(key)) {
      const candidates = [...byKey.entries()]
        .filter(([, item]) => canCorrelateExecutionByHex(normalisedExecution, item))
        .sort((a, b) => timestamp(b[1]?.updatedAt) - timestamp(a[1]?.updatedAt));
      key = candidates[0]?.[0] || key || `execution:${text(execution?.executionArn) || byKey.size}`;
    }
    const existing = byKey.get(key) || null;
    const stage = executionStage(execution);
    const state = executionState(execution, stage);
    const at = iso(execution?.updatedAt || execution?.stopDate || execution?.startDate) || now.toISOString();
    const executionEntry = {
      ...(existing || {}),
      requestId: existing?.requestId || requestId || null,
      rootRequestId: existing?.rootRequestId || rootRequestId || null,
      childRequestIds: mergeChildRequestIds(existing?.childRequestIds, [], [requestId]),
      hex: existing?.hex || hex || null,
      orchestrationType: text(execution?.orchestrationType) || existing?.orchestrationType || null,
      state,
      stage,
      executionArn: text(execution?.executionArn) || existing?.executionArn || null,
      executionStateName: text(execution?.stateName) || null,
      updatedAt: at,
      failure: state === 'needs_attention' ? {
        type: text(execution?.error || execution?.status) || 'FAILED',
        message: text(execution?.cause) || null,
      } : null,
      timeline: [{ state, stage, at, source: 'step-functions' }],
    };
    byKey.set(key, mergeLifecycle(existing, executionEntry));
  }

  const nowMs = now.getTime();
  return [...byKey.values()]
    .map((request) => reconcileOrphanedTracking(request, queueHealth, nowMs))
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
