import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DescribeExecutionCommand, ListExecutionsCommand, SFNClient } from '@aws-sdk/client-sfn';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const TARGET_BUCKET = process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const QUEUED_KEY = 'runtime/scoutsQueued.json';
const PROCESSING_KEY = 'runtime/scoutsProcessing.json';
const COMPLETED_KEY = 'runtime/scoutsComplete.json';
const REQUESTS_QUEUE_URL = process.env.SCOUTS_REQUESTS_QUEUE_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests';
const PROCESSING_QUEUE_URL = process.env.SCOUTS_PROCESSING_QUEUE_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessing';
const REQUESTS_DLQ_URL = process.env.SCOUTS_REQUESTS_DLQ_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequestsDLQ';
const PROCESSING_DLQ_URL = process.env.SCOUTS_PROCESSING_DLQ_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessingDLQ';
const IMAGE_ENRICH_STATE_MACHINE_ARN = String(process.env.IMAGE_ENRICH_STATE_MACHINE_ARN || '').trim();
const FULL_ENRICH_STATE_MACHINE_ARN = String(process.env.FULL_ENRICH_STATE_MACHINE_ARN || '').trim();
const MAX_ACTIVITY_REQUESTS = 50;
const MAX_DURABLE_LOOKUPS = 20;
const SOURCE_STALE_AFTER_MS = 90 * 1000;

const s3 = new S3Client({ region: REGION });
const sqs = new SQSClient({ region: REGION });
const sfn = new SFNClient({ region: REGION });

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
    queueMessageIds: {
      [source]: text(entry?.messageId) || null,
    },
    executionArn: null,
    failure: null,
    timeline: [{
      state,
      stage: text(entry?.orchestrationStep) || state,
      at: updatedAt || createdAt,
      source,
    }],
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
    createdAt: [existing.createdAt, incoming.createdAt]
      .filter(Boolean)
      .sort((a, b) => timestamp(a) - timestamp(b))[0] || null,
    updatedAt: [existing.updatedAt, incoming.updatedAt]
      .filter(Boolean)
      .sort((a, b) => timestamp(b) - timestamp(a))[0] || null,
    queueMessageIds: {
      ...(existing.queueMessageIds || {}),
      ...(incoming.queueMessageIds || {}),
    },
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
    .slice(0, MAX_ACTIVITY_REQUESTS);
}

async function readJson(key) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: TARGET_BUCKET, Key: key }));
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    const notFound = error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404;
    if (notFound) return null;
    throw error;
  }
}

async function readDurableHistories(queuedSnapshot, processingSnapshot, completedSnapshot) {
  const candidates = [...snapshotRequests(queuedSnapshot), ...snapshotRequests(processingSnapshot), ...snapshotRequests(completedSnapshot)];
  const hexes = [...new Set(candidates.map(hexOf).filter(Boolean))].slice(0, MAX_DURABLE_LOOKUPS);
  const pairs = await Promise.all(hexes.map(async (hex) => {
    try {
      const event = await readJson(`events/${hex}.json`);
      const history = Array.isArray(event?.requests)
        ? event.requests
        : (Array.isArray(event?.metadata?.requests) ? event.metadata.requests : []);
      return [hex, history];
    } catch (error) {
      console.warn('[RuntimeActivity] Failed to read durable request history', { hex, error: error?.message || String(error) });
      return [hex, []];
    }
  }));
  return new Map(pairs);
}

async function listExecutions(stateMachineArn, orchestrationType) {
  if (!stateMachineArn) return [];
  const response = await sfn.send(new ListExecutionsCommand({
    stateMachineArn,
    statusFilter: 'RUNNING',
    maxResults: 20,
  }));
  return Promise.all((response?.executions || []).map(async (execution) => {
    try {
      const detail = await sfn.send(new DescribeExecutionCommand({ executionArn: execution.executionArn }));
      let input = {};
      try { input = detail?.input ? JSON.parse(detail.input) : {}; } catch { input = {}; }
      return {
        executionArn: execution.executionArn || null,
        name: execution.name || null,
        status: detail?.status || execution.status || 'RUNNING',
        startDate: detail?.startDate ? new Date(detail.startDate).toISOString() : null,
        stopDate: detail?.stopDate ? new Date(detail.stopDate).toISOString() : null,
        requestId: text(input?.requestId),
        hex: text(input?.requestHex || input?.hex).toLowerCase(),
        orchestrationType,
        currentStage: text(input?.orchestrationStep || input?.startStage) || null,
      };
    } catch (error) {
      return {
        executionArn: execution.executionArn || null,
        name: execution.name || null,
        status: execution.status || 'RUNNING',
        startDate: execution.startDate ? new Date(execution.startDate).toISOString() : null,
        orchestrationType,
        error: error?.message || String(error),
      };
    }
  }));
}

