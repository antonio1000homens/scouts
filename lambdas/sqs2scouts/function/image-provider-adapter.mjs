import { readFileSync } from 'fs';
import sharp from 'sharp';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SFNClient, SendTaskFailureCommand, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
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
import { lambdaHandler as fullEnrichHandler } from './full-enrich-core.mjs';
import {
  text,
  normaliseStage,
  isFullEnrichMessage,
  classifyCloudflareError,
  buildCallbackResultFromState,
  buildImageGenerationPrompt,
} from './full-enrich-helpers.mjs';
import {
  DEFAULT_CLOUDFLARE_IMAGE_MODEL,
  normaliseImageProvider,
  normaliseCloudflareSteps,
  generateCloudflareImageAsset,
} from './cloudflare-image-client.mjs';

const AWS_REGION = process.env.AWS_REGION || 'eu-west-2';
const TARGET_BUCKET = process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const SCOUTS_CONFIG_KEY = text(process.env.SCOUTS_CONFIG_KEY) || 'scouts.conf';
const SCOUTS_CONFIG_TTL_MS = Number.isFinite(Number(process.env.SCOUTS_CONFIG_TTL_MS))
  ? Math.max(60_000, Number(process.env.SCOUTS_CONFIG_TTL_MS))
  : 5 * 60 * 1000;
const EVENT_IMAGE_PREFIX = 'website/eventImages/';
const PROMPT_VERSION = text(process.env.GEMINI_PROMPT_VERSION) || '1';
const USAGE_TABLE_NAME = text(process.env.GEMINI_USAGE_TABLE_NAME);
const ENRICHMENT_TABLE_NAME = text(process.env.GEMINI_ENRICHMENT_STATE_TABLE_NAME);
const IMAGE_DAILY_REQUEST_LIMIT = Number.isFinite(Number(process.env.IMAGE_GENERATION_DAILY_REQUEST_LIMIT))
  ? Math.max(0, Math.floor(Number(process.env.IMAGE_GENERATION_DAILY_REQUEST_LIMIT)))
  : 10;
const CONFIGURED_IMAGE_PROVIDER = normaliseImageProvider(process.env.IMAGE_GENERATION_PROVIDER || 'disabled');
const GEMINI_IMAGES_ENABLED = String(process.env.GEMINI_IMAGES || 'false').trim().toLowerCase() === 'true';
const CLOUDFLARE_ACCOUNT_ID = text(process.env.CLOUDFLARE_ACCOUNT_ID);
const CLOUDFLARE_MODEL = text(process.env.CLOUDFLARE_AI_MODEL) || DEFAULT_CLOUDFLARE_IMAGE_MODEL;
const CLOUDFLARE_STEPS = normaliseCloudflareSteps(process.env.CLOUDFLARE_AI_STEPS);
const IMAGE_WIDTH = Number.isFinite(Number(process.env.GEMINI_IMAGE_OUTPUT_WIDTH))
  ? Math.max(320, Number(process.env.GEMINI_IMAGE_OUTPUT_WIDTH))
  : 1366;
const IMAGE_HEIGHT = Number.isFinite(Number(process.env.GEMINI_IMAGE_OUTPUT_HEIGHT))
  ? Math.max(180, Number(process.env.GEMINI_IMAGE_OUTPUT_HEIGHT))
  : 768;
const MAX_CACHED_JPEG_BYTES = 180 * 1024;
const SLACK_WEBHOOK_URL = text(process.env.SLACK_WEBHOOK_URL) || 'https://slack.com/api/chat.postMessage';
const SLACK_CHANNEL = '#scouts';

const s3 = new S3Client({ region: AWS_REGION });
const sfn = new SFNClient({ region: AWS_REGION });
const dynamo = new DynamoDBClient({ region: AWS_REGION });
let cachedScoutsConfig = null;
let cachedScoutsConfigExpiresAt = 0;

function usageDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function ttlEpoch(now = new Date()) {
  return Math.floor(now.getTime() / 1000) + (90 * 24 * 60 * 60);
}

