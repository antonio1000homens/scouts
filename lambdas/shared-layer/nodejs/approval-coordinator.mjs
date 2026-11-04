import crypto from 'node:crypto';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
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
const IDEMPOTENCY_FEED = 'approval-idempotency';
const IDEMPOTENCY_REQUEST_PREFIX = 'approval-idempotency#';
const CLAIM_TAKEOVER_MS = 30_000;
const defaultS3 = new S3Client({ region: REGION });
const defaultDynamoDB = new DynamoDBClient({ region: REGION });
let s3 = defaultS3;
let dynamodb = defaultDynamoDB;
let idempotencyBackend = String(process.env.SCOUTS_APPROVAL_IDEMPOTENCY_BACKEND || 's3').trim().toLowerCase();
let idempotencyTableName = String(process.env.SCOUTS_REQUEST_ACTIVITY_TABLE_NAME || 'scouts-request-activity').trim();
const sqs = new SQSClient({ region: REGION });

export function setApprovalIdempotencyClientsForTests({ s3Client, dynamoClient, backend, tableName } = {}) {
  if (s3Client) s3 = s3Client;
  if (dynamoClient) dynamodb = dynamoClient;
  if (backend) idempotencyBackend = String(backend).toLowerCase();
  if (tableName) idempotencyTableName = String(tableName);
}

export function resetApprovalIdempotencyClientsForTests() {
  s3 = defaultS3;
  dynamodb = defaultDynamoDB;
  idempotencyBackend = String(process.env.SCOUTS_APPROVAL_IDEMPOTENCY_BACKEND || 's3').trim().toLowerCase();
  idempotencyTableName = String(process.env.SCOUTS_REQUEST_ACTIVITY_TABLE_NAME || 'scouts-request-activity').trim();
}

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

function ddbConditionalFailure(error) {
  return error?.name === 'ConditionalCheckFailedException';
}

function ddbKey(idempotencyKey) {
  return { requestId: { S: `${IDEMPOTENCY_REQUEST_PREFIX}${idempotencyKey}` } };
}

function unmarshallIdempotencyItem(item) {
  if (!item) return null;
  const value = {};
  for (const [key, attribute] of Object.entries(item)) {
    if (attribute?.S !== undefined) value[key] = attribute.S;
    else if (attribute?.N !== undefined) value[key] = Number(attribute.N);
    else if (attribute?.BOOL !== undefined) value[key] = attribute.BOOL;
  }
  if (typeof value.resultJson === 'string') {
    try { value.result = JSON.parse(value.resultJson); } catch { value.result = null; }
    delete value.resultJson;
  }
  return value;
}

function marshallIdempotencyRecord(idempotencyKey, record, { claimToken = null, sourceETag = null } = {}) {
  const item = {
    ...ddbKey(idempotencyKey),
    feed: { S: IDEMPOTENCY_FEED },
    idempotencyKey: { S: idempotencyKey },
    state: { S: text(record.state) || 'claimed' },
    rootRequestId: { S: text(record.rootRequestId) },
    revision: { S: text(record.revision) },
    hex: { S: text(record.hex) },
    requiresGeneratedImage: { BOOL: record.requiresGeneratedImage === true },
    createdAt: { S: text(record.claimedAt || record.updatedAt) || new Date().toISOString() },
    updatedAt: { S: text(record.updatedAt || record.claimedAt) || new Date().toISOString() },
  };
  if (record.claimedAt) item.claimedAt = { S: text(record.claimedAt) };
  if (record.takeoverOf) item.takeoverOf = { S: text(record.takeoverOf) };
  if (claimToken) item.claimToken = { S: claimToken };
  if (sourceETag) item.sourceETag = { S: sourceETag };
  if (record.result && typeof record.result === 'object') item.resultJson = { S: JSON.stringify(record.result) };
  return item;
}

async function readDynamoDBIdempotencyRecord(idempotencyKey) {
  if (!idempotencyTableName) throw new Error('Scouts request activity table is not configured');
  const response = await dynamodb.send(new GetItemCommand({
    TableName: idempotencyTableName,
    Key: ddbKey(idempotencyKey),
    ConsistentRead: true,
  }));
  return unmarshallIdempotencyItem(response?.Item);
}

async function putDynamoDBIdempotencyRecord(idempotencyKey, record, extras = {}) {
  if (!idempotencyTableName) throw new Error('Scouts request activity table is not configured');
  return dynamodb.send(new PutItemCommand({
    TableName: idempotencyTableName,
    Item: marshallIdempotencyRecord(idempotencyKey, record, extras),
    ConditionExpression: 'attribute_not_exists(requestId)',
  }));
}

