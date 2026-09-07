import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  ListExecutionsCommand,
  SFNClient,
} from '@aws-sdk/client-sfn';
import { buildCanonicalActivity } from '/opt/nodejs/runtime-activity-model.mjs';

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
const MAX_DURABLE_LOOKUPS = 20;
const SOURCE_STALE_AFTER_MS = 90 * 1000;
const MAX_EXECUTIONS_SCAN = 100;
const MAX_ACTIVE_EXECUTIONS = 20;
const MAX_RECENT_FAILURES = 5;
const MAX_RECENT_SUCCESSES = 5;
const RECENT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_SUCCESS_WINDOW_MS = 15 * 60 * 1000;

const s3 = new S3Client({ region: REGION });
const sqs = new SQSClient({ region: REGION });
const sfn = new SFNClient({ region: REGION });
const terminalExecutionCache = new Map();

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

function snapshotRequests(snapshot) {
  return Array.isArray(snapshot?.requests) ? snapshot.requests : [];
}

function hexOf(entry) {
  return text(entry?.hex || entry?.requestHex).toLowerCase();
}

function isFailureStatus(status) {
  return ['FAILED', 'TIMED_OUT', 'ABORTED'].includes(text(status).toUpperCase());
}

function isRunningStatus(status) {
  return text(status).toUpperCase() === 'RUNNING';
}

function stateEnteredName(event) {
  const type = text(event?.type);
  if (!type.endsWith('StateEntered')) return '';
  const detailsKey = `${type.charAt(0).toLowerCase()}${type.slice(1)}EventDetails`;
  return text(event?.[detailsKey]?.name);
}