function nextProviderReset(now = new Date()) {
  const reset = new Date(now);
  reset.setUTCHours(24, 5, 0, 0);
  return reset.toISOString();
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
  const metadataImage = getMetadata(event).image;
  if (metadataImage && typeof metadataImage === 'object') return metadataImage;
  return event && typeof event.image === 'object' && event.image ? event.image : {};
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

function loadBundledScoutsConfig() {
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

async function loadScoutsConfig() {
  const now = Date.now();
  if (cachedScoutsConfig && cachedScoutsConfigExpiresAt > now) return cachedScoutsConfig;
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: TARGET_BUCKET, Key: SCOUTS_CONFIG_KEY }));
    cachedScoutsConfig = JSON.parse(await response.Body.transformToString());
    cachedScoutsConfigExpiresAt = now + SCOUTS_CONFIG_TTL_MS;
  } catch (error) {
    console.warn('[ImageGeneration] Failed to load runtime scouts.conf; using bundled fallback', error?.message || error);
    cachedScoutsConfig = loadBundledScoutsConfig();
    cachedScoutsConfigExpiresAt = now + 60_000;
  }
  return cachedScoutsConfig;
}

function emitImageMetric(metricName, provider = 'cloudflare', outcome = null) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'Scouts/ImageGeneration',
        Dimensions: [[]],
        Metrics: [{ Name: metricName, Unit: 'Count' }],
      }],
    },
    Provider: provider,
    Model: provider === 'cloudflare' ? CLOUDFLARE_MODEL : null,
    Outcome: outcome || metricName,
    [metricName]: 1,
  }));
}

function logImageEvent({
  hex,
  requestId,
  generationId,
  externalRequestAttempted = false,
  cachedResultReused = false,
  httpStatus = null,
  providerErrorCode = null,
  outcome,
}) {
  console.log(JSON.stringify({
    eventType: 'image_generation',
    provider: 'cloudflare',
    model: CLOUDFLARE_MODEL,
    hex,
    stage: 'image',
    requestId: text(requestId),
    generationId,
    externalRequestAttempted,
    cachedResultReused,
    httpStatus,
    providerErrorCode,
    outcome,
  }));
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

async function notifyTransition(state, details = {}) {
  if (!state) return;
  const attemptCount = Number(state.attemptCount || 0);
  if (state.state === 'retry_wait' && attemptCount === 2) {
    await sendSlackText(`⚠️ Scouts enrichment retry warning\n\nHEX: ${details.hex}\nStage: image\nProvider: cloudflare\nAttempts: ${attemptCount} / ${enrichmentStateConfig.MAX_ATTEMPTS}\nLast error: ${state.lastErrorType || 'UNKNOWN'}: ${state.lastErrorMessage || 'unknown'}\nNext retry: ${state.nextRetryAt || 'unknown'}\nRequest ID: ${details.requestId || 'unknown'}`).catch(() => {});
  }
  if (state.state === 'manual_review') {
    const claimed = await claimEnrichmentEscalation({ hex: details.hex, stage: 'image' }).catch(() => false);
    if (claimed) {
      await sendSlackText(`🚨 Scouts enrichment suspended\n\nHEX: ${details.hex}\nStage: image\nProvider: cloudflare\nAttempts: ${attemptCount}\nLast error: ${state.lastErrorType || 'UNKNOWN'}: ${state.lastErrorMessage || 'unknown'}\nRequest ID: ${details.requestId || 'unknown'}`).catch(() => {});
    }
  }
}

async function readUsage(scope, now = new Date()) {
  if (!USAGE_TABLE_NAME) throw new Error('Image usage table is not configured');
  const response = await dynamo.send(new GetItemCommand({
    TableName: USAGE_TABLE_NAME,
    Key: { usageDay: { S: usageDay(now) }, usageScope: { S: scope } },
    ConsistentRead: true,
  }));
  return {
    requestCount: Number(response?.Item?.requestCount?.N || 0),
    blockedUntil: text(response?.Item?.blockedUntil?.S),
  };
}

async function imageApplicationCapOpen(now = new Date()) {
  if (IMAGE_DAILY_REQUEST_LIMIT <= 0) return { open: true, reason: 'application_cap_disabled' };
  const usage = await readUsage('image-requests', now);
  return usage.requestCount >= IMAGE_DAILY_REQUEST_LIMIT
    ? { open: true, reason: 'application_daily_cap', blockedUntil: nextProviderReset(now) }
    : { open: false, count: usage.requestCount };
}

async function providerQuotaCircuitOpen(now = new Date()) {
  const usage = await readUsage('provider#cloudflare#daily-quota', now);
  if (!usage.blockedUntil) return { open: false };
  return new Date(usage.blockedUntil).getTime() > now.getTime()
    ? { open: true, reason: 'provider_daily_quota_exhausted', blockedUntil: usage.blockedUntil }
    : { open: false };
}

async function reserveImageBudget(now = new Date()) {
  if (!USAGE_TABLE_NAME || IMAGE_DAILY_REQUEST_LIMIT <= 0) return false;
  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: USAGE_TABLE_NAME,
      Key: { usageDay: { S: usageDay(now) }, usageScope: { S: 'image-requests' } },
      UpdateExpression: 'SET #expiresAt = :expiresAt ADD #requestCount :one',
      ConditionExpression: 'attribute_not_exists(#requestCount) OR #requestCount < :limit',
      ExpressionAttributeNames: { '#expiresAt': 'expiresAt', '#requestCount': 'requestCount' },
      ExpressionAttributeValues: {
        ':expiresAt': { N: String(ttlEpoch(now)) },
        ':one': { N: '1' },
        ':limit': { N: String(IMAGE_DAILY_REQUEST_LIMIT) },
      },
    }));
    emitImageMetric('Requests', 'cloudflare', 'attempt');
    return true;
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      emitImageMetric('QuotaRejected', 'cloudflare', 'quota_rejected');
      return false;
    }
    console.error('[ImageGeneration] Daily quota counter unavailable; blocking Cloudflare request', error?.message || error);
    return false;
  }
}

