import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { buildEventReviewSnapshot } from '/opt/nodejs/event-review.mjs';
import { recordRequestActivity } from '/opt/nodejs/request-activity.mjs';
import { publishCanonicalEventToAgenda } from './agenda-publisher.mjs';

const AWS_REGION = process.env.AWS_REGION || 'eu-west-2';
const TARGET_BUCKET = process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const SCOUTS_DECISION_QUEUE_URL = String(process.env.SCOUTS_DECISION_QUEUE_URL || '').trim();
const s3 = new S3Client({ region: AWS_REGION });
const sqs = new SQSClient({ region: AWS_REGION });

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function getHex(message) {
  const direct = text(message?.requestHex || message?.hex).toLowerCase();
  if (direct && /^[0-9a-f]+$/i.test(direct)) return direct;
  const subject = message?.subject;
  if (typeof subject === 'string') {
    const candidate = subject.trim().toLowerCase();
    if (/^[0-9a-f]+$/i.test(candidate)) return candidate;
  }
  if (subject && typeof subject === 'object') {
    const candidate = text(subject?.metadata?.hex || subject?.hex).toLowerCase();
    if (candidate && /^[0-9a-f]+$/i.test(candidate)) return candidate;
  }
  return null;
}

function parseRecord(record) {
  if (!record || record.eventSource !== 'aws:sqs') return null;
  try { return typeof record.body === 'string' ? JSON.parse(record.body) : record.body; } catch { return null; }
}

export function isRevisionedApprovalPersist(message) {
  return text(message?.realm) === 'persist'
    && text(message?.action) === 'persist'
    && Boolean(text(message?.approvalRevision))
    && Boolean(text(message?.rootRequestId));
}

function conditionalFailure(error) {
  return error?.name === 'PreconditionFailed' || Number(error?.$metadata?.httpStatusCode) === 412;
}

async function loadEventVersioned(hex) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: TARGET_BUCKET, Key: `events/${hex}.json` }));
    return {
      event: JSON.parse(await response.Body.transformToString()),
      eTag: text(response.ETag),
    };
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.name === 'NotFound' || Number(error?.$metadata?.httpStatusCode) === 404) return null;
    throw error;
  }
}

async function saveEvent(hex, event, eTag) {
  return s3.send(new PutObjectCommand({
    Bucket: TARGET_BUCKET,
    Key: `events/${hex}.json`,
    Body: JSON.stringify(event, null, 2),
    ContentType: 'application/json',
    CacheControl: 'no-store',
    ...(text(eTag) ? { IfMatch: text(eTag) } : {}),
  }));
}

async function publishEvent(hex, event) {
  return publishCanonicalEventToAgenda({
    hex,
    event,
    loadAgenda: async () => {
      const response = await s3.send(new GetObjectCommand({ Bucket: TARGET_BUCKET, Key: 'agenda.json' }));
      return JSON.parse(await response.Body.transformToString());
    },
    writeAgenda: (agenda) => s3.send(new PutObjectCommand({
      Bucket: TARGET_BUCKET,
      Key: 'agenda.json',
      Body: JSON.stringify(agenda, null, 2),
      ContentType: 'application/json',
      CacheControl: 'no-store',
    })),
  });
}

function clone(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : {};
}

function applyApprovedMetadata(event, message, hex) {
  const subject = message?.subject && typeof message.subject === 'object' ? message.subject : {};
  const patch = subject?.metadata && typeof subject.metadata === 'object' ? subject.metadata : {};
  const next = clone(event);
  next.metadata = next.metadata && typeof next.metadata === 'object' ? next.metadata : {};
  next.metadata.hex = hex;
  next.metadata.tagline = patch.tagline ?? null;
  next.metadata.image = {
    theme: patch?.image?.theme ?? null,
    url: patch?.image?.url ?? null,
  };
  next.metadata.status = {
    isHidden: patch?.status?.isHidden === true,
    isApproved: patch?.status?.isApproved === true,
  };
  delete next.hex;
  delete next.tagline;
  delete next.image;
  delete next.status;
  delete next.approved;
  delete next.isApproved;
  delete next.isHidden;
  return next;
}

async function recordActivity(input) {
  try {
    await recordRequestActivity(input);
  } catch (error) {
    console.warn('[ApprovalPersist] Activity write failed', error?.message || error);
  }
}

async function recordRoot(message, hex, event, state, stage, publication = null, failure = null) {
  const rootRequestId = text(message.rootRequestId);
  if (!rootRequestId) return;
  await recordActivity({
    requestId: rootRequestId,
    rootRequestId,
    hex,
    title: event?.title || event?.summary || null,
    action: 'approve',
    state,
    stage,
    publication,
    ...(failure ? { failure } : {}),
  });
}

async function notifyDecision(message, hex, event) {
  if (!SCOUTS_DECISION_QUEUE_URL) return;
  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl: SCOUTS_DECISION_QUEUE_URL,
      MessageBody: JSON.stringify({
        realm: 'sqs2scouts',
        action: 'persisted',
        subject: {
          hex,
          title: event?.title || event?.summary || null,
        },
        source: 'approval-lifecycle-adapter',
        requestId: message.requestId,
        rootRequestId: message.rootRequestId,
        requestHex: hex,
      }),
    }));
  } catch (error) {
    console.warn('[ApprovalPersist] scoutsDecision notification failed', error?.message || error);
  }
}

