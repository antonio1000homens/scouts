import crypto from 'crypto';
import { readFileSync } from 'fs';
import sharp from 'sharp';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SFNClient, SendTaskFailureCommand, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { getOptionalSecret } from '/opt/nodejs/ssm-secrets.mjs';
import {
  buildGenerationId,
  getEnrichmentState,
  reserveEnrichmentAttempt,
  markGeminiSucceeded,
  markEnrichmentSucceeded,
  markEnrichmentFailure,
  loadReusableGeneration,
  evaluateEnrichmentEligibility,
  claimEnrichmentEscalation,
  enrichmentStateConfig,
} from '/opt/nodejs/enrichment-state.mjs';
import { lambdaHandler as legacyHandler } from './sqs2scouts.mjs';
import {
  text,
  normaliseStage,
  isFullEnrichMessage,
  normaliseImageProvider,
  nextUtcDay,
  classifyCloudflareError,
  buildCallbackResultFromState,
  buildImageGenerationPrompt,
} from './full-enrich-helpers.mjs';

const AWS_REGION = process.env.AWS_REGION || 'eu-west-2';
const TARGET_BUCKET = process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const EVENT_IMAGE_PREFIX = 'website/eventImages/';
const GEMINI_PROMPT_VERSION = text(process.env.GEMINI_PROMPT_VERSION) || '1';
const USAGE_TABLE_NAME = text(process.env.GEMINI_USAGE_TABLE_NAME);
const ENRICHMENT_TABLE_NAME = text(process.env.GEMINI_ENRICHMENT_STATE_TABLE_NAME);
const IMAGE_DAILY_REQUEST_LIMIT = Number.isFinite(Number(process.env.IMAGE_GENERATION_DAILY_REQUEST_LIMIT))
  ? Math.max(0, Math.floor(Number(process.env.IMAGE_GENERATION_DAILY_REQUEST_LIMIT)))
  : 0;
const CLOUDFLARE_ACCOUNT_ID = text(process.env.CLOUDFLARE_ACCOUNT_ID);
const CLOUDFLARE_MODEL = text(process.env.CLOUDFLARE_AI_MODEL) || '@cf/black-forest-labs/flux-1-schnell';
const CLOUDFLARE_STEPS = Number.isFinite(Number(process.env.CLOUDFLARE_AI_STEPS))
  ? Math.min(8, Math.max(1, Math.floor(Number(process.env.CLOUDFLARE_AI_STEPS))))
  : 4;
const IMAGE_WIDTH = Number.isFinite(Number(process.env.GEMINI_IMAGE_OUTPUT_WIDTH))
  ? Math.max(320, Number(process.env.GEMINI_IMAGE_OUTPUT_WIDTH))
  : 1366;
const IMAGE_HEIGHT = Number.isFinite(Number(process.env.GEMINI_IMAGE_OUTPUT_HEIGHT))
  ? Math.max(180, Number(process.env.GEMINI_IMAGE_OUTPUT_HEIGHT))
  : 768;
const SLACK_WEBHOOK_URL = text(process.env.SLACK_WEBHOOK_URL) || 'https://slack.com/api/chat.postMessage';
const SLACK_CHANNEL = '#scouts';

const s3 = new S3Client({ region: AWS_REGION });
const sfn = new SFNClient({ region: AWS_REGION });
const dynamo = new DynamoDBClient({ region: AWS_REGION });

function usageDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function ttlEpoch(now = new Date()) {
  return Math.floor(now.getTime() / 1000) + (90 * 24 * 60 * 60);
}

function getHex(message) {
  const candidate = text(message?.requestHex ?? message?.hex ?? null)?.toLowerCase();
  if (candidate && /^[0-9a-f]+$/i.test(candidate)) return candidate;
  if (typeof message?.subject === 'string') {
    const subject = message.subject.trim().toLowerCase();
    if (/^[0-9a-f]+$/i.test(subject)) return subject;
  }
  return null;
}