async function queueHealth(name, queueUrl) {
  try {
    const response = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ],
    }));
    const attrs = response?.Attributes || {};
    return {
      name,
      visible: Number(attrs.ApproximateNumberOfMessages || 0),
      inFlight: Number(attrs.ApproximateNumberOfMessagesNotVisible || 0),
      delayed: Number(attrs.ApproximateNumberOfMessagesDelayed || 0),
      ok: true,
    };
  } catch (error) {
    return { name, visible: null, inFlight: null, delayed: null, ok: false, error: error?.message || String(error) };
  }
}

function snapshotSummary(snapshot) {
  return {
    updatedAt: iso(snapshot?.updatedAt),
    count: snapshotRequests(snapshot).length,
  };
}

export async function buildRuntimeActivity(now = new Date()) {
  const [queuedSnapshot, processingSnapshot, completedSnapshot] = await Promise.all([
    readJson(QUEUED_KEY),
    readJson(PROCESSING_KEY),
    readJson(COMPLETED_KEY),
  ]);
  const [durableHistories, imageExecutions, fullExecutions, queueHealthEntries] = await Promise.all([
    readDurableHistories(queuedSnapshot, processingSnapshot, completedSnapshot),
    listExecutions(IMAGE_ENRICH_STATE_MACHINE_ARN, 'imageEnrich'),
    listExecutions(FULL_ENRICH_STATE_MACHINE_ARN, 'fullEnrich'),
    Promise.all([
      queueHealth('scoutsRequests', REQUESTS_QUEUE_URL),
      queueHealth('scoutsProcessing', PROCESSING_QUEUE_URL),
      queueHealth('scoutsRequestsDLQ', REQUESTS_DLQ_URL),
      queueHealth('scoutsProcessingDLQ', PROCESSING_DLQ_URL),
    ]),
  ]);

  const executions = [...imageExecutions, ...fullExecutions];
  const requests = buildCanonicalActivity({
    queuedSnapshot,
    processingSnapshot,
    completedSnapshot,
    durableHistories,
    executions,
    now,
  });
  const summaries = {
    queued: snapshotSummary(queuedSnapshot),
    processing: snapshotSummary(processingSnapshot),
    completed: snapshotSummary(completedSnapshot),
  };
  const sourceTimestamps = Object.values(summaries).map((entry) => timestamp(entry.updatedAt)).filter((value) => value > 0);
  const newestSourceMs = sourceTimestamps.length ? Math.max(...sourceTimestamps) : 0;
  const counts = requests.reduce((result, request) => {
    result[request.state] = (result[request.state] || 0) + 1;
    return result;
  }, {});

  return {
    generatedAt: now.toISOString(),
    lastSuccessfulUpdate: now.toISOString(),
    sourceUpdatedAt: newestSourceMs ? new Date(newestSourceMs).toISOString() : null,
    stale: newestSourceMs > 0 ? (now.getTime() - newestSourceMs) > SOURCE_STALE_AFTER_MS : true,
    counts,
    requests,
    queueHealth: Object.fromEntries(queueHealthEntries.map((entry) => [entry.name, entry])),
    stepFunctions: {
      imageEnrich: {
        configured: Boolean(IMAGE_ENRICH_STATE_MACHINE_ARN),
        stateMachineArn: IMAGE_ENRICH_STATE_MACHINE_ARN || null,
        activeExecutionCount: imageExecutions.length,
        executions: imageExecutions,
      },
      fullEnrich: {
        configured: Boolean(FULL_ENRICH_STATE_MACHINE_ARN),
        stateMachineArn: FULL_ENRICH_STATE_MACHINE_ARN || null,
        activeExecutionCount: fullExecutions.length,
        executions: fullExecutions,
      },
    },
    rawSnapshots: summaries,
  };
}