async function markProviderQuotaExhausted(error, now = new Date()) {
  const blockedUntil = nextProviderReset(now);
  let firstSignal = false;
  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: USAGE_TABLE_NAME,
      Key: { usageDay: { S: usageDay(now) }, usageScope: { S: 'provider#cloudflare#daily-quota' } },
      UpdateExpression: 'SET #blockedUntil = :blockedUntil, #providerCode = :providerCode, #updatedAt = :updatedAt, #expiresAt = :expiresAt',
      ConditionExpression: 'attribute_not_exists(#blockedUntil)',
      ExpressionAttributeNames: {
        '#blockedUntil': 'blockedUntil',
        '#providerCode': 'providerCode',
        '#updatedAt': 'updatedAt',
        '#expiresAt': 'expiresAt',
      },
      ExpressionAttributeValues: {
        ':blockedUntil': { S: blockedUntil },
        ':providerCode': { S: String(error?.providerCode || 3036) },
        ':updatedAt': { S: now.toISOString() },
        ':expiresAt': { N: String(ttlEpoch(now)) },
      },
    }));
    firstSignal = true;
  } catch (updateError) {
    if (updateError?.name !== 'ConditionalCheckFailedException') throw updateError;
  }

  if (firstSignal) {
    emitImageMetric('ProviderQuotaExhausted', 'cloudflare', 'provider_quota_exhausted');
    await sendSlackText(`🚨 Cloudflare Workers AI daily allocation exhausted\n\nAutomatic Scouts image generation is paused until ${blockedUntil}.\nNo Gemini image fallback will be attempted.`).catch(() => {});
  }
  return blockedUntil;
}

async function markImageDeferral({ hex, attemptCount = 0, attemptWasReserved = false, errorType, message, nextRetryAt, now = new Date() }) {
  if (!ENRICHMENT_TABLE_NAME) return null;
  const persistedAttemptCount = attemptWasReserved
    ? Math.max(0, Number(attemptCount || 0) - 1)
    : Math.max(0, Number(attemptCount || 0));
  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: ENRICHMENT_TABLE_NAME,
      Key: { hex: { S: hex }, stage: { S: 'image' } },
      UpdateExpression: 'SET #state = :state, #attemptCount = :attemptCount, #lastErrorType = :errorType, #lastErrorMessage = :errorMessage, #nextRetryAt = :nextRetryAt, #updatedAt = :updatedAt, #expiresAt = :expiresAt REMOVE #inProgressExpiresAt',
      ConditionExpression: 'attribute_not_exists(#state) OR (#state <> :manualReview AND #state <> :succeeded)',
      ExpressionAttributeNames: {
        '#state': 'state', '#attemptCount': 'attemptCount', '#lastErrorType': 'lastErrorType',
        '#lastErrorMessage': 'lastErrorMessage', '#nextRetryAt': 'nextRetryAt', '#updatedAt': 'updatedAt',
        '#expiresAt': 'expiresAt', '#inProgressExpiresAt': 'inProgressExpiresAt',
      },
      ExpressionAttributeValues: {
        ':state': { S: 'retry_wait' }, ':manualReview': { S: 'manual_review' }, ':succeeded': { S: 'succeeded' },
        ':attemptCount': { N: String(persistedAttemptCount) }, ':errorType': { S: errorType },
        ':errorMessage': { S: String(message || errorType).slice(0, 500) }, ':nextRetryAt': { S: nextRetryAt },
        ':updatedAt': { S: now.toISOString() }, ':expiresAt': { N: String(ttlEpoch(now)) },
      },
    }));
  } catch (error) {
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
  }
  return getEnrichmentState(hex, 'image');
}

