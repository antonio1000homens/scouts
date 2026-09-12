import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  approvalIdempotencyKey,
  approvalOperationId,
  buildApprovedSnapshotPatch,
  compareEventReviewRevision,
} from './event-review.mjs';
import { recordRequestActivity } from './request-activity.mjs';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const IDEMPOTENCY_PREFIX = 'runtime/approval-idempotency/';
const CLAIM_TAKEOVER_MS = 30_000;
const s3 = new S3Client({ region: REGION });
const sqs = new SQSClient({ region: REGION });

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function bucketName() {
  return text(process.env.TARGET_BUCKET) || 'scouts-2ndtolworth-prod-553490163883';
}

function queueUrl() {
  return text(process.env.SCOUTS_REQUESTS_QUEUE_URL || process.env.SCOUTS_REQUEST_QUEUE_URL);
}

function normalizeHex(value) {
  const hex = text(value).toLowerCase();
  return hex && /^[0-9a-f]+$/i.test(hex) ? hex : '';
}

function notFound(error) {
  return error?.name === 'NoSuchKey'
    || error?.name === 'NotFound'
    || Number(error?.$metadata?.httpStatusCode) === 404;
}

function conditionalFailure(error) {
  return error?.name === 'PreconditionFailed' || Number(error?.$metadata?.httpStatusCode) === 412;
}

async function loadCanonicalEvent(hex) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucketName(), Key: `events/${hex}.json` }));
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

async function readIdempotencyRecord(key) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
    return {
      value: JSON.parse(await response.Body.transformToString()),
      eTag: text(response.ETag),
    };
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

async function writeIdempotencyRecord(key, value, options = {}) {
  return s3.send(new PutObjectCommand({
    Bucket: bucketName(),
    Key: key,
    Body: JSON.stringify(value, null, 2),
    ContentType: 'application/json',
    CacheControl: 'no-store',
    ...(options.ifNoneMatch ? { IfNoneMatch: options.ifNoneMatch } : {}),
    ...(options.ifMatch ? { IfMatch: options.ifMatch } : {}),
  }));
}

async function claimApprovalAction({ idempotencyKey, rootRequestId, revision, hex, requiresGeneratedImage }) {
  const key = `${IDEMPOTENCY_PREFIX}${idempotencyKey}.json`;
  const claimedAt = new Date().toISOString();
  const record = {
    state: 'claimed',
    idempotencyKey,
    rootRequestId,
    revision,
    hex,
    requiresGeneratedImage,
    claimedAt,
    updatedAt: claimedAt,
  };

  try {
    const response = await writeIdempotencyRecord(key, record, { ifNoneMatch: '*' });
    return { owned: true, key, eTag: text(response.ETag), record };
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
  }

  const existing = await readIdempotencyRecord(key);
  if (!existing?.value) {
    return claimApprovalAction({ idempotencyKey, rootRequestId, revision, hex, requiresGeneratedImage });
  }

  if (existing.value.state === 'queued' || existing.value.state === 'completed') {
    return { owned: false, key, existing: existing.value, eTag: existing.eTag };
  }

  const ageMs = Date.now() - Date.parse(existing.value.updatedAt || existing.value.claimedAt || '');
  if (!Number.isFinite(ageMs) || ageMs < CLAIM_TAKEOVER_MS || !existing.eTag) {
    return { owned: false, key, existing: existing.value, eTag: existing.eTag, pending: true };
  }

  try {
    const response = await writeIdempotencyRecord(key, {
      ...record,
      takeoverOf: existing.value.updatedAt || existing.value.claimedAt || null,
    }, { ifMatch: existing.eTag });
    return { owned: true, key, eTag: text(response.ETag), record };
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    const winner = await readIdempotencyRecord(key);
    return { owned: false, key, existing: winner?.value || existing.value, eTag: winner?.eTag || existing.eTag, pending: true };
  }
}

async function completeApprovalClaim(claim, result) {
  if (!claim?.owned || !claim?.key) return;
  const value = {
    ...(claim.record || {}),
    state: 'queued',
    result,
    updatedAt: new Date().toISOString(),
  };
  try {
    await writeIdempotencyRecord(claim.key, value, claim.eTag ? { ifMatch: claim.eTag } : {});
  } catch (error) {
    // Queue publication is authoritative. Losing the best-effort marker update
    // must not turn success into an HTTP failure that prompts another publish.
    console.warn('[ApprovalCoordinator] Unable to finalize idempotency record', error?.message || error);
  }
}

async function recordActivity(input) {
  try {
    return await recordRequestActivity(input);
  } catch (error) {
    console.warn('[ApprovalCoordinator] Activity write failed', error?.message || error);
    return null;
  }
}

async function publishChild(payload) {
  const targetQueue = queueUrl();
  if (!targetQueue) {
    const error = new Error('Scouts request queue URL is not configured');
    error.statusCode = 503;
    throw error;
  }
  const result = await sqs.send(new SendMessageCommand({
    QueueUrl: targetQueue,
    MessageBody: JSON.stringify(payload),
  }));
  await recordActivity({
    ...payload,
    messageId: result?.MessageId || null,
    state: 'queued',
    stage: 'scoutsRequests',
  });
  return result?.MessageId || null;
}

function existingApprovalRoot(canonical) {
  const marker = canonical?.approvalWorkflow;
  if (!marker || typeof marker !== 'object') return '';
  if (text(marker.state).toLowerCase() !== 'awaiting_review') return '';
  return text(marker.rootRequestId);
}

