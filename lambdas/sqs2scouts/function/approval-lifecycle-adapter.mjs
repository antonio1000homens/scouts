import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { buildEventReviewSnapshot } from '/opt/nodejs/event-review.mjs';
import { recordRequestActivity } from '/opt/nodejs/request-activity.mjs';
import { getRequiredSecret } from '/opt/nodejs/ssm-secrets.mjs';
import { reconcileSlackDecision } from './slack-decision-sync.mjs';
import { publishCanonicalEventToAgenda } from './agenda-publisher.mjs';

const AWS_REGION = process.env.AWS_REGION || 'eu-west-2';
const TARGET_BUCKET = process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const SCOUTS_DECISION_QUEUE_URL = String(process.env.SCOUTS_DECISION_QUEUE_URL || '').trim();
const APPROVAL_METADATA_PREFIX = String(process.env.APPROVAL_METADATA_PREFIX || 'approvals').trim() || 'approvals';
const SLACK_CHAT_UPDATE_URL = String(process.env.SLACK_CHAT_UPDATE_URL || 'https://slack.com/api/chat.update').trim();
const S3_WEBSITE_BASE_URL = String(process.env.S3_WEBSITE_BASE_URL || `https://${TARGET_BUCKET}.s3.${AWS_REGION}.amazonaws.com`).replace(/\/$/, '');
const APPROVAL_PERSISTENCE_ENABLED = !['false', '0', 'off', 'disabled'].includes(String(process.env.APPROVAL_PERSISTENCE ?? process.env.APPROVAL_METADATA_PERSISTENCE ?? 'true').trim().toLowerCase());
const s3 = new S3Client({ region: AWS_REGION });
const sqs = new SQSClient({ region: AWS_REGION });

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function approvalMetadataKey(identifier, realm = 'approval') {
  const safeIdentifier = text(identifier).replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!safeIdentifier) throw new Error('Cannot build metadata key without identifier');
  const safeRealm = (text(realm) || 'unknown').toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return `${APPROVAL_METADATA_PREFIX}/${safeIdentifier}/${safeRealm}.json`;
}

function approvalIdentifiers(event, hex) {
  const identifiers = new Set();
  if (text(hex)) identifiers.add(text(hex).toLowerCase());
  for (const candidate of [event?.hex, event?.uid, event?.originalUid]) {
    if (text(candidate)) identifiers.add(text(candidate));
  }
  return Array.from(identifiers);
}

async function loadApprovalMessageMetadata(identifiers, realm = 'approval') {
  for (const identifier of identifiers) {
    const key = approvalMetadataKey(identifier, realm);
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: TARGET_BUCKET, Key: key }));
      const metadata = JSON.parse(await response.Body.transformToString());
      const storedIdentifiers = Array.isArray(metadata?.identifiers) && metadata.identifiers.length > 0
        ? metadata.identifiers
        : identifiers;
      metadata._keys = storedIdentifiers.map((entry) => approvalMetadataKey(entry, realm));
      return metadata;
    } catch (error) {
      if (error?.name === 'NoSuchKey' || error?.name === 'NotFound' || Number(error?.$metadata?.httpStatusCode) === 404) continue;
      console.warn('[ApprovalPersist] Approval metadata lookup failed', { key, error: error?.message || String(error) });
    }
  }
  return null;
}

async function persistApprovalMetadata(metadata, overrides = {}) {
  if (!metadata || !APPROVAL_PERSISTENCE_ENABLED) return;
  const merged = { ...metadata, ...overrides, updatedAt: new Date().toISOString() };
  delete merged._keys;
  const identifiers = Array.from(new Set(
    (Array.isArray(merged.identifiers) ? merged.identifiers : [])
      .map((entry) => text(entry))
      .filter(Boolean),
  ));
  if (identifiers.length === 0) return;
  merged.identifiers = identifiers;
  const keys = Array.isArray(metadata._keys) && metadata._keys.length > 0
    ? metadata._keys
    : identifiers.map((entry) => approvalMetadataKey(entry, merged.realm || 'approval'));
  await Promise.all(keys.map((key) => s3.send(new PutObjectCommand({
    Bucket: TARGET_BUCKET,
    Key: key,
    Body: JSON.stringify(merged, null, 2),
    ContentType: 'application/json',
    CacheControl: 'no-store',
  }))));
}

async function updateSlackApprovalMessage(channel, ts, messageText, blocks = null) {
  const slackBotToken = await getRequiredSecret('SLACK_BOT_TOKEN_PARAMETER');
  const response = await fetch(SLACK_CHAT_UPDATE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${slackBotToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, ts, text: messageText, ...(blocks ? { blocks } : {}) }),
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || body?.ok !== true) {
    throw new Error(`Slack chat.update failed: ${body?.error || `HTTP ${response.status}`}`);
  }
  return body;
}