function deterministicImageKey(hex, generationId) {
  return `${EVENT_IMAGE_PREFIX}${hex}-${String(generationId).slice(0, 20)}-cloudflare.jpg`;
}

async function normaliseForDurableCache(buffer) {
  let width = IMAGE_WIDTH;
  let height = IMAGE_HEIGHT;
  for (const quality of [85, 75, 65, 55, 45, 35]) {
    const jpeg = await sharp(buffer)
      .rotate()
      .trim()
      .resize({ width: Math.round(width), height: Math.round(height), fit: 'inside', withoutEnlargement: true })
      .jpeg({ mozjpeg: true, quality })
      .toBuffer();
    if (jpeg.length <= MAX_CACHED_JPEG_BYTES) return jpeg;
    width = Math.max(640, width * 0.9);
    height = Math.max(360, height * 0.9);
  }
  const error = new Error('Generated image could not be compressed safely for the durable retry cache');
  error.status = 400;
  throw error;
}

async function persistCachedImage({ hex, event, generatedValue, generationId }) {
  const imageBytes = Buffer.from(generatedValue.imageBase64, 'base64');
  await s3.send(new PutObjectCommand({
    Bucket: TARGET_BUCKET,
    Key: generatedValue.relativeUrl,
    Body: imageBytes,
    ContentType: 'image/jpeg',
    CacheControl: 'public, max-age=31536000',
  }));
  event.metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  event.metadata.image = event.metadata.image && typeof event.metadata.image === 'object' ? event.metadata.image : {};
  event.metadata.status = event.metadata.status && typeof event.metadata.status === 'object' ? event.metadata.status : {};
  event.metadata.image.url = generatedValue.relativeUrl;
  event.metadata.status.isApproved = false;
  await saveEvent(hex, event);
  await markEnrichmentSucceeded({ hex, stage: 'image', generationId });
}

