import { listRequestActivity } from '/opt/nodejs/request-activity.mjs';

const ACTIVE = new Set(['accepted', 'queued', 'processing', 'orchestrating', 'persisting', 'published', 'waiting_for_retry']);

function text(value) { return value === undefined || value === null ? '' : String(value).trim(); }
function states(value) {
  if (Array.isArray(value)) return value.map((entry) => text(entry).toLowerCase()).filter(Boolean);
  return text(value).split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}
function present(request, now) {
  const updated = Date.parse(request.updatedAt || request.createdAt || '');
  return {
    requestId: request.requestId,
    hex: request.hex || null,
    title: request.title || null,
    action: request.action || null,
    state: request.state || 'processing',
    stage: request.stage || request.state || 'processing',
    publication: request.publication || null,
    failure: request.failureType ? { type: request.failureType, message: request.failureMessage || null } : null,
    createdAt: request.createdAt || null,
    updatedAt: request.updatedAt || null,
    ageSeconds: Number.isFinite(updated) ? Math.max(0, Math.floor((now.getTime() - updated) / 1000)) : null,
    timeline: Array.isArray(request.timeline) ? request.timeline : [],
    health: ['failed', 'needs_attention', 'manual_review'].includes(request.state) ? 'needs_attention' : 'ok',
  };
}

export async function buildRuntimeActivity(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const result = await listRequestActivity({
    requestIds: options.requestIds,
    hex: options.hex,
    states: states(options.states),
    cursor: options.cursor,
    limit: options.limit || 50,
    activeOnly: options.activeOnly === true,
  });
  const requests = result.requests.map((request) => present(request, now));
  const counts = requests.reduce((all, request) => ({ ...all, [request.state]: (all[request.state] || 0) + 1 }), {});
  return {
    generatedAt: now.toISOString(), lastSuccessfulUpdate: now.toISOString(), source: 'request-activity-ledger', stale: false,
    activeCount: requests.filter((request) => ACTIVE.has(request.state)).length, counts, requests, nextCursor: result.nextCursor,
  };
}