function requireIdempotencyBackend() {
  if (!['s3', 'dual', 'dynamodb'].includes(idempotencyBackend)) {
    throw new Error(`Unsupported approval idempotency backend: ${idempotencyBackend}`);
  }
  if (idempotencyBackend !== 's3' && !idempotencyTableName) {
    throw new Error('Scouts request activity table is not configured');
  }
  return idempotencyBackend;
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

async function claimApprovalActionWithS3({ idempotencyKey, rootRequestId, revision, hex, requiresGeneratedImage }) {
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

async function claimApprovalActionWithDynamoDB({ idempotencyKey, rootRequestId, revision, hex, requiresGeneratedImage }) {
  const claimedAt = new Date().toISOString();
  const claimToken = crypto.randomUUID();
  const record = {
    state: 'claimed', idempotencyKey, rootRequestId, revision, hex,
    requiresGeneratedImage, claimedAt, updatedAt: claimedAt,
  };
  try {
    await putDynamoDBIdempotencyRecord(idempotencyKey, record, { claimToken });
    return { owned: true, backend: 'dynamodb', idempotencyKey, claimToken, record };
  } catch (error) {
    if (!ddbConditionalFailure(error)) throw error;
  }

  const existing = await readDynamoDBIdempotencyRecord(idempotencyKey);
  if (!existing) return claimApprovalActionWithDynamoDB({ idempotencyKey, rootRequestId, revision, hex, requiresGeneratedImage });
  if (existing.state === 'queued' || existing.state === 'completed') {
    return { owned: false, backend: 'dynamodb', idempotencyKey, existing };
  }

  const ageMs = Date.now() - Date.parse(existing.updatedAt || existing.claimedAt || '');
  if (!Number.isFinite(ageMs) || ageMs < CLAIM_TAKEOVER_MS || !existing.updatedAt) {
    return { owned: false, backend: 'dynamodb', idempotencyKey, existing, pending: true };
  }

  const takeoverAt = new Date().toISOString();
  const takeoverToken = crypto.randomUUID();
  const takeoverRecord = {
    ...record,
    claimedAt: takeoverAt,
    updatedAt: takeoverAt,
    takeoverOf: existing.updatedAt,
  };
  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: idempotencyTableName,
      Key: ddbKey(idempotencyKey),
      UpdateExpression: 'SET #state = :claimed, idempotencyKey = :idempotencyKey, rootRequestId = :rootRequestId, revision = :revision, hex = :hex, requiresGeneratedImage = :requiresGeneratedImage, claimedAt = :claimedAt, updatedAt = :updatedAt, takeoverOf = :takeoverOf, claimToken = :claimToken',
      ConditionExpression: '#state = :observedState AND updatedAt = :observedUpdatedAt',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':claimed': { S: 'claimed' },
        ':idempotencyKey': { S: idempotencyKey },
        ':rootRequestId': { S: rootRequestId },
        ':revision': { S: revision },
        ':hex': { S: hex },
        ':requiresGeneratedImage': { BOOL: requiresGeneratedImage === true },
        ':claimedAt': { S: takeoverAt },
        ':updatedAt': { S: takeoverAt },
        ':takeoverOf': { S: existing.updatedAt },
        ':claimToken': { S: takeoverToken },
        ':observedState': { S: existing.state },
        ':observedUpdatedAt': { S: existing.updatedAt },
      },
    }));
    return { owned: true, backend: 'dynamodb', idempotencyKey, claimToken: takeoverToken, record: takeoverRecord };
  } catch (error) {
    if (!ddbConditionalFailure(error)) throw error;
    const winner = await readDynamoDBIdempotencyRecord(idempotencyKey);
    return { owned: false, backend: 'dynamodb', idempotencyKey, existing: winner || existing, pending: true };
  }
}