async function processCloudflareImage(message) {
  const now = new Date();
  const hex = getHex(message);
  if (!hex) throw new Error('Cloudflare fullEnrich image request missing HEX');
  const event = await loadEvent(hex);
  if (!event) throw new Error(`HEX ${hex} not found`);
  const imageTheme = text(getImageMetadata(event).theme ?? event?.imageTheme);
  const prompt = buildImageGenerationPrompt(imageTheme, await loadScoutsConfig());
  if (!prompt) throw new Error(`HEX ${hex} is missing a valid image theme/prompt configuration`);
  const generationId = buildGenerationId(hex, 'image', event, PROMPT_VERSION);

  const reusable = await loadReusableGeneration({ hex, stage: 'image', generationId }).catch(() => null);
  if (reusable?.generatedValue?.relativeUrl && reusable?.generatedValue?.imageBase64) {
    await persistCachedImage({ hex, event, generatedValue: reusable.generatedValue, generationId });
    emitImageMetric('ResultReused', 'cloudflare', 'reused');
    logImageEvent({ hex, requestId: message.requestId, generationId, cachedResultReused: true, outcome: 'reused' });
    const state = await getEnrichmentState(hex, 'image');
    return buildCallbackResultFromState({ state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: 'succeeded' });
  }

  const currentState = await getEnrichmentState(hex, 'image').catch(() => null);
  const eligibility = evaluateEnrichmentEligibility(currentState, now, generationId);
  if (!eligibility.eligible) {
    return buildCallbackResultFromState({ state: currentState, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: eligibility.reason });
  }

  let providerCircuit;
  let appCap;
  try {
    providerCircuit = await providerQuotaCircuitOpen(now);
    appCap = await imageApplicationCapOpen(now);
  } catch (error) {
    const retryAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    const state = await markImageDeferral({
      hex,
      attemptCount: currentState?.attemptCount || 0,
      errorType: 'QUOTA_COUNTER_UNAVAILABLE',
      message: 'Image quota/circuit state is unavailable; failing closed',
      nextRetryAt: retryAt,
      now,
    });
    return buildCallbackResultFromState({ state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: 'quota_counter_unavailable' });
  }

  if (providerCircuit.open) {
    const state = await markImageDeferral({
      hex,
      attemptCount: currentState?.attemptCount || 0,
      errorType: 'PROVIDER_QUOTA',
      message: 'Cloudflare Workers AI daily allocation exhausted',
      nextRetryAt: providerCircuit.blockedUntil || nextProviderReset(now),
      now,
    });
    return buildCallbackResultFromState({ state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: 'provider_daily_quota_exhausted' });
  }

  if (appCap.open) {
    const state = await markImageDeferral({
      hex,
      attemptCount: currentState?.attemptCount || 0,
      errorType: 'GLOBAL_QUOTA',
      message: 'Application image-generation daily cap reached',
      nextRetryAt: appCap.blockedUntil || nextProviderReset(now),
      now,
    });
    return buildCallbackResultFromState({ state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: 'application_daily_cap' });
  }

  const reservation = await reserveEnrichmentAttempt({
    hex,
    stage: 'image',
    generationId,
    requestId: text(message.requestId),
    now,
  });
  if (!reservation?.reserved) {
    return buildCallbackResultFromState({ state: reservation?.state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: reservation?.reason });
  }

  if (!await reserveImageBudget(now)) {
    const state = await markImageDeferral({
      hex,
      attemptCount: reservation?.state?.attemptCount || 0,
      attemptWasReserved: true,
      errorType: 'GLOBAL_QUOTA',
      message: 'Application image-generation daily cap reached',
      nextRetryAt: nextProviderReset(now),
      now,
    });
    return buildCallbackResultFromState({ state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: 'application_daily_cap' });
  }

  let externalAttempted = false;
  try {
    const apiToken = await getOptionalSecret('CLOUDFLARE_AI_API_TOKEN_PARAMETER', '');
    if (!apiToken) {
      const error = new Error('Cloudflare Workers AI API token is not configured');
      error.status = 401;
      throw error;
    }
    externalAttempted = true;
    const generated = await generateCloudflareImageAsset({
      prompt,
      accountId: CLOUDFLARE_ACCOUNT_ID,
      apiToken,
      model: CLOUDFLARE_MODEL,
      steps: CLOUDFLARE_STEPS,
    });
    const jpeg = await normaliseForDurableCache(generated.buffer);
    const generatedValue = {
      relativeUrl: deterministicImageKey(hex, generationId),
      mimeType: 'image/jpeg',
      imageBase64: jpeg.toString('base64'),
      prompt,
      provider: 'cloudflare',
      model: generated.model,
    };

    await markGeminiSucceeded({ hex, stage: 'image', generationId, generatedValue });
    try {
      await persistCachedImage({ hex, event, generatedValue, generationId });
    } catch (persistenceError) {
      emitImageMetric('PersistenceRetry', 'cloudflare', 'persistence_retry');
      logImageEvent({ hex, requestId: message.requestId, generationId, externalRequestAttempted: true, httpStatus: generated.httpStatus, outcome: 'persistence_pending' });
      const state = await getEnrichmentState(hex, 'image').catch(() => null);
      return buildCallbackResultFromState({ state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: 'persistence_pending' });
    }

    emitImageMetric('Success', 'cloudflare', 'success');
    logImageEvent({ hex, requestId: message.requestId, generationId, externalRequestAttempted: true, httpStatus: generated.httpStatus, outcome: 'success' });
    const state = await getEnrichmentState(hex, 'image').catch(() => null);
    return buildCallbackResultFromState({ state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: 'succeeded' });
  } catch (error) {
    const category = classifyCloudflareError(error);
    logImageEvent({
      hex,
      requestId: message.requestId,
      generationId,
      externalRequestAttempted: externalAttempted,
      httpStatus: Number(error?.status || 0) || null,
      providerErrorCode: error?.providerCode ?? null,
      outcome: category,
    });

    let state;
    if (category === 'PROVIDER_QUOTA') {
      const blockedUntil = await markProviderQuotaExhausted(error, now);
      state = await markImageDeferral({
        hex,
        attemptCount: reservation?.state?.attemptCount,
        attemptWasReserved: true,
        errorType: 'PROVIDER_QUOTA',
        message: error?.message,
        nextRetryAt: blockedUntil,
        now,
      });
    } else {
      emitImageMetric('Failure', 'cloudflare', category.toLowerCase());
      if (category === 'MODEL_CONFIGURATION') error.status = 404;
      if (category === 'INVALID_EVENT_DATA') error.status = 400;
      state = await markEnrichmentFailure({
        hex,
        stage: 'image',
        error,
        attemptCount: reservation?.state?.attemptCount,
        now,
      }).catch(() => null);
    }
    await notifyTransition(state, { hex, requestId: text(message.requestId) });
    return buildCallbackResultFromState({ state, stage: 'image', hex, provider: 'cloudflare', generationId, fallbackStatus: category });
  }
}