function markWorkflow(event, message, state) {
  const now = new Date().toISOString();
  const previous = event?.approvalWorkflow && typeof event.approvalWorkflow === 'object'
    ? event.approvalWorkflow
    : {};
  event.approvalWorkflow = {
    ...previous,
    rootRequestId: text(message.rootRequestId),
    approvedRevision: text(message.approvalRevision),
    state,
    updatedAt: now,
    ...(state === 'approved' ? { approvedAt: now } : {}),
  };
}

function currentMatchesAppliedApproval(current, message) {
  const targetRevision = text(message.approvalRevision);
  const review = buildEventReviewSnapshot(current);
  const desiredApproved = text(message.approvalState).toLowerCase() === 'approved';
  const actualApproved = current?.metadata?.status?.isApproved === true;
  return review.revision === targetRevision && actualApproved === desiredApproved;
}

export async function handleRevisionedPersist(message) {
  const hex = getHex(message);
  if (!hex) throw new Error('Revisioned approval persistence is missing canonical HEX');
  const approvalState = text(message.approvalState).toLowerCase();
  if (!['awaiting_image', 'approved'].includes(approvalState)) {
    throw new Error(`Unsupported approval state: ${approvalState || 'missing'}`);
  }

  let current = await loadEventVersioned(hex);
  if (!current?.event) throw new Error(`HEX ${hex} not found`);

  if (currentMatchesAppliedApproval(current.event, message)) {
    const rootState = approvalState === 'approved' ? 'completed' : 'awaiting_image';
    const rootStage = approvalState === 'approved' ? 'agenda_published' : 'metadata_published';
    await recordActivity({
      ...message,
      hex,
      state: 'completed',
      stage: 'agenda_published',
      publication: 'published',
    });
    await recordRoot(message, hex, current.event, rootState, rootStage, 'published');
    return { status: 'already_applied', hex, rootState };
  }

  const currentReview = buildEventReviewSnapshot(current.event);
  const baseRevision = text(message.approvalBaseRevision || message.approvalRevision);
  if (currentReview.revision !== baseRevision) {
    await recordRoot(message, hex, current.event, 'needs_attention', 'approval_persist_stale', null, {
      type: 'STALE_REVIEW',
      message: 'Canonical review changed before the accepted approval snapshot could be persisted.',
    });
    await recordActivity({
      ...message,
      hex,
      state: 'needs_attention',
      stage: 'approval_persist_stale',
      failure: {
        type: 'STALE_REVIEW',
        message: 'Canonical review changed before the accepted approval snapshot could be persisted.',
      },
    });
    return { status: 'stale', hex };
  }

  const accepted = applyApprovedMetadata(current.event, message, hex);
  markWorkflow(accepted, message, approvalState);
  try {
    await saveEvent(hex, accepted, current.eTag);
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    current = await loadEventVersioned(hex);
    if (current?.event && currentMatchesAppliedApproval(current.event, message)) {
      const rootState = approvalState === 'approved' ? 'completed' : 'awaiting_image';
      const rootStage = approvalState === 'approved' ? 'agenda_published' : 'metadata_published';
      await recordRoot(message, hex, current.event, rootState, rootStage, 'published');
      return { status: 'already_applied', hex, rootState };
    }
    await recordRoot(message, hex, current?.event || accepted, 'needs_attention', 'approval_persist_conflict', null, {
      type: 'CONCURRENT_WRITE',
      message: 'Canonical event changed while applying the accepted approval snapshot.',
    });
    return { status: 'conflict', hex };
  }

  await publishEvent(hex, accepted);
  await notifyDecision(message, hex, accepted);
  await recordActivity({
    ...message,
    hex,
    state: 'completed',
    stage: 'agenda_published',
    publication: 'published',
  });

  if (approvalState === 'approved') {
    await recordRoot(message, hex, accepted, 'completed', 'agenda_published', 'published');
  } else {
    await recordRoot(message, hex, accepted, 'awaiting_image', 'metadata_published', 'published');
  }

  return {
    status: 'persisted',
    hex,
    rootState: approvalState === 'approved' ? 'completed' : 'awaiting_image',
  };
}

export async function processRevisionedApprovalRecords(records = []) {
  const delegated = [];
  for (const record of records) {
    const message = parseRecord(record);
    if (!message || !isRevisionedApprovalPersist(message)) {
      delegated.push(record);
      continue;
    }

    try {
      const result = await handleRevisionedPersist(message);
      console.log('[ApprovalPersist] Revisioned approval persistence handled', result);
    } catch (error) {
      console.error('[ApprovalPersist] Revisioned approval persistence failed', {
        requestId: message?.requestId || null,
        rootRequestId: message?.rootRequestId || null,
        error: error?.message || String(error),
      });
      await recordRoot(message, getHex(message), null, 'needs_attention', 'approval_persist_failed', null, {
        type: error?.name || 'PERSIST_FAILED',
        message: error?.message || String(error),
      });
      throw error;
    }
  }
  return delegated;
}
