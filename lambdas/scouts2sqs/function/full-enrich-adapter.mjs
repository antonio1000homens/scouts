import crypto from 'crypto';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SFNClient, ListExecutionsCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { lambdaHandler as legacyHandler } from './scouts2sqs.mjs';

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
  return text(getMetadata(event).tagline ?? event?.tagline ?? event?.AI ?? null);
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

export function isFullEnrichStageRequest(message) {
  return text(message?.realm) === 'scoutsRequest'
    && text(message?.action) === 'request'
    && text(message?.orchestrationType) === 'fullEnrich';
}

export function isFullEnrichStartRequest(message) {
  if (text(message?.realm) !== 'scoutsRequest') return false;
  return new Set(['new', 'retry', 'imageEnrich', 'fullEnrich']).has(text(message?.action));
}

function requestedStage(message) {
  const logical = text(message?.subjectLabel ?? message?.subject);
  if (logical === 'tagline') return { realm: 'tagline', subjectLabel: 'tagline', stage: 'tagline' };
  if (logical === 'imageTheme') return { realm: 'imageTheme', subjectLabel: 'imageTheme', stage: 'imageTheme' };
  if (logical === 'imageUrl' || logical === 'image') return { realm: 'image', subjectLabel: 'imageUrl', stage: 'image' };
  return null;
}

export function translateFullEnrichStageRequest(message) {
  const stage = requestedStage(message);
  if (!stage) throw new Error(`Unsupported fullEnrich stage: ${text(message?.subjectLabel ?? message?.subject) || 'missing'}`);
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

export function eventGenerationKey(hex, event) {
  // Only source-event identity/content belongs here. Enrichment outputs (tagline,
  // theme, image URL) deliberately do not: they change during one execution and
  // would otherwise make reconciliation fail to recognise that execution as active.
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
  return `${prefix}-${timestamp}`.slice(0, 80);
}

export function buildFullEnrichExecutionInput(message, event, name = null) {
  const hex = getHexFromMessage(message) || getHexFromSubject(event);
  if (!hex) throw new Error('fullEnrich request missing HEX');
  const startStage = determineStartStage(event);
  const imageProvider = normaliseImageProvider(message?.imageProvider || DEFAULT_IMAGE_PROVIDER);
  const prefix = executionPrefix(hex, event);
  return {
    requestId: name || text(message?.requestId) || executionName(prefix),
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
    console.log('[FullEnrich] Event already complete; no execution required', { hex });
    return { status: 'complete', input, reused: false };
  }
  if (input.imageProvider === 'disabled') {
    console.warn('[FullEnrich] Image provider disabled; not starting incomplete enrichment', { hex, startStage: input.startStage });
    return { status: 'blocked', reason: 'image_provider_disabled', input, reused: false };
  }

  const prefix = executionPrefix(hex, event);
  const active = await findActiveExecution(prefix);
  if (active) {
    console.log('[FullEnrich] Reusing active execution', {
      hex,
      executionArn: active.executionArn || null,
      generationKey: input.generationKey,
    });
    return { status: 'running', executionArn: active.executionArn || null, input, reused: true };
  }

  const name = executionName(prefix);
  const finalInput = { ...input, requestId: name };
  const response = await sfn.send(new StartExecutionCommand({
    stateMachineArn: FULL_ENRICH_STATE_MACHINE_ARN,
    name,
    input: JSON.stringify(finalInput),
  }));
  console.log('[FullEnrich] Started execution', {
    hex,
    executionArn: response.executionArn || null,
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
  });
}

function parseRecord(record) {
  if (!record || record.eventSource !== 'aws:sqs') return null;
  try { return typeof record.body === 'string' ? JSON.parse(record.body) : record.body; } catch { return null; }
}

function parseHttpBody(event) {
  try { return typeof event?.body === 'string' ? JSON.parse(event.body || '{}') : (event?.body || {}); } catch { return null; }
}

async function handleMessage(message) {
  if (isFullEnrichStageRequest(message)) {
    await forwardStageRequest(message);
    return { intercepted: true, result: { status: 'forwarded' } };
  }
  if (isFullEnrichStartRequest(message)) {
    return { intercepted: true, result: await startFullEnrich(message) };
  }
  return { intercepted: false, result: null };
}

export async function lambdaHandler(event) {
  const records = Array.isArray(event?.Records) ? event.Records : null;
  if (records) {
    const delegatedRecords = [];
    for (const record of records) {
      const message = parseRecord(record);
      if (!message) {
        delegatedRecords.push(record);
        continue;
      }
      try {
        const handled = await handleMessage(message);
        if (!handled.intercepted) delegatedRecords.push(record);
      } catch (error) {
        // Never fall back to the legacy image state machine after a full-enrich start failure.
        console.error('[FullEnrich] Intercepted request failed', {
          error: error?.message || String(error),
          action: message?.action || null,
          hex: getHexFromMessage(message),
        });
        throw error;
      }
    }
    if (delegatedRecords.length > 0) return legacyHandler({ ...event, Records: delegatedRecords });
    return { statusCode: 200, body: 'Full enrichment requests processed' };
  }

  const body = parseHttpBody(event);
  if (body) {
    try {
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
  return legacyHandler(event);
}