async function sendTaskSuccess(message, result) {
  await sfn.send(new SendTaskSuccessCommand({ taskToken: text(message.taskToken), output: JSON.stringify(result) }));
}

async function sendTaskFailure(message, error) {
  await sfn.send(new SendTaskFailureCommand({
    taskToken: text(message.taskToken),
    error: text(error?.name) || 'ImageProviderFailure',
    cause: JSON.stringify({
      message: text(error?.message) || String(error),
      hex: getHex(message),
      stage: 'image',
      provider: CONFIGURED_IMAGE_PROVIDER,
      requestId: text(message?.requestId),
    }),
  }));
}

function parseRecord(record) {
  if (!record || record.eventSource !== 'aws:sqs') return null;
  try { return typeof record.body === 'string' ? JSON.parse(record.body) : record.body; } catch { return null; }
}

function isImageStageMessage(message) {
  return isFullEnrichMessage(message)
    && normaliseStage(message?.orchestrationStep ?? message?.realm) === 'image';
}

async function handleCloudflareRecord(message) {
  const requestedProvider = text(message?.imageProvider)?.toLowerCase() || CONFIGURED_IMAGE_PROVIDER;
  if (requestedProvider !== 'cloudflare') {
    throw new Error(`Image provider mismatch: workflow requested ${requestedProvider}, runtime is configured for cloudflare`);
  }

  let result;
  try {
    result = await processCloudflareImage(message);
  } catch (error) {
    console.error('[ImageGeneration] Cloudflare image stage failed unexpectedly', {
      message: error?.message || String(error),
      hex: getHex(message),
    });
    await sendTaskFailure(message, error);
    return;
  }

  if (result?.status === 'duplicate_in_progress') {
    console.log('[ImageGeneration] Duplicate delivery acknowledged without callback; reservation owner retains task token', {
      hex: getHex(message),
      provider: 'cloudflare',
    });
    return;
  }
  await sendTaskSuccess(message, result);
}

async function handleDisabledRecord(message) {
  await sendTaskSuccess(message, {
    status: 'deferred',
    stage: 'image',
    hex: getHex(message),
    provider: 'disabled',
    attemptCount: 0,
    reason: 'image_generation_disabled',
  });
}

export async function lambdaHandler(event) {
  const records = Array.isArray(event?.Records) ? event.Records : [];
  if (records.length === 0) return fullEnrichHandler(event);

  const delegated = [];
  for (const record of records) {
    const message = parseRecord(record);
    if (!message || !isImageStageMessage(message)) {
      delegated.push(record);
      continue;
    }

    if (CONFIGURED_IMAGE_PROVIDER === 'cloudflare') {
      await handleCloudflareRecord(message);
      continue;
    }
    if (CONFIGURED_IMAGE_PROVIDER === 'disabled') {
      await handleDisabledRecord(message);
      continue;
    }
    if (CONFIGURED_IMAGE_PROVIDER === 'gemini' && !GEMINI_IMAGES_ENABLED) {
      await handleDisabledRecord(message);
      continue;
    }
    delegated.push(record);
  }

  if (delegated.length > 0) return fullEnrichHandler({ ...event, Records: delegated });
  return { statusCode: 200, body: JSON.stringify({ message: 'Image provider stages processed' }) };
}