function getMetadata(event) {
  return event && typeof event.metadata === 'object' && event.metadata ? event.metadata : {};
}

function getImageMetadata(event) {
  const image = getMetadata(event).image;
  return image && typeof image === 'object' ? image : {};
}

function stageFieldPresent(event, stage) {
  if (!event) return false;
  if (stage === 'tagline') return Boolean(text(getMetadata(event).tagline));
  if (stage === 'imageTheme') return Boolean(text(getImageMetadata(event).theme));
  if (stage === 'image') return Boolean(text(getImageMetadata(event).url));
  return false;
}

async function loadEvent(hex) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: TARGET_BUCKET, Key: `events/${hex}.json` }));
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function saveEvent(hex, event) {
  await s3.send(new PutObjectCommand({
    Bucket: TARGET_BUCKET,
    Key: `events/${hex}.json`,
    Body: JSON.stringify(event, null, 2),
    ContentType: 'application/json',
    CacheControl: 'no-store',
  }));
}

function getScoutsConfig() {
  const candidates = [new URL('./scouts.conf', import.meta.url), new URL('../scouts.conf', import.meta.url)];
  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  throw new Error('Bundled scouts.conf not found');
}

function providerGenerationId(hex, provider, event) {
  const base = buildGenerationId(hex, 'image', event, GEMINI_PROMPT_VERSION);
  if (provider === 'gemini') return base;
  return crypto.createHash('sha256').update(`${base}:${provider}`).digest('hex');
}

function emitImageMetric(provider, outcome) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'Scouts/ImageGeneration',
        Dimensions: [['Provider', 'Outcome']],
        Metrics: [{ Name: 'Requests', Unit: 'Count' }],
      }],
    },
    Provider: provider,
    Outcome: outcome,
    Requests: 1,
  }));
}

async function reserveImageBudget(provider, now = new Date()) {
  if (!USAGE_TABLE_NAME || IMAGE_DAILY_REQUEST_LIMIT <= 0) {
    emitImageMetric(provider, 'quota_rejected');
    return false;
  }
  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: USAGE_TABLE_NAME,
      Key: {
        usageDay: { S: usageDay(now) },
        usageScope: { S: `image#${provider}` },
      },
      UpdateExpression: 'SET #expiresAt = :expiresAt ADD #requestCount :one',
      ConditionExpression: 'attribute_not_exists(#requestCount) OR #requestCount < :limit',
      ExpressionAttributeNames: {
        '#expiresAt': 'expiresAt',
        '#requestCount': 'requestCount',
      },
      ExpressionAttributeValues: {
        ':expiresAt': { N: String(ttlEpoch(now)) },
        ':one': { N: '1' },
        ':limit': { N: String(IMAGE_DAILY_REQUEST_LIMIT) },
      },
    }));
    emitImageMetric(provider, 'attempt');
    return true;
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      emitImageMetric(provider, 'quota_rejected');
      return false;
    }
    console.error('[ImageGeneration] Daily quota counter unavailable; blocking provider request', error?.message || error);
    emitImageMetric(provider, 'quota_counter_error');
    return false;
  }
}