async function mirrorDualClaimToDynamoDB(claim, identity) {
  const claimToken = crypto.randomUUID();
  try {
    await putDynamoDBIdempotencyRecord(identity.idempotencyKey, claim.record, {
      claimToken,
      sourceETag: claim.eTag,
    });
    return { ...claim, backend: 'dual', idempotencyKey: identity.idempotencyKey, claimToken };
  } catch (error) {
    if (!ddbConditionalFailure(error)) throw error;
  }

  const existing = await readDynamoDBIdempotencyRecord(identity.idempotencyKey);
  if (existing?.state === 'queued' || existing?.state === 'completed') {
    return { owned: false, backend: 'dual', idempotencyKey: identity.idempotencyKey, existing };
  }
  const ageMs = Date.now() - Date.parse(existing?.updatedAt || existing?.claimedAt || '');
  if (!existing?.updatedAt || !Number.isFinite(ageMs) || ageMs < CLAIM_TAKEOVER_MS) {
    return { owned: false, backend: 'dual', idempotencyKey: identity.idempotencyKey, existing, pending: true };
  }

  const claimTokenAfterTakeover = crypto.randomUUID();
  const takeoverRecord = {
    ...claim.record,
    takeoverOf: existing.updatedAt,
  };
  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: idempotencyTableName,
      Key: ddbKey(identity.idempotencyKey),
      UpdateExpression: 'SET #state = :claimed, idempotencyKey = :idempotencyKey, rootRequestId = :rootRequestId, revision = :revision, hex = :hex, requiresGeneratedImage = :requiresGeneratedImage, claimedAt = :claimedAt, updatedAt = :updatedAt, takeoverOf = :takeoverOf, claimToken = :claimToken, sourceETag = :sourceETag',
      ConditionExpression: '#state = :observedState AND updatedAt = :observedUpdatedAt',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':claimed': { S: 'claimed' },
        ':idempotencyKey': { S: identity.idempotencyKey },
        ':rootRequestId': { S: identity.rootRequestId },
        ':revision': { S: identity.revision },
        ':hex': { S: identity.hex },
        ':requiresGeneratedImage': { BOOL: identity.requiresGeneratedImage === true },
        ':claimedAt': { S: text(claim.record.claimedAt) },
        ':updatedAt': { S: text(claim.record.updatedAt) },
        ':takeoverOf': { S: existing.updatedAt },
        ':claimToken': { S: claimTokenAfterTakeover },
        ':sourceETag': { S: text(claim.eTag) },
        ':observedState': { S: existing.state },
        ':observedUpdatedAt': { S: existing.updatedAt },
      },
    }));
    return { ...claim, record: takeoverRecord, backend: 'dual', idempotencyKey: identity.idempotencyKey, claimToken: claimTokenAfterTakeover };
  } catch (error) {
    if (!ddbConditionalFailure(error)) throw error;
    const winner = await readDynamoDBIdempotencyRecord(identity.idempotencyKey);
    return { owned: false, backend: 'dual', idempotencyKey: identity.idempotencyKey, existing: winner || existing, pending: true };
  }
}

export async function claimApprovalAction(input) {
  const backend = requireIdempotencyBackend();
  if (backend === 'dynamodb') return claimApprovalActionWithDynamoDB(input);
  const claim = await claimApprovalActionWithS3(input);
  if (backend !== 'dual' || !claim?.owned) return { ...claim, backend: 's3' };
  return mirrorDualClaimToDynamoDB(claim, input);
}

async function completeDynamoDBClaim(claim, result) {
  if (!claim?.owned || !claim?.idempotencyKey || !claim?.claimToken) return false;
  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: idempotencyTableName,
      Key: ddbKey(claim.idempotencyKey),
      UpdateExpression: 'SET #state = :queued, resultJson = :result, updatedAt = :updatedAt',
      ConditionExpression: '#state = :claimed AND claimToken = :claimToken',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':claimed': { S: 'claimed' },
        ':queued': { S: 'queued' },
        ':claimToken': { S: claim.claimToken },
        ':result': { S: JSON.stringify(result) },
        ':updatedAt': { S: new Date().toISOString() },
      },
    }));
    return true;
  } catch (error) {
    if (!ddbConditionalFailure(error)) throw error;
    return false;
  }
}

async function completeApprovalClaim(claim, result) {
  if (!claim?.owned) return;
  if (claim.backend === 'dynamodb') {
    try {
      await completeDynamoDBClaim(claim, result);
    } catch (error) {
      console.warn('[ApprovalCoordinator] Unable to finalize DynamoDB idempotency record', error?.message || error);
    }
    return;
  }
  if (!claim.key) return;
  const value = {
    ...(claim.record || {}),
    state: 'queued',
    result,
    updatedAt: new Date().toISOString(),
  };
  try {
    const response = await writeIdempotencyRecord(claim.key, value, claim.eTag ? { ifMatch: claim.eTag } : {});
    if (claim.backend === 'dual' && claim.idempotencyKey && claim.claimToken) {
      await completeDynamoDBClaim(claim, value.result);
      if (response?.ETag) claim.eTag = text(response.ETag);
    }
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
