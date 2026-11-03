const ACTIVE_STATES = new Set([
  'accepted',
  'queued',
  'processing',
  'orchestrating',
  'persisting',
  'published',
  'waiting_for_retry',
  'awaiting_image',
  'awaiting_review',
]);

const IMAGE_ENRICH_STAGES = new Set([
  'full_enrich',
  'imageenrich',
  'tagline',
  'imagetheme',
  'image',
]);

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Index only current, nonterminal image-enrichment activity. The activity
 * ledger can enrich a live Step Functions execution, but it never determines
 * whether that execution is active; ListExecutions remains authoritative.
 */
export function buildImageEnrichRuntimeStageIndex(requests = []) {
  const byRequestId = new Map();
  const byRootRequestId = new Map();
  const byHex = new Map();

  for (const request of Array.isArray(requests) ? requests : []) {
    if (!request || typeof request !== 'object') continue;
    const state = text(request.state).toLowerCase();
    const stage = text(request.stage);
    if (!ACTIVE_STATES.has(state) || !IMAGE_ENRICH_STAGES.has(stage.toLowerCase())) continue;

    const record = {
      currentStage: stage,
      workerStatus: state,
      requestId: text(request.requestId) || null,
      rootRequestId: text(request.rootRequestId || request.operationId) || null,
      updatedAt: text(request.updatedAt || request.createdAt) || null,
      timestampValue: timestamp(request.updatedAt || request.createdAt),
    };

    const keys = [
      [byRequestId, record.requestId],
      [byRootRequestId, record.rootRequestId],
      [byHex, text(request.hex).toLowerCase()],
    ];
    for (const [index, key] of keys) {
      if (!key) continue;
      const existing = index.get(key);
      if (!existing || existing.timestampValue <= record.timestampValue) index.set(key, record);
    }
  }

  return { byRequestId, byRootRequestId, byHex };
}

export function findImageEnrichRuntimeStage(index, executionInput = {}, executionStartedAt = null) {
  if (!index || typeof index !== 'object') return null;
  const requestId = text(executionInput.requestId);
  const rootRequestId = text(executionInput.rootRequestId || executionInput.operationId);
  const startedAtMs = timestamp(executionStartedAt);
  const currentForExecution = (record) => {
    if (!record) return null;
    if (startedAtMs && record.timestampValue && record.timestampValue < startedAtMs - 2 * 60 * 1000) return null;
    return record;
  };
  if (rootRequestId && index.byRootRequestId?.has(rootRequestId)) {
    return currentForExecution(index.byRootRequestId.get(rootRequestId));
  }
  if (requestId && index.byRequestId?.has(requestId)) {
    return currentForExecution(index.byRequestId.get(requestId));
  }

  // Older executions did not carry a request ID. HEX is a display-only
  // fallback and must never cause a new execution to inherit a stale stage.
  if (!requestId && !rootRequestId) {
    const hex = text(executionInput.requestHex || executionInput.hex).toLowerCase();
    return hex ? currentForExecution(index.byHex?.get(hex) || null) : null;
  }
  return null;
}
