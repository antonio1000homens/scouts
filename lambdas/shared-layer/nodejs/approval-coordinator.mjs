import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  approvalIdempotencyKey,
  approvalOperationId,
  buildApprovedSnapshotPatch,
  compareEventReviewRevision,
} from './event-review.mjs';
import { recordRequestActivity } from './request-activity.mjs';

const REGION = process.env.AWS_REGION || 'eu-west-2';
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

async function loadCanonicalEvent(hex) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucketName(), Key: `events/${hex}.json` }));
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
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

  return {
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
  };
}
