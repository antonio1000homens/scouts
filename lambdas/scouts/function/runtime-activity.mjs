import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DescribeExecutionCommand, ListExecutionsCommand, SFNClient } from '@aws-sdk/client-sfn';
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

function snapshotRequests(snapshot) {
  return Array.isArray(snapshot?.requests) ? snapshot.requests : [];
}

function hexOf(entry) {
  return text(entry?.hex || entry?.requestHex).toLowerCase();
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
