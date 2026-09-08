import crypto from 'crypto';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SFNClient, ListExecutionsCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { getRequiredSecret } from '/opt/nodejs/ssm-secrets.mjs';
import { lambdaHandler as requestProcessorHandler } from './request-processor.mjs';

const AWS_REGION = process.env.AWS_REGION || 'eu-west-2';
const TARGET_BUCKET = process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const PROCESSING_QUEUE_URL = process.env.SQS_QUEUE_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessing';
const FULL_ENRICH_STATE_MACHINE_ARN = (process.env.FULL_ENRICH_STATE_MACHINE_ARN || '').trim();
const DEFAULT_IMAGE_PROVIDER = normaliseImageProvider(process.env.IMAGE_GENERATION_PROVIDER || 'disabled');

const s3 = new S3Client({ region: AWS_REGION });
const sqs = new SQSClient({ region: AWS_REGION });
const sfn = new SFNClient({ region: AWS_REGION });

function text(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result || null;
}

function bool(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}

export function normaliseImageProvider(value) {
  const provider = text(value)?.toLowerCase() || 'disabled';
  return ['cloudflare', 'gemini', 'disabled'].includes(provider) ? provider : 'disabled';
}

function getMetadata(event) {
  return event && typeof event === 'object' && event.metadata && typeof event.metadata === 'object'
    ? event.metadata
    : {};
}

function getImageMetadata(event) {
  const metadataImage = getMetadata(event).image;
  if (metadataImage && typeof metadataImage === 'object') return metadataImage;
  return event && typeof event.image === 'object' ? event.image : {};
}

function getTagline(event) {
  return text(getMetadata(event).tagline ?? event?.tagline ?? null);
}

function getImageTheme(event) {
  return text(getImageMetadata(event).theme ?? event?.imageTheme ?? null);
}

function getImageUrl(event) {
  return text(getImageMetadata(event).url ?? event?.imageUrl ?? null);
}

export function determineStartStage(event) {
  if (!getTagline(event)) return 'tagline';
  if (!getImageTheme(event)) return 'imageTheme';
  if (!getImageUrl(event)) return 'image';
  return 'complete';
}

function getHexFromSubject(subject) {
  if (typeof subject === 'string') {
    const candidate = subject.trim().toLowerCase();
    return /^[0-9a-f]+$/i.test(candidate) ? candidate : null;
  }
  if (!subject || typeof subject !== 'object') return null;
  const candidate = text(subject.metadata?.hex ?? subject.hex ?? subject.requestHex ?? null)?.toLowerCase();
  return candidate && /^[0-9a-f]+$/i.test(candidate) ? candidate : null;
}

export function getHexFromMessage(message) {
  const direct = text(message?.requestHex ?? message?.hex ?? null)?.toLowerCase();
  if (direct && /^[0-9a-f]+$/i.test(direct)) return direct;
  return getHexFromSubject(message?.subject);
}

function requestedField(message) {
  return text(message?.subjectLabel ?? message?.subject);
}

function requestedStartStage(message) {
  const field = requestedField(message);
  if (field === 'tagline') return 'tagline';
  if (field === 'imageTheme') return 'imageTheme';
  if (field === 'imageUrl' || field === 'image') return 'image';
  return null;
}

export function isFullEnrichStageRequest(message) {
  return text(message?.realm) === 'scoutsRequest'
    && text(message?.action) === 'request'
    && text(message?.orchestrationType) === 'fullEnrich';
}

export function isDirectImageEnrichRequest(message) {
  return text(message?.realm) === 'scoutsRequest'
    && text(message?.action) === 'request'
    && !text(message?.orchestrationType)
    && requestedStartStage(message) === 'image';
}

export function isFullEnrichStartRequest(message) {
  if (text(message?.realm) !== 'scoutsRequest') return false;
  // `new`/`retry`/`imageEnrich` are accepted at the queue boundary so messages
  // produced by the calendar service before deployment are drained safely. All
  // of them enter the single full-enrich state machine; no legacy workflow is
  // selected by these aliases.
  return new Set(['new', 'retry', 'imageEnrich', 'fullEnrich']).has(text(message?.action));
}

export function isCompactPersistRequest(message) {
  return text(message?.realm) === 'persist' && text(message?.action) === 'persist';
}

function requestedStage(message) {
  const logical = requestedField(message);
  if (logical === 'tagline') return { realm: 'tagline', subjectLabel: 'tagline', stage: 'tagline' };
  if (logical === 'imageTheme') return { realm: 'imageTheme', subjectLabel: 'imageTheme', stage: 'imageTheme' };
  if (logical === 'imageUrl' || logical === 'image') return { realm: 'image', subjectLabel: 'imageUrl', stage: 'image' };
  return null;
}

