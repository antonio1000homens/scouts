import { listRequestActivity } from '/opt/nodejs/request-activity.mjs';

const ACTIVE = new Set([
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

const PRIORITY = Object.freeze({
  accepted: 10,
  queued: 20,
  waiting_for_retry: 35,
  processing: 40,
  orchestrating: 50,
  awaiting_image: 55,
  persisting: 60,
  awaiting_review: 65,
  published: 70,
  completed: 80,
  failed: 90,
  needs_attention: 100,
  manual_review: 100,
});

function text(value) { return value === undefined || value === null ? '' : String(value).trim(); }
function states(value) {
  if (Array.isArray(value)) return value.map((entry) => text(entry).toLowerCase()).filter(Boolean);
  return text(value).split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}
function time(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}
function timelineKey(entry) {
  return `${entry?.state || ''}|${entry?.stage || ''}|${entry?.at || ''}|${entry?.source || ''}`;
}
function mergeTimeline(left = [], right = []) {
  const merged = new Map();
  for (const entry of [...left, ...right]) {
    if (!entry || typeof entry !== 'object') continue;
    merged.set(timelineKey(entry), entry);
  }
  return [...merged.values()].sort((a, b) => time(a?.at) - time(b?.at));
}
function statePriority(state) {
  return PRIORITY[text(state).toLowerCase()] || 0;
}
function rootKey(request, index) {
  const root = text(request?.rootRequestId || request?.operationId);
  if (root) return `root:${root}`;
  const requestId = text(request?.requestId);
  if (requestId) return `request:${requestId}`;
  return `row:${index}`;
}
function isExplicitRootRow(request) {
  const root = text(request?.rootRequestId || request?.operationId);
  return Boolean(root) && text(request?.requestId) === root;
}
function prefer(left, right) {
  const leftPriority = statePriority(left?.state);
  const rightPriority = statePriority(right?.state);
  if (leftPriority !== rightPriority) return rightPriority > leftPriority ? right : left;
  return time(right?.updatedAt || right?.createdAt) >= time(left?.updatedAt || left?.createdAt) ? right : left;
}
function choosePrimary(existing, request, incomingIsRoot) {
  if (existing._hasExplicitRootRow && !incomingIsRoot) return existing;
  if (!existing._hasExplicitRootRow && incomingIsRoot) return request;
  if (existing._hasExplicitRootRow && incomingIsRoot) {
    return time(request?.updatedAt || request?.createdAt) >= time(existing?.updatedAt || existing?.createdAt)
      ? request
      : existing;
  }
  return prefer(existing, request);
}
function collapseRootActivity(rows = []) {
  const grouped = new Map();
  rows.forEach((request, index) => {
    const key = rootKey(request, index);
    const requestId = text(request?.requestId) || null;
    const rootRequestId = text(request?.rootRequestId || request?.operationId) || requestId;
    const incomingIsRoot = isExplicitRootRow(request);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        ...request,
        rootRequestId,
        childRequestIds: requestId ? [requestId] : [],
        timeline: Array.isArray(request?.timeline) ? request.timeline : [],
        _hasExplicitRootRow: incomingIsRoot,
      });
      return;
    }

    const primary = choosePrimary(existing, request, incomingIsRoot);
    const secondary = primary === existing ? request : existing;
    const childRequestIds = [...new Set([
      ...(Array.isArray(existing.childRequestIds) ? existing.childRequestIds : []),
      text(existing.requestId),
      text(request.requestId),
    ].filter(Boolean))];
    grouped.set(key, {
      ...secondary,
      ...primary,
      rootRequestId: text(existing.rootRequestId || request.rootRequestId || request.operationId) || requestId,
      requestId: text(existing.rootRequestId || request.rootRequestId || request.operationId)
        ? (text(existing.rootRequestId || request.rootRequestId || request.operationId) || primary.requestId)
        : primary.requestId,
      childRequestIds,
      hex: primary.hex || secondary.hex || null,
      title: primary.title || secondary.title || null,
      action: primary.action || secondary.action || null,
      createdAt: [existing.createdAt, request.createdAt].filter(Boolean).sort((a, b) => time(a) - time(b))[0] || null,
      updatedAt: primary.updatedAt || secondary.updatedAt || null,
      timeline: mergeTimeline(existing.timeline, request.timeline),
      failureType: primary.failureType || secondary.failureType || null,
      failureMessage: primary.failureMessage || secondary.failureMessage || null,
      publication: primary.publication || secondary.publication || null,
      _hasExplicitRootRow: existing._hasExplicitRootRow || incomingIsRoot,
    });
  });
  return [...grouped.values()].sort((a, b) => time(b.updatedAt || b.createdAt) - time(a.updatedAt || a.createdAt));
}