async function markQuotaDeferralWithoutAttempt({
  hex,
  attemptCount = 0,
  error,
  errorType = 'PROVIDER_QUOTA',
  attemptWasReserved = false,
  now = new Date(),
}) {
  if (!ENRICHMENT_TABLE_NAME) return null;
  const persistedAttemptCount = attemptWasReserved
    ? Math.max(0, Number(attemptCount || 0) - 1)
    : Math.max(0, Number(attemptCount || 0));
  const nextRetryAt = nextUtcDay(now);
  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: ENRICHMENT_TABLE_NAME,
      Key: { hex: { S: hex }, stage: { S: 'image' } },
      UpdateExpression: 'SET #state = :state, #attemptCount = :attemptCount, #lastErrorType = :errorType, #lastErrorMessage = :errorMessage, #nextRetryAt = :nextRetryAt, #updatedAt = :updatedAt, #expiresAt = :expiresAt REMOVE #inProgressExpiresAt',
      ConditionExpression: 'attribute_not_exists(#state) OR (#state <> :manualReview AND #state <> :succeeded)',
      ExpressionAttributeNames: {
        '#state': 'state',
        '#attemptCount': 'attemptCount',
        '#lastErrorType': 'lastErrorType',
        '#lastErrorMessage': 'lastErrorMessage',
        '#nextRetryAt': 'nextRetryAt',
        '#updatedAt': 'updatedAt',
        '#expiresAt': 'expiresAt',
        '#inProgressExpiresAt': 'inProgressExpiresAt',
      },
      ExpressionAttributeValues: {
        ':state': { S: 'retry_wait' },
        ':manualReview': { S: 'manual_review' },
        ':succeeded': { S: 'succeeded' },
        ':attemptCount': { N: String(persistedAttemptCount) },
        ':errorType': { S: errorType },
        ':errorMessage': { S: String(error?.message || error || 'Image provider quota exhausted').slice(0, 500) },
        ':nextRetryAt': { S: nextRetryAt },
        ':updatedAt': { S: now.toISOString() },
        ':expiresAt': { N: String(ttlEpoch(now)) },
      },
    }));
  } catch (updateError) {
    if (updateError?.name !== 'ConditionalCheckFailedException') throw updateError;
  }
  return getEnrichmentState(hex, 'image');
}

async function sendSlackText(textValue) {
  const token = await getOptionalSecret('SLACK_BOT_TOKEN_PARAMETER', '').catch(() => '');
  if (!token) return;
  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text: textValue }),
  });
  if (!response.ok) throw new Error(`Slack HTTP ${response.status}`);
}

async function notifyTransition(stage, state, details = {}) {
  if (!state) return;
  const attemptCount = Number(state.attemptCount || 0);
  if (state.state === 'retry_wait' && attemptCount === 2) {
    await sendSlackText(`⚠️ Scouts enrichment retry warning\n\nHEX: ${details.hex}\nStage: ${stage}\nProvider: ${details.provider || 'n/a'}\nAttempts: ${attemptCount} / ${enrichmentStateConfig.MAX_ATTEMPTS}\nLast error: ${state.lastErrorType || 'UNKNOWN'}: ${state.lastErrorMessage || 'unknown'}\nNext retry: ${state.nextRetryAt || 'unknown'}\nRequest ID: ${details.requestId || 'unknown'}`).catch(() => {});
  }
  if (state.state === 'manual_review') {
    const claimed = await claimEnrichmentEscalation({ hex: details.hex, stage }).catch(() => false);
    if (claimed) {
      await sendSlackText(`🚨 Scouts enrichment suspended\n\nHEX: ${details.hex}\nStage: ${stage}\nProvider: ${details.provider || 'n/a'}\nAttempts: ${attemptCount}\nLast error: ${state.lastErrorType || 'UNKNOWN'}: ${state.lastErrorMessage || 'unknown'}\nRequest ID: ${details.requestId || 'unknown'}`).catch(() => {});
    }
  }
}

function cloudflareApiError(response, body) {
  const firstError = Array.isArray(body?.errors) ? body.errors[0] : null;
  const error = new Error(text(firstError?.message) || text(body?.message) || `Cloudflare Workers AI HTTP ${response.status}`);
  error.status = response.status;
  const providerCode = Number(firstError?.code ?? body?.code);
  if (Number.isFinite(providerCode)) error.providerCode = providerCode;
  return error;
}