export function translateFullEnrichStageRequest(message) {
  const stage = requestedStage(message);
  if (!stage) throw new Error(`Unsupported fullEnrich stage: ${requestedField(message) || 'missing'}`);
  const hex = getHexFromMessage(message);
  if (!hex) throw new Error('fullEnrich stage request missing HEX');

  return {
    realm: stage.realm,
    action: 'request',
    subject: hex,
    subjectLabel: stage.subjectLabel,
    hex,
    requestHex: text(message?.requestHex) || hex,
    requestId: text(message?.requestId),
    taskToken: text(message?.taskToken),
    orchestrationType: 'fullEnrich',
    orchestrationStep: text(message?.orchestrationStep) || stage.stage,
    source: text(message?.source) || 'scouts-full-enrich',
    requestMode: text(message?.requestMode) || 'auto',
    approvalMode: text(message?.approvalMode) || 'auto',
    ...(text(message?.imageProvider) ? { imageProvider: normaliseImageProvider(message.imageProvider) } : {}),
  };
}

export function translateCompactPersistRequest(message) {
  if (!isCompactPersistRequest(message)) throw new Error('Not a persist request');
  const subject = message?.subject && typeof message.subject === 'object' ? message.subject : {};
  const metadata = subject.metadata && typeof subject.metadata === 'object' ? subject.metadata : {};
  const metadataImage = metadata.image && typeof metadata.image === 'object' ? metadata.image : {};
  const metadataStatus = metadata.status && typeof metadata.status === 'object' ? metadata.status : {};
  const hex = getHexFromMessage(message);
  if (!hex) throw new Error('Persist request missing hex identifier');

  const canonicalMetadata = { hex };
  const tagline = text(metadata.tagline ?? subject.tagline ?? null);
  if (tagline !== null) canonicalMetadata.tagline = tagline;

  const imageTheme = text(metadataImage.theme ?? subject.imageTheme ?? subject.image?.theme ?? null);
  const imageUrl = text(metadataImage.url ?? subject.imageUrl ?? subject.image?.url ?? null);
  if (imageTheme !== null || imageUrl !== null) {
    canonicalMetadata.image = {};
    if (imageTheme !== null) canonicalMetadata.image.theme = imageTheme;
    if (imageUrl !== null) canonicalMetadata.image.url = imageUrl;
  }

  const isHidden = bool(metadataStatus.isHidden ?? subject.isHidden ?? subject.hidden ?? null);
  const isApproved = bool(metadataStatus.isApproved ?? subject.isApproved ?? subject.approved ?? null);
  if (isHidden !== null || isApproved !== null) {
    canonicalMetadata.status = {};
    if (isHidden !== null) canonicalMetadata.status.isHidden = isHidden;
    if (isApproved !== null) canonicalMetadata.status.isApproved = isApproved;
  }

  const patchFieldCount = Object.keys(canonicalMetadata).filter((key) => key !== 'hex').length;
  if (patchFieldCount === 0) throw new Error('Persist request did not include any patchable fields');

  return {
    realm: 'persist',
    action: 'persist',
    subject: { metadata: canonicalMetadata },
    hex,
    requestHex: text(message?.requestHex) || hex,
    requestId: text(message?.requestId),
    source: text(message?.source) || 'scouts2sqs',
  };
}

// The persistence processor owns the durable read/merge/write. Keep this
// handoff sparse so independent patches cannot overwrite one another with stale
// full-event snapshots. Its persistence contract accepts a JSON patch in the
// action field and a string HEX subject as the unambiguous target.
export function buildDownstreamPersistMessage(message) {
  const translated = translateCompactPersistRequest(message);
  return {
    ...translated,
    subject: translated.hex,
    action: JSON.stringify(translated.subject),
    operation: 'persist',
  };
}

export function eventGenerationKey(hex, event) {
  const metadata = getMetadata(event);
  const source = {
    hex,
    uid: event?.uid ?? event?.originalUid ?? metadata?.uid ?? null,
    title: event?.title ?? event?.summary ?? event?.name ?? null,
    description: event?.description ?? event?.details ?? null,
    location: event?.location ?? metadata?.location ?? null,
    start: event?.start?.raw ?? event?.start?.sortKey ?? event?.dtstart ?? null,
    end: event?.end?.raw ?? event?.end?.sortKey ?? event?.dtend ?? null,
    section: event?.section ?? metadata?.section ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 12);
}