function canonicalDisplay(request = {}) {
  const state = text(request.state).toLowerCase();
  const stage = text(request.stage).toLowerCase();
  if (state === 'completed') return { displayState: 'completed', displayMessage: 'Completed' };
  if (['failed', 'needs_attention', 'manual_review'].includes(state)) {
    return { displayState: 'needs_attention', displayMessage: 'Needs attention' };
  }
  if (state === 'awaiting_review') {
    return { displayState: 'awaiting_review', displayMessage: 'Published — awaiting image approval' };
  }
  if (state === 'awaiting_image') {
    return { displayState: 'awaiting_image', displayMessage: 'Generating image — final review required' };
  }
  if (state === 'waiting_for_retry') {
    return { displayState: 'waiting_for_retry', displayMessage: 'Waiting for retry' };
  }
  if (state === 'persisting') {
    return { displayState: 'processing', displayMessage: 'Saving approved changes' };
  }
  if (state === 'published') {
    return { displayState: 'processing', displayMessage: 'Published — finalising workflow' };
  }
  if (stage.includes('image') && stage.includes('theme')) {
    return { displayState: 'processing', displayMessage: 'Creating image theme' };
  }
  if (stage.includes('image')) {
    return { displayState: 'processing', displayMessage: 'Generating image' };
  }
  if (stage.includes('tagline')) {
    return { displayState: 'processing', displayMessage: 'Generating tagline' };
  }
  if (state === 'accepted' || state === 'queued') {
    return { displayState: 'queued', displayMessage: 'Waiting' };
  }
  if (state === 'processing' || state === 'orchestrating') {
    return { displayState: 'processing', displayMessage: 'Processing' };
  }
  const fallback = state ? state.replaceAll('_', ' ') : 'processing';
  return { displayState: state || 'processing', displayMessage: fallback.charAt(0).toUpperCase() + fallback.slice(1) };
}

function present(request, now) {
  const updated = Date.parse(request.updatedAt || request.createdAt || '');
  const display = canonicalDisplay(request);
  const timeline = (Array.isArray(request.timeline) ? request.timeline : []).map((entry) => ({
    ...entry,
    ...canonicalDisplay(entry),
  }));
  return {
    requestId: request.requestId,
    rootRequestId: request.rootRequestId || request.requestId || null,
    childRequestIds: Array.isArray(request.childRequestIds) ? request.childRequestIds : [],
    reconciliationId: request.reconciliationId || null,
    hex: request.hex || null,
    title: request.title || null,
    action: request.action || null,
    state: request.state || 'processing',
    stage: request.stage || request.state || 'processing',
    publication: request.publication || null,
    ...display,
    failure: request.failureType ? { type: request.failureType, message: request.failureMessage || null } : null,
    createdAt: request.createdAt || null,
    updatedAt: request.updatedAt || null,
    ageSeconds: Number.isFinite(updated) ? Math.max(0, Math.floor((now.getTime() - updated) / 1000)) : null,
    timeline,
    health: ['failed', 'needs_attention', 'manual_review'].includes(request.state) ? 'needs_attention' : 'ok',
  };
}

export async function buildRuntimeActivity(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const result = await listRequestActivity({
    requestIds: options.requestIds,
    rootRequestId: options.rootRequestId,
    hex: options.hex,
    states: states(options.states),
    cursor: options.cursor,
    limit: options.limit || 50,
    activeOnly: options.activeOnly === true,
  });
  const requests = collapseRootActivity(result.requests).map((request) => present(request, now));
  const counts = requests.reduce((all, request) => ({ ...all, [request.state]: (all[request.state] || 0) + 1 }), {});
  return {
    generatedAt: now.toISOString(), lastSuccessfulUpdate: now.toISOString(), source: 'request-activity-ledger', stale: false,
    activeCount: requests.filter((request) => ACTIVE.has(request.state)).length, counts, requests, nextCursor: result.nextCursor,
  };
}