async function callCloudflare(prompt) {
  if (!CLOUDFLARE_ACCOUNT_ID) throw new Error('CLOUDFLARE_ACCOUNT_ID is not configured');
  const token = await getOptionalSecret('CLOUDFLARE_AI_API_TOKEN_PARAMETER', '');
  if (!token) throw new Error('Cloudflare Workers AI API token is not configured');
  const modelPath = CLOUDFLARE_MODEL.replace(/^\/+/, '');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${modelPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, steps: CLOUDFLARE_STEPS }),
  });
  const raw = await response.text();
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
  if (!response.ok || payload?.success === false) throw cloudflareApiError(response, payload);
  const image = text(payload?.result?.image ?? payload?.image ?? null);
  if (!image) throw new Error('Cloudflare Workers AI returned no image data');
  return Buffer.from(image, 'base64');
}

function safeKeyPart(value, fallback = 'event') {
  const result = String(value || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return result || fallback;
}

async function uploadCloudflareImage(buffer, { hex, requestId }) {
  const jpeg = await sharp(buffer)
    .rotate()
    .trim()
    .resize({ width: IMAGE_WIDTH, height: IMAGE_HEIGHT, fit: 'inside', withoutEnlargement: true })
    .jpeg({ mozjpeg: true, quality: 85 })
    .toBuffer();
  const key = `${EVENT_IMAGE_PREFIX}${safeKeyPart(hex, 'hex')}-${safeKeyPart(requestId, String(Date.now()))}-cloudflare.jpg`;
  await s3.send(new PutObjectCommand({
    Bucket: TARGET_BUCKET,
    Key: key,
    Body: jpeg,
    ContentType: 'image/jpeg',
    CacheControl: 'public, max-age=31536000',
  }));
  return key;
}

async function persistGeneratedImage({ hex, event, generatedValue, generationId }) {
  event.metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  event.metadata.image = event.metadata.image && typeof event.metadata.image === 'object' ? event.metadata.image : {};
  event.metadata.status = event.metadata.status && typeof event.metadata.status === 'object' ? event.metadata.status : {};
  event.metadata.image.url = generatedValue.relativeUrl;
  event.metadata.status.isApproved = false;
  await saveEvent(hex, event);
  await markEnrichmentSucceeded({ hex, stage: 'image', generationId });
}

async function processCloudflareImage(message) {
  const hex = getHex(message);
  if (!hex) throw new Error('Cloudflare fullEnrich image request missing HEX');
  const event = await loadEvent(hex);
  if (!event) throw new Error(`HEX ${hex} not found`);
  const imageTheme = text(getImageMetadata(event).theme);
  const prompt = buildImageGenerationPrompt(imageTheme, getScoutsConfig());
  if (!prompt) throw new Error(`HEX ${hex} is missing a valid image theme/prompt configuration`);
  const generationId = providerGenerationId(hex, 'cloudflare', event);

  const reusable = await loadReusableGeneration({ hex, stage: 'image', generationId }).catch(() => null);
  if (reusable?.generatedValue?.relativeUrl) {
    await persistGeneratedImage({ hex, event, generatedValue: reusable.generatedValue, generationId });
    emitImageMetric('cloudflare', 'reused');
    const state = await getEnrichmentState(hex, 'image');
    return buildCallbackResultFromState({ state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: 'succeeded' });
  }

  const currentState = await getEnrichmentState(hex, 'image').catch(() => null);
  const eligibility = evaluateEnrichmentEligibility(currentState, new Date(), generationId);
  if (!eligibility.eligible) {
    return buildCallbackResultFromState({ state: currentState, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: eligibility.reason });
  }

  if (!await reserveImageBudget('cloudflare')) {
    const state = await markQuotaDeferralWithoutAttempt({
      hex,
      attemptCount: currentState?.attemptCount || 0,
      error: new Error('Image generation daily safety limit reached'),
      errorType: 'GLOBAL_QUOTA',
    });
    return buildCallbackResultFromState({ state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: 'quota' });
  }

  const reservation = await reserveEnrichmentAttempt({
    hex,
    stage: 'image',
    generationId,
    requestId: text(message.requestId),
  });
  if (!reservation?.reserved) {
    return buildCallbackResultFromState({ state: reservation?.state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: reservation?.reason });
  }

  try {
    const imageBuffer = await callCloudflare(prompt);
    const relativeUrl = await uploadCloudflareImage(imageBuffer, { hex, requestId: text(message.requestId) });
    const generatedValue = {
      relativeUrl,
      mimeType: 'image/jpeg',
      prompt,
      provider: 'cloudflare',
      model: CLOUDFLARE_MODEL,
    };

    // Cache provider success before updating the event JSON. If persistence fails,
    // the next eligible execution reuses this value rather than calling Cloudflare again.
    await markGeminiSucceeded({ hex, stage: 'image', generationId, generatedValue });
    try {
      await persistGeneratedImage({ hex, event, generatedValue, generationId });
    } catch (persistenceError) {
      console.error('[CloudflareImage] Provider succeeded but event persistence failed', persistenceError?.message || persistenceError);
      emitImageMetric('cloudflare', 'persistence_retry');
      const state = await getEnrichmentState(hex, 'image').catch(() => null);
      return buildCallbackResultFromState({ state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: 'persistence_pending' });
    }
    emitImageMetric('cloudflare', 'success');
    const state = await getEnrichmentState(hex, 'image').catch(() => null);
    return buildCallbackResultFromState({ state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: 'succeeded' });
  } catch (error) {
    emitImageMetric('cloudflare', 'failure');
    const category = classifyCloudflareError(error);
    let state;
    if (category === 'PROVIDER_QUOTA') {
      state = await markQuotaDeferralWithoutAttempt({
        hex,
        attemptCount: reservation?.state?.attemptCount,
        error,
        errorType: 'PROVIDER_QUOTA',
        attemptWasReserved: true,
      });
    } else {
      if (category === 'MODEL_CONFIGURATION') error.status = 404;
      state = await markEnrichmentFailure({
        hex,
        stage: 'image',
        error,
        attemptCount: reservation?.state?.attemptCount,
      }).catch(() => null);
    }
    await notifyTransition('image', state, { hex, provider: 'cloudflare', requestId: text(message.requestId) });
    return buildCallbackResultFromState({ state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: category });
  }
}

async function reserveGeminiImageBudgetIfNeeded(message) {
  const stage = normaliseStage(message?.orchestrationStep ?? message?.realm);
  if (stage !== 'image' || normaliseImageProvider(message?.imageProvider) !== 'gemini') return { allowed: true };
  const hex = getHex(message);
  if (!hex) return { allowed: false, result: { status: 'manual_review', stage: 'image', hex: null, provider: 'gemini', failureCategory: 'INVALID_EVENT_DATA', attemptCount: 0 } };
  const event = await loadEvent(hex);
  if (!event) return { allowed: false, result: { status: 'manual_review', stage: 'image', hex, provider: 'gemini', failureCategory: 'INVALID_EVENT_DATA', attemptCount: 0 } };
  const generationId = providerGenerationId(hex, 'gemini', event);
  const reusable = await loadReusableGeneration({ hex, stage: 'image', generationId }).catch(() => null);
  if (reusable) return { allowed: true, generationId, reused: true };

  const currentState = await getEnrichmentState(hex, 'image').catch(() => null);
  const eligibility = evaluateEnrichmentEligibility(currentState, new Date(), generationId);
  if (!eligibility.eligible) {
    return {
      allowed: false,
      result: buildCallbackResultFromState({
        state: currentState,
        stage: 'image',
        hex,
        provider: 'gemini',
        generationId,
        fallbackStatus: eligibility.reason,
      }),
    };
  }

  const allowed = await reserveImageBudget('gemini');
  if (!allowed) {
    const state = await markQuotaDeferralWithoutAttempt({
      hex,
      attemptCount: currentState?.attemptCount || 0,
      error: new Error('Image generation daily safety limit reached'),
      errorType: 'GLOBAL_QUOTA',
    });
    return {
      allowed: false,
      result: buildCallbackResultFromState({ state, stage: 'image', hex, provider: 'gemini', generationId, fallbackStatus: 'quota' }),
    };
  }
  return { allowed: true, generationId, reused: false };
}

async function resultAfterLegacy(message, response, knownGenerationId = null) {
  const stage = normaliseStage(message?.orchestrationStep ?? message?.realm);
  const hex = getHex(message);
  const provider = stage === 'image' ? normaliseImageProvider(message?.imageProvider) : null;
  const state = hex && stage ? await getEnrichmentState(hex, stage).catch(() => null) : null;
  const event = hex ? await loadEvent(hex).catch(() => null) : null;
  const statusCode = Number(response?.statusCode || 0);
  let fallbackStatus = null;
  if (stageFieldPresent(event, stage)) fallbackStatus = 'succeeded';
  else if (statusCode === 202) fallbackStatus = 'quota';
  else if (statusCode >= 500 && !state) throw new Error(`Legacy ${stage || 'enrichment'} worker failed without persisted safety state`);
  return buildCallbackResultFromState({
    state,
    stage,
    hex,
    provider,
    generationId: knownGenerationId,
    fallbackStatus,
  });
}

async function sendTaskSuccess(message, result) {
  await sfn.send(new SendTaskSuccessCommand({
    taskToken: text(message.taskToken),
    output: JSON.stringify(result),
  }));
}

async function sendTaskFailure(message, error) {
  await sfn.send(new SendTaskFailureCommand({
    taskToken: text(message.taskToken),
    error: text(error?.name) || 'FullEnrichWorkerFailure',
    cause: JSON.stringify({
      message: text(error?.message) || String(error),
      hex: getHex(message),
      stage: normaliseStage(message?.orchestrationStep ?? message?.realm),
      provider: normaliseImageProvider(message?.imageProvider),
      requestId: text(message?.requestId),
    }),
  }));
}

function parseRecord(record) {
  if (!record || record.eventSource !== 'aws:sqs') return null;
  try { return typeof record.body === 'string' ? JSON.parse(record.body) : record.body; } catch { return null; }
}

async function handleFullRecord(record, message) {
  const stage = normaliseStage(message?.orchestrationStep ?? message?.realm);
  const provider = stage === 'image' ? normaliseImageProvider(message?.imageProvider) : null;
  try {
    let result;
    if (stage === 'image' && provider === 'cloudflare') {
      result = await processCloudflareImage(message);
    } else {
      if (stage === 'image' && provider !== 'gemini') throw new Error(`Unsupported image provider: ${message?.imageProvider || 'missing'}`);
      const budget = await reserveGeminiImageBudgetIfNeeded(message);
      if (!budget.allowed) {
        result = budget.result;
      } else {
        const response = await legacyHandler({ Records: [record] });
        result = await resultAfterLegacy(message, response, budget.generationId || null);
      }
    }
    console.log('[FullEnrich] Stage result', JSON.stringify(result));
    await sendTaskSuccess(message, result);
  } catch (error) {
    console.error('[FullEnrich] Stage processing failed', {
      message: error?.message || String(error),
      hex: getHex(message),
      stage,
      provider,
    });
    await sendTaskFailure(message, error);
  }
}

export async function lambdaHandler(event) {
  const records = Array.isArray(event?.Records) ? event.Records : [];
  if (records.length === 0) return legacyHandler(event);

  const legacyRecords = [];
  for (const record of records) {
    const message = parseRecord(record);
    if (message && isFullEnrichMessage(message)) {
      await handleFullRecord(record, message);
    } else {
      legacyRecords.push(record);
    }
  }

  if (legacyRecords.length > 0) return legacyHandler({ ...event, Records: legacyRecords });
  return { statusCode: 200, body: JSON.stringify({ message: 'Full enrichment stages processed' }) };
}