function hexToken(hex) {
  const safe = String(hex || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  const visible = safe.slice(0, 10) || 'hex';
  const hash = crypto.createHash('sha256').update(safe || 'hex').digest('hex').slice(0, 10);
  return `${visible}-${hash}`;
}

function executionPrefix(hex, event) {
  return `full-${hexToken(hex)}-${eventGenerationKey(hex, event)}`.slice(0, 64);
}

function executionName(prefix) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const entropy = crypto.randomBytes(3).toString('hex');
  return `${prefix}-${timestamp}-${entropy}`.slice(0, 80);
}

export function shouldReuseActiveExecution(message) {
  // A manual image request represents a separate user action with its own
  // lifecycle/request ID. Reusing an older execution would make callbacks keep
  // the original request ID and leave this new request permanently queued.
  return !isDirectImageEnrichRequest(message);
}

export function buildFullEnrichExecutionInput(message, event, name = null) {
  const hex = getHexFromMessage(message) || getHexFromSubject(event);
  if (!hex) throw new Error('fullEnrich request missing HEX');
  const explicitStart = isDirectImageEnrichRequest(message) ? requestedStartStage(message) : null;
  const startStage = explicitStart || determineStartStage(event);
  const imageProvider = normaliseImageProvider(message?.imageProvider || DEFAULT_IMAGE_PROVIDER);
  const prefix = executionPrefix(hex, event);
  return {
    requestId: text(message?.requestId) || name || executionName(prefix),
    executionName: name || null,
    hex,
    requestHex: hex,
    source: text(message?.source) || 'scouts2sqs',
    orchestrationType: 'fullEnrich',
    requestMode: text(message?.requestMode) || 'auto',
    approvalMode: text(message?.approvalMode) || 'auto',
    imageProvider,
    startStage,
    generationKey: eventGenerationKey(hex, event),
  };
}

async function loadEvent(hex, fallback = null) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: TARGET_BUCKET, Key: `events/${hex}.json` }));
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
      return fallback && typeof fallback === 'object' ? fallback : null;
    }
    throw error;
  }
}

async function findActiveExecution(prefix) {
  if (!FULL_ENRICH_STATE_MACHINE_ARN) return null;
  let nextToken;
  do {
    const response = await sfn.send(new ListExecutionsCommand({
      stateMachineArn: FULL_ENRICH_STATE_MACHINE_ARN,
      statusFilter: 'RUNNING',
      maxResults: 100,
      ...(nextToken ? { nextToken } : {}),
    }));
    const match = (response.executions || []).find((item) => text(item?.name)?.startsWith(prefix));
    if (match) return match;
    nextToken = text(response.nextToken) || undefined;
  } while (nextToken);
  return null;
}

async function startFullEnrich(message) {
  if (!FULL_ENRICH_STATE_MACHINE_ARN) throw new Error('FULL_ENRICH_STATE_MACHINE_ARN is not configured');
  const hex = getHexFromMessage(message);
  if (!hex) throw new Error('fullEnrich request missing HEX');
  const fallback = message?.subject && typeof message.subject === 'object' ? message.subject : null;
  const event = await loadEvent(hex, fallback);
  if (!event) throw new Error(`HEX ${hex} not found`);

  const input = buildFullEnrichExecutionInput(message, event);
  if (input.startStage === 'complete') {
    console.log('[FullEnrich] Event already complete; no execution required', { hex, requestId: input.requestId });
    return { status: 'complete', input, reused: false };
  }
  if (input.imageProvider === 'disabled' && input.startStage === 'image') {
    console.warn('[FullEnrich] Image provider disabled; image-only enrichment is intentionally blocked', { hex, startStage: input.startStage, requestId: input.requestId });
    return { status: 'blocked', reason: 'image_provider_disabled', input, reused: false };
  }

  const prefix = executionPrefix(hex, event);
  const active = shouldReuseActiveExecution(message) ? await findActiveExecution(prefix) : null;
  if (active) {
    const reusedInput = { ...input, executionName: active.name || null };
    console.log('[FullEnrich] Reusing active execution', {
      hex,
      executionArn: active.executionArn || null,
      generationKey: input.generationKey,
      requestId: input.requestId,
      executionName: active.name || null,
    });
    return { status: 'running', executionArn: active.executionArn || null, input: reusedInput, reused: true };
  }

  const name = executionName(prefix);
  const finalInput = { ...input, executionName: name };
  const response = await sfn.send(new StartExecutionCommand({
    stateMachineArn: FULL_ENRICH_STATE_MACHINE_ARN,
    name,
    input: JSON.stringify(finalInput),
  }));
  console.log('[FullEnrich] Started execution', {
    hex,
    executionArn: response.executionArn || null,
    executionName: name,
    requestId: finalInput.requestId,
    startStage: finalInput.startStage,
    imageProvider: finalInput.imageProvider,
    generationKey: finalInput.generationKey,
  });
  return { status: 'started', executionArn: response.executionArn || null, input: finalInput, reused: false };
}