function normaliseExecutionStage(stateName, input = {}) {
  const raw = text(stateName);
  const compact = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');

  if (compact === 'determinestartingstage') {
    return text(input?.startStage || input?.orchestrationStep) || 'starting';
  }
  if (compact.includes('tagline')) return 'tagline';
  if (compact.includes('imagetheme')) return 'imageTheme';
  if (
    compact === 'selectimageprovider'
    || compact === 'generateimage'
    || compact === 'generateimagecloudflare'
    || compact === 'generateimagegemini'
    || compact === 'evaluateimageresult'
  ) return 'image';
  if (compact === 'deferred') return 'waiting_for_retry';
  if (compact === 'manualreview') return 'manual_review';
  if (compact === 'complete') return 'complete';
  if (compact === 'imagegenerationdisabled') return 'image_generation_disabled';
  if (compact === 'unexpectedfailure' || compact === 'invalidimageprovider') return 'failed';

  return text(input?.orchestrationStep || input?.startStage) || raw || null;
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

async function describeExecutionLifecycle(execution, orchestrationType) {
  const executionArn = text(execution?.executionArn);
  if (!executionArn) return null;

  const status = text(execution?.status).toUpperCase() || 'RUNNING';
  if (!isRunningStatus(status) && terminalExecutionCache.has(executionArn)) {
    return terminalExecutionCache.get(executionArn);
  }

  let detail = null;
  let history = null;
  try {
    [detail, history] = await Promise.all([
      sfn.send(new DescribeExecutionCommand({ executionArn })),
      sfn.send(new GetExecutionHistoryCommand({
        executionArn,
        reverseOrder: true,
        maxResults: 50,
        includeExecutionData: false,
      })),
    ]);
  } catch (error) {
    console.warn('[RuntimeActivity] Failed to inspect Step Functions execution', {
      executionArn,
      error: error?.message || String(error),
    });
    detail = detail || {};
    history = history || { events: [] };
  }

  let input = {};
  try { input = detail?.input ? JSON.parse(detail.input) : {}; } catch { input = {}; }

  const stateEvent = (history?.events || []).find((event) => stateEnteredName(event));
  const stateName = stateEnteredName(stateEvent);
  const currentStage = normaliseExecutionStage(stateName, input);
  const resolvedStatus = text(detail?.status || execution?.status).toUpperCase() || status;
  const result = {
    executionArn,
    name: execution?.name || null,
    status: resolvedStatus,
    startDate: detail?.startDate
      ? new Date(detail.startDate).toISOString()
      : (execution?.startDate ? new Date(execution.startDate).toISOString() : null),
    stopDate: detail?.stopDate
      ? new Date(detail.stopDate).toISOString()
      : (execution?.stopDate ? new Date(execution.stopDate).toISOString() : null),
    requestId: text(input?.requestId),
    hex: text(input?.requestHex || input?.hex).toLowerCase(),
    orchestrationType,
    currentStage,
    stateName: stateName || null,
    updatedAt: stateEvent?.timestamp
      ? new Date(stateEvent.timestamp).toISOString()
      : (detail?.stopDate
          ? new Date(detail.stopDate).toISOString()
          : (detail?.startDate ? new Date(detail.startDate).toISOString() : null)),
    error: text(detail?.error) || null,
    cause: text(detail?.cause) || null,
  };

  if (!isRunningStatus(result.status)) {
    terminalExecutionCache.set(executionArn, result);
    if (terminalExecutionCache.size > 100) {
      const oldestKey = terminalExecutionCache.keys().next().value;
      if (oldestKey) terminalExecutionCache.delete(oldestKey);
    }
  }
  return result;
}

function recentEnough(execution, nowMs, windowMs) {
  const terminalAt = timestamp(execution?.stopDate || execution?.startDate);
  return terminalAt > 0 && (nowMs - terminalAt) <= windowMs;
}

async function listExecutions(stateMachineArn, orchestrationType, now = new Date()) {
  if (!stateMachineArn) return [];

  const response = await sfn.send(new ListExecutionsCommand({
    stateMachineArn,
    maxResults: MAX_EXECUTIONS_SCAN,
  }));
  let executions = Array.isArray(response?.executions) ? response.executions : [];

  // An unfiltered scan gives us running executions plus recent terminal outcomes
  // in one request. If it is truncated, explicitly fetch RUNNING executions so a
  // long-lived workflow cannot disappear behind a busy history.
  if (response?.nextToken) {
    const runningResponse = await sfn.send(new ListExecutionsCommand({
      stateMachineArn,
      statusFilter: 'RUNNING',
      maxResults: MAX_ACTIVE_EXECUTIONS,
    }));
    const merged = new Map(executions.map((execution) => [execution.executionArn, execution]));
    for (const execution of runningResponse?.executions || []) {
      if (execution?.executionArn) merged.set(execution.executionArn, execution);
    }
    executions = [...merged.values()];
  }

  const nowMs = now.getTime();
  const running = executions
    .filter((execution) => isRunningStatus(execution?.status))
    .slice(0, MAX_ACTIVE_EXECUTIONS);
  const failures = executions
    .filter((execution) => isFailureStatus(execution?.status) && recentEnough(execution, nowMs, RECENT_FAILURE_WINDOW_MS))
    .slice(0, MAX_RECENT_FAILURES);
  const recentSuccesses = executions
    .filter((execution) => text(execution?.status).toUpperCase() === 'SUCCEEDED' && recentEnough(execution, nowMs, RECENT_SUCCESS_WINDOW_MS))
    .slice(0, MAX_RECENT_SUCCESSES);

  const selected = new Map();
  for (const execution of [...running, ...failures, ...recentSuccesses]) {
    if (execution?.executionArn) selected.set(execution.executionArn, execution);
  }

  const described = await Promise.all(
    [...selected.values()].map((execution) => describeExecutionLifecycle(execution, orchestrationType)),
  );
  return described.filter(Boolean);
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

function workflowSummary(stateMachineArn, executions) {
  const activeExecutionCount = executions.filter((execution) => isRunningStatus(execution?.status)).length;
  const recentFailureCount = executions.filter((execution) => isFailureStatus(execution?.status)).length;
  return {
    configured: Boolean(stateMachineArn),
    stateMachineArn: stateMachineArn || null,
    activeExecutionCount,
    recentFailureCount,
    executions,
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
    listExecutions(IMAGE_ENRICH_STATE_MACHINE_ARN, 'imageEnrich', now),
    listExecutions(FULL_ENRICH_STATE_MACHINE_ARN, 'fullEnrich', now),
    Promise.all([
      queueHealth('scoutsRequests', REQUESTS_QUEUE_URL),
      queueHealth('scoutsProcessing', PROCESSING_QUEUE_URL),
      queueHealth('scoutsRequestsDLQ', REQUESTS_DLQ_URL),
      queueHealth('scoutsProcessingDLQ', PROCESSING_DLQ_URL),
    ]),
  ]);

  const executions = [...imageExecutions, ...fullExecutions];
  const queueHealthMap = Object.fromEntries(queueHealthEntries.map((entry) => [entry.name, entry]));
  const requests = buildCanonicalActivity({
    queuedSnapshot,
    processingSnapshot,
    completedSnapshot,
    durableHistories,
    executions,
    queueHealth: queueHealthMap,
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
  const hasActiveRequests = requests.some((request) => request.state !== 'completed' && request.state !== 'needs_attention');

  return {
    generatedAt: now.toISOString(),
    lastSuccessfulUpdate: now.toISOString(),
    sourceUpdatedAt: newestSourceMs ? new Date(newestSourceMs).toISOString() : null,
    stale: hasActiveRequests && newestSourceMs > 0 ? (now.getTime() - newestSourceMs) > SOURCE_STALE_AFTER_MS : false,
    counts,
    requests,
    queueHealth: queueHealthMap,
    stepFunctions: {
      imageEnrich: workflowSummary(IMAGE_ENRICH_STATE_MACHINE_ARN, imageExecutions),
      fullEnrich: workflowSummary(FULL_ENRICH_STATE_MACHINE_ARN, fullExecutions),
    },
    rawSnapshots: summaries,
  };
}