async function postToResponseUrl(responseUrl, payload) {
  const response = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Slack response_url failed: HTTP ${response.status}`);
}

function resolveImageUrlForDisplay(value) {
  const imageUrl = text(value);
  if (!imageUrl) return null;
  if (/^https?:\/\//i.test(imageUrl)) return imageUrl;
  return `${S3_WEBSITE_BASE_URL}/${imageUrl.replace(/^\/+/, '')}`;
}

function slackReference(value = {}) {
  const channel = text(value?.channel || value?.notificationChannel);
  const ts = text(value?.ts || value?.notificationTs);
  const responseUrl = text(value?.responseUrl || value?.response_url);
  return {
    ...(channel ? { channel } : {}),
    ...(ts ? { ts } : {}),
    ...(responseUrl ? { responseUrl } : {}),
  };
}

function generatedReviewReference(event, rootRequestId = null) {
  const workflow = event?.approvalWorkflow && typeof event.approvalWorkflow === 'object'
    ? event.approvalWorkflow
    : null;
  if (!workflow) return null;
  const expectedRoot = text(rootRequestId);
  if (expectedRoot && text(workflow.rootRequestId) !== expectedRoot) return null;
  const reference = slackReference(workflow);
  return reference.channel && reference.ts ? reference : null;
}

function slackReferenceKey(reference) {
  const ref = slackReference(reference);
  return ref.channel && ref.ts ? `${ref.channel}:${ref.ts}` : '';
}

async function reconcileApprovalSlack(message, hex, event, approvalState) {
  const directMetadata = message?.approvalMetadata && typeof message.approvalMetadata === 'object'
    ? slackReference(message.approvalMetadata)
    : null;
  const generatedMetadata = generatedReviewReference(event, message?.rootRequestId);
  const source = text(message?.source).toLowerCase();
  const decisionSource = source.startsWith('slack') ? 'slack' : 'admin';
  const decisionOverride = approvalState === 'awaiting_image'
    ? {
        status: 'AWAITING_IMAGE',
        label: 'Approval accepted — generating image',
        emoji: '⏳',
      }
    : null;
  const identifiers = approvalIdentifiers(event, hex);

  try {
    const primary = await reconcileSlackDecision({
      event,
      messageBody: {
        decisionSource,
        ...(directMetadata?.responseUrl ? { responseUrl: directMetadata.responseUrl } : {}),
      },
      identifiers,
      loadMetadata: loadApprovalMessageMetadata,
      persistMetadata: persistApprovalMetadata,
      updateMessage: updateSlackApprovalMessage,
      postResponseUrl,
      resolveImageUrl: resolveImageUrlForDisplay,
      decisionOverride,
      logger: console,
    });

    const seen = new Set();
    const primaryKey = slackReferenceKey(primary);
    if (primaryKey) seen.add(primaryKey);

    for (const reference of [generatedMetadata, directMetadata]) {
      const key = slackReferenceKey(reference);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      await reconcileSlackDecision({
        event,
        messageBody: {
          decisionSource,
          slackMetadata: reference,
        },
        identifiers: [],
        loadMetadata: async () => null,
        persistMetadata: async () => {},
        updateMessage: updateSlackApprovalMessage,
        postResponseUrl,
        resolveImageUrl: resolveImageUrlForDisplay,
        decisionOverride,
        logger: console,
      });
    }

    return primary;
  } catch (error) {
    console.warn('[ApprovalPersist] Slack reconciliation failed after canonical persistence', error?.message || error);
    return null;
  }
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
  const rootRequestId = text(message.rootRequestId);
  const previous = event?.approvalWorkflow && typeof event.approvalWorkflow === 'object'
    ? event.approvalWorkflow
    : {};
  const sameRoot = text(previous.rootRequestId) === rootRequestId;
  event.approvalWorkflow = {
    ...(sameRoot ? previous : {}),
    rootRequestId,
    approvedRevision: text(message.approvalRevision),
    state,
    updatedAt: now,
    ...(state === 'approved' ? { approvedAt: now } : {}),
  };
}

function finalApprovalNotificationReferencePending(event, message, approvalState) {
  if (approvalState !== 'approved') return false;
  const workflow = event?.approvalWorkflow && typeof event.approvalWorkflow === 'object'
    ? event.approvalWorkflow
    : null;
  if (!workflow || text(workflow.rootRequestId) !== text(message?.rootRequestId)) return false;
  const identityPrepared = Boolean(text(workflow.notificationClientMsgId));
  const referenceRecorded = Boolean(text(workflow.notificationChannel) && text(workflow.notificationTs));
  return identityPrepared && !referenceRecorded;
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

  if (finalApprovalNotificationReferencePending(current.event, message, approvalState)) {
    const error = new Error('Generated-review Slack message reference is still being recorded; retry final approval persistence');
    error.name = 'ApprovalReviewNotificationPending';
    throw error;
  }

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
    await reconcileApprovalSlack(message, hex, current.event, approvalState);
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
      await reconcileApprovalSlack(message, hex, current.event, approvalState);
      return { status: 'already_applied', hex, rootState };
    }
    await recordRoot(message, hex, current?.event || accepted, 'needs_attention', 'approval_persist_conflict', null, {
      type: 'CONCURRENT_WRITE',
      message: 'Canonical event changed while applying the accepted approval snapshot.',
    });
    return { status: 'conflict', hex };
  }

  await publishEvent(hex, accepted);
  await reconcileApprovalSlack(message, hex, accepted, approvalState);
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
      if (error?.name === 'ApprovalReviewNotificationPending') {
        console.warn('[ApprovalPersist] Deferring final approval until generated-review Slack reference is durable', {
          requestId: message?.requestId || null,
          rootRequestId: message?.rootRequestId || null,
        });
        throw error;
      }
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