function reusedResult({ existing, rootRequestId, revision, renderedRevision, patch }) {
  if (existing?.result && typeof existing.result === 'object') {
    return { ...existing.result, ok: true, statusCode: 200, reused: true };
  }
  return {
    ok: true,
    statusCode: 200,
    status: 'ok',
    message: 'Approval already accepted and is being processed.',
    rootRequestId,
    requestId: rootRequestId,
    revision,
    baseRevision: renderedRevision,
    workflowState: patch.approval.nextState,
    requiresGeneratedImage: patch.approval.requiresGeneratedImage,
    requiresFinalImageReview: patch.approval.requiresFinalImageReview,
    queuedMessages: [],
    reused: true,
  };
}

export async function coordinateEventApproval({
  reviewSnapshot,
  baseRevision = null,
  rootRequestId = null,
  source = 'scouts-approval',
  childMetadata = null,
} = {}) {
  if (!reviewSnapshot || typeof reviewSnapshot !== 'object') {
    return { ok: false, statusCode: 400, error: 'Approval review snapshot is required' };
  }

  const hex = normalizeHex(reviewSnapshot.hex);
  if (!hex) {
    return { ok: false, statusCode: 400, error: 'Approval review snapshot requires a valid canonical HEX' };
  }

  let patch;
  try {
    patch = buildApprovedSnapshotPatch(reviewSnapshot);
  } catch (error) {
    return { ok: false, statusCode: 400, error: error?.message || 'Invalid approval review snapshot' };
  }

  const canonical = await loadCanonicalEvent(hex);
  if (!canonical) {
    return { ok: false, statusCode: 404, error: 'Event object not found', hex };
  }

  const renderedRevision = text(baseRevision) || text(reviewSnapshot.baseRevision) || text(reviewSnapshot.revision);
  const comparison = compareEventReviewRevision(canonical, renderedRevision);
  if (!comparison.ok) {
    return {
      ok: false,
      statusCode: 409,
      status: 'conflict',
      error: 'STALE_REVIEW',
      message: 'This event changed after the review was rendered. Reload the current review before approving.',
      submittedRevision: comparison.submittedRevision,
      currentRevision: comparison.currentRevision,
      currentReview: comparison.current,
      currentEvent: canonical,
    };
  }

  const finalReviewRoot = patch.approval.requiresGeneratedImage ? '' : existingApprovalRoot(canonical);
  const root = text(rootRequestId)
    || finalReviewRoot
    || approvalOperationId({ hex, revision: reviewSnapshot.revision, action: 'approve' });
  const idempotencyKey = approvalIdempotencyKey({
    rootRequestId: root,
    revision: reviewSnapshot.revision,
    action: 'approve',
  });
  const title = text(reviewSnapshot.title || canonical?.title || canonical?.summary) || null;
  const revision = text(reviewSnapshot.revision);

  const claim = await claimApprovalAction({
    idempotencyKey,
    rootRequestId: root,
    revision,
    hex,
    requiresGeneratedImage: patch.approval.requiresGeneratedImage,
  });
  if (!claim.owned) {
    return reusedResult({
      existing: claim.existing,
      rootRequestId: root,
      revision,
      renderedRevision,
      patch,
    });
  }

  const persistRequestId = `${root}:persist:${revision}`;
  const common = {
    hex,
    requestHex: hex,
    rootRequestId: root,
    source,
    title,
    approvalRevision: revision,
    approvalBaseRevision: renderedRevision,
    approvalIdempotencyKey: idempotencyKey,
    ...(childMetadata && typeof childMetadata === 'object' ? { approvalMetadata: childMetadata } : {}),
  };

  const persistPayload = {
    realm: 'persist',
    action: 'persist',
    subject: { metadata: patch.metadata },
    requestId: persistRequestId,
    approvalState: patch.approval.nextState,
    ...common,
  };
  await publishChild(persistPayload);

  const queuedMessages = [{ requestId: persistRequestId, type: 'persist' }];
  if (patch.approval.requiresGeneratedImage) {
    // Keep the approved revision in the child ID. Step Functions preserves
    // requestId through stage callbacks even while legacy templates omit newer
    // approval fields, so the image worker can still enforce concurrency at write time.
    const imageRequestId = `${root}:image:${revision}`;
    await publishChild({
      realm: 'scoutsRequest',
      action: 'imageEnrich',
      subject: { hex },
      requestId: imageRequestId,
      requestMode: 'auto',
      approvalMode: 'review_generated_image',
      ...common,
    });
    queuedMessages.push({ requestId: imageRequestId, type: 'image' });
    await recordActivity({
      requestId: root,
      rootRequestId: root,
      hex,
      title,
      action: 'approve',
      state: 'awaiting_image',
      stage: 'approval_accepted',
    });
  } else {
    await recordActivity({
      requestId: root,
      rootRequestId: root,
      hex,
      title,
      action: 'approve',
      state: 'persisting',
      stage: finalReviewRoot ? 'final_image_approval' : 'approval_persisting',
    });
  }

  const result = {
    ok: true,
    statusCode: 200,
    status: 'ok',
    message: patch.approval.requiresGeneratedImage
      ? 'Approved shown metadata. Generating image — final review required.'
      : (finalReviewRoot ? 'Generated image approved.' : 'Approved shown changes.'),
    rootRequestId: root,
    requestId: root,
    revision,
    baseRevision: renderedRevision,
    workflowState: patch.approval.nextState,
    requiresGeneratedImage: patch.approval.requiresGeneratedImage,
    requiresFinalImageReview: patch.approval.requiresFinalImageReview,
    queuedMessages,
    reused: false,
  };
  await completeApprovalClaim(claim, result);
  return result;
}