async function forwardStageRequest(message) {
  const translated = translateFullEnrichStageRequest(message);
  await sqs.send(new SendMessageCommand({ QueueUrl: PROCESSING_QUEUE_URL, MessageBody: JSON.stringify(translated) }));
  console.log('[FullEnrich] Forwarded callback stage to processing queue', {
    hex: translated.hex,
    stage: translated.orchestrationStep,
    provider: translated.imageProvider || null,
    requestId: translated.requestId || null,
  });
}

async function forwardPersistRequest(message) {
  const payload = buildDownstreamPersistMessage(message);
  await sqs.send(new SendMessageCommand({ QueueUrl: PROCESSING_QUEUE_URL, MessageBody: JSON.stringify(payload) }));
  console.log('[FullEnrich] Forwarded canonical sparse persist patch to processing queue', {
    hex: payload.hex,
    requestId: payload.requestId || null,
  });
}

function parseRecord(record) {
  if (!record || record.eventSource !== 'aws:sqs') return null;
  try { return typeof record.body === 'string' ? JSON.parse(record.body) : record.body; } catch { return null; }
}

function parseHttpBody(event) {
  try { return typeof event?.body === 'string' ? JSON.parse(event.body || '{}') : (event?.body || {}); } catch { return null; }
}

function getRequestApiKey(event) {
  const headers = event?.headers || {};
  const queryParams = event?.queryStringParameters || {};
  return text(
    headers['x-api-key']
    ?? headers['X-Api-Key']
    ?? headers['X-API-KEY']
    ?? headers['x_api_key']
    ?? queryParams.apiKey
    ?? queryParams.API_KEY
    ?? queryParams['x-api-key']
    ?? null,
  );
}

function constantTimeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''));
  const rightBuffer = Buffer.from(String(right ?? ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function isAuthorisedHttpRequest(event) {
  const requiredApiKey = await getRequiredSecret('REQUIRED_API_KEY_PARAMETER');
  return constantTimeEquals(getRequestApiKey(event), requiredApiKey);
}

async function handleMessage(message) {
  if (isCompactPersistRequest(message)) {
    await forwardPersistRequest(message);
    return { intercepted: true, result: { status: 'forwarded', requestId: text(message?.requestId) } };
  }
  if (isFullEnrichStageRequest(message)) {
    await forwardStageRequest(message);
    return { intercepted: true, result: { status: 'forwarded', requestId: text(message?.requestId) } };
  }
  if (isDirectImageEnrichRequest(message) || isFullEnrichStartRequest(message)) {
    return { intercepted: true, result: await startFullEnrich(message) };
  }
  return { intercepted: false, result: null };
}

export async function lambdaHandler(event) {
  const records = Array.isArray(event?.Records) ? event.Records : null;
  if (records) {
    const standardRecords = [];
    for (const record of records) {
      const message = parseRecord(record);
      if (!message) {
        standardRecords.push(record);
        continue;
      }
      try {
        const handled = await handleMessage(message);
        if (!handled.intercepted) standardRecords.push(record);
      } catch (error) {
        console.error('[FullEnrich] Intercepted request failed', {
          error: error?.message || String(error),
          action: message?.action || null,
          hex: getHexFromMessage(message),
          requestId: text(message?.requestId),
        });
        throw error;
      }
    }
    if (standardRecords.length > 0) return requestProcessorHandler({ ...event, Records: standardRecords });
    return { statusCode: 200, body: 'Canonical Scouts requests processed' };
  }

  const body = parseHttpBody(event);
  if (body && (
    isCompactPersistRequest(body)
    || isFullEnrichStageRequest(body)
    || isDirectImageEnrichRequest(body)
    || isFullEnrichStartRequest(body)
  )) {
    try {
      if (!await isAuthorisedHttpRequest(event)) {
        return {
          statusCode: 403,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: 'Forbidden: Invalid API Key' }),
        };
      }
      const handled = await handleMessage(body);
      if (handled.intercepted) {
        return {
          statusCode: 200,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify(handled.result),
        };
      }
    } catch (error) {
      console.error('[FullEnrich] HTTP orchestration request failed', error?.message || error);
      return {
        statusCode: 503,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: error?.message || String(error) }),
      };
    }
  }
  return requestProcessorHandler(event);
}
