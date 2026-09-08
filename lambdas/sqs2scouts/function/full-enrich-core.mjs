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
import { lambdaHandler as persistenceProcessorHandler } from './persistence-processor.mjs';
import { publishCanonicalEventToAgenda } from './agenda-publisher.mjs';
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
const SCOUTS_CONFIG_KEY = text(process.env.SCOUTS_CONFIG_KEY) || 'scouts.conf';
const SCOUTS_CONFIG_TTL_MS = Number.isFinite(Number(process.env.SCOUTS_CONFIG_TTL_MS))
  ? Math.max(60_000, Number(process.env.SCOUTS_CONFIG_TTL_MS))
  : 5 * 60 * 1000;
const EVENT_IMAGE_PREFIX = 'website/eventImages/';
const GEMINI_PROMPT_VERSION = text(process.env.GEMINI_PROMPT_VERSION) || '1';
const ENRICHMENT_TABLE_NAME = text(process.env.GEMINI_ENRICHMENT_STATE_TABLE_NAME);
const GEMINI_IMAGE_API_VERSION = text(process.env.GEMINI_IMAGE_API_VERSION) || 'v1beta';
const GEMINI_IMAGE_MODELS = (() => {
  const configured = [process.env.GEMINI_IMAGE_MODELS, process.env.GEMINI_IMAGE_MODEL]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((value) => text(value))
    .filter(Boolean);
  return Array.from(new Set(configured.length > 0 ? configured : ['gemini-3.1-flash-image']));
})();
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
let cachedScoutsConfig = null;
let cachedScoutsConfigExpiresAt = 0;

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
  const metadataImage = getMetadata(event).image;
  if (metadataImage && typeof metadataImage === 'object') return metadataImage;
  return event && typeof event.image === 'object' && event.image ? event.image : {};
}

function stageFieldPresent(event, stage) {
  if (!event) return false;
  if (stage === 'tagline') return Boolean(text(getMetadata(event).tagline ?? event?.tagline));
  if (stage === 'imageTheme') return Boolean(text(getImageMetadata(event).theme ?? event?.imageTheme));
  if (stage === 'image') return Boolean(text(getImageMetadata(event).url ?? event?.imageUrl));
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

async function loadScoutsConfig(force = false) {
  const now = Date.now();
  if (!force && cachedScoutsConfig && cachedScoutsConfigExpiresAt > now) return cachedScoutsConfig;
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: TARGET_BUCKET, Key: SCOUTS_CONFIG_KEY }));
    cachedScoutsConfig = JSON.parse(await response.Body.transformToString());
    cachedScoutsConfigExpiresAt = now + SCOUTS_CONFIG_TTL_MS;
    console.log(`[FullEnrich] Loaded scouts configuration from s3://${TARGET_BUCKET}/${SCOUTS_CONFIG_KEY}`);
  } catch (error) {
    console.warn('[FullEnrich] Failed to load runtime scouts.conf; using bundled fallback', error?.message || error);
    cachedScoutsConfig = loadBundledScoutsConfig();
    cachedScoutsConfigExpiresAt = now + 60_000;
  }
  return cachedScoutsConfig;
}

function providerGenerationId(hex, _provider, event) {
  // Provider is intentionally excluded so a successfully cached image can be
  // reused across provider migrations instead of triggering another paid call.
  return buildGenerationId(hex, 'image', event, GEMINI_PROMPT_VERSION);
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

function extractInlineImageData(response) {
  const generatedImages = Array.isArray(response?.generatedImages) ? response.generatedImages : [];
  for (const entry of generatedImages) {
    const image = entry?.image ?? entry;
    const data = image?.imageBytes ?? image?.bytesBase64Encoded ?? image?.base64Data ?? image?.data ?? null;
    if (data) return { data, mimeType: image?.mimeType ?? image?.mediaType ?? image?.contentType ?? 'image/png' };
  }
  for (const candidate of Array.isArray(response?.candidates) ? response.candidates : []) {
    for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
      const inline = part?.inlineData ?? part?.inline_data ?? null;
      if (inline?.data) return { data: inline.data, mimeType: inline.mimeType ?? inline.mime_type ?? 'image/png' };
    }
  }
  return null;
}

async function callGemini(prompt) {
  const token = await getOptionalSecret('GEMINI_API_KEY_PARAMETER', '');
  if (!token) throw Object.assign(new Error('Gemini API key is not configured'), { status: 401 });
  const { GoogleGenAI } = await import('@google/genai');
  const client = new GoogleGenAI({ apiKey: token, apiVersion: GEMINI_IMAGE_API_VERSION });
  let lastError = null;
  for (const model of GEMINI_IMAGE_MODELS) {
    try {
      const response = /^imagen-/i.test(model)
        ? await client.models.generateImages({ model, prompt, config: { numberOfImages: 1, aspectRatio: '16:9' } })
        : await client.models.generateContent({ model, contents: prompt });
      const inline = extractInlineImageData(response);
      if (!inline?.data) throw new Error(`Gemini model ${model} returned no image data`);
      return { buffer: Buffer.from(inline.data, 'base64'), model, mimeType: inline.mimeType || 'image/png' };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (Number(error?.status ?? error?.response?.status) === 404) continue;
      throw lastError;
    }
  }
  throw lastError || new Error('No configured Gemini image model returned an image');
}

function safeKeyPart(value, fallback = 'event') {
  const result = String(value || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return result || fallback;
}

async function uploadGeneratedImage(buffer, { hex, requestId, provider }) {
  const jpeg = await sharp(buffer)
    .rotate()
    .trim()
    .resize({ width: IMAGE_WIDTH, height: IMAGE_HEIGHT, fit: 'inside', withoutEnlargement: true })
    .jpeg({ mozjpeg: true, quality: 85 })
    .toBuffer();
  const key = `${EVENT_IMAGE_PREFIX}${safeKeyPart(hex, 'hex')}-${safeKeyPart(requestId, String(Date.now()))}-${safeKeyPart(provider)}.jpg`;
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
  await publishCanonicalEventToAgenda({
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
  await markEnrichmentSucceeded({ hex, stage: 'image', generationId });
}

async function processImageProvider(message, provider) {
  const hex = getHex(message);
  if (!hex) throw new Error(`${provider} fullEnrich image request missing HEX`);
  const event = await loadEvent(hex);
  if (!event) throw new Error(`HEX ${hex} not found`);
  const imageTheme = text(getImageMetadata(event).theme ?? event?.imageTheme);
  const prompt = buildImageGenerationPrompt(imageTheme, await loadScoutsConfig());
  if (!prompt) throw new Error(`HEX ${hex} is missing a valid image theme/prompt configuration`);
  const generationId = providerGenerationId(hex, provider, event);

  const reusable = await loadReusableGeneration({ hex, stage: 'image', generationId }).catch(() => null);
  if (reusable?.generatedValue?.relativeUrl) {
    await persistGeneratedImage({ hex, event, generatedValue: reusable.generatedValue, generationId });
    emitImageMetric(provider, 'reused');
    const state = await getEnrichmentState(hex, 'image');
    return buildCallbackResultFromState({ state, stage: 'image', hex, provider, generationId, fallbackStatus: 'succeeded' });
  }

  const currentState = await getEnrichmentState(hex, 'image').catch(() => null);
  const eligibility = evaluateEnrichmentEligibility(currentState, new Date(), generationId);
  if (!eligibility.eligible) {
    return buildCallbackResultFromState({ state: currentState, stage: 'image', hex, provider, generationId, fallbackStatus: eligibility.reason });
  }

  // Own the stage before calling the provider. A duplicate delivery that loses this
  // conditional reservation sends no callback and makes no external request.
  const reservation = await reserveEnrichmentAttempt({
    hex,
    stage: 'image',
    generationId,
    requestId: text(message.requestId),
  });
  if (!reservation?.reserved) {
    return buildCallbackResultFromState({ state: reservation?.state, stage: 'image', hex, provider, generationId, fallbackStatus: reservation?.reason });
  }

  try {
    const generated = provider === 'cloudflare'
      ? { buffer: await callCloudflare(prompt), model: CLOUDFLARE_MODEL, mimeType: 'image/jpeg' }
      : await callGemini(prompt);
    const relativeUrl = await uploadGeneratedImage(generated.buffer, { hex, requestId: text(message.requestId), provider });
    const generatedValue = {
      relativeUrl,
      mimeType: 'image/jpeg',
      prompt,
      provider,
      model: generated.model,
    };

    // Cache provider success before updating the event JSON. If persistence fails,
    // the next delivery reuses this value rather than calling a provider again.
    await markGeminiSucceeded({ hex, stage: 'image', generationId, generatedValue });
    try {
      await persistGeneratedImage({ hex, event, generatedValue, generationId });
    } catch (persistenceError) {
      console.error(`[${provider}Image] Provider succeeded but event persistence failed`, persistenceError?.message || persistenceError);
      emitImageMetric(provider, 'persistence_retry');
      const state = await getEnrichmentState(hex, 'image').catch(() => null);
      return buildCallbackResultFromState({ state, stage: 'image', hex, provider, generationId, fallbackStatus: 'persistence_pending' });
    }
    emitImageMetric(provider, 'success');
    const state = await getEnrichmentState(hex, 'image').catch(() => null);
    return buildCallbackResultFromState({ state, stage: 'image', hex, provider, generationId, fallbackStatus: 'succeeded' });
  } catch (error) {
    emitImageMetric(provider, 'failure');
    let state;
    if (provider === 'cloudflare' && classifyCloudflareError(error) === 'PROVIDER_QUOTA') {
      state = await markQuotaDeferralWithoutAttempt({
        hex,
        attemptCount: reservation?.state?.attemptCount,
        error,
        errorType: 'PROVIDER_QUOTA',
        attemptWasReserved: true,
      });
    } else {
      if (provider === 'cloudflare' && classifyCloudflareError(error) === 'MODEL_CONFIGURATION') error.status = 404;
      state = await markEnrichmentFailure({
        hex,
        stage: 'image',
        error,
        attemptCount: reservation?.state?.attemptCount,
      }).catch(() => null);
    }
    await notifyTransition('image', state, { hex, provider, requestId: text(message.requestId) });
    return buildCallbackResultFromState({ state, stage: 'image', hex, provider, generationId, fallbackStatus: provider === 'cloudflare' ? classifyCloudflareError(error) : 'provider_failure' });
  }
}

async function resultAfterProcessor(message, response) {
  const stage = normaliseStage(message?.orchestrationStep ?? message?.realm);
  const hex = getHex(message);
  const state = hex && stage ? await getEnrichmentState(hex, stage).catch(() => null) : null;
  const event = hex ? await loadEvent(hex).catch(() => null) : null;
  const statusCode = Number(response?.statusCode || 0);
  let fallbackStatus = null;
  if (stageFieldPresent(event, stage)) fallbackStatus = 'succeeded';
  else if (statusCode === 202) fallbackStatus = 'quota';
  else if (statusCode >= 500 && !state) throw new Error(`Canonical ${stage || 'enrichment'} processor failed without persisted safety state`);
  return buildCallbackResultFromState({ state, stage, hex, fallbackStatus });
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
  let result;

  try {
    if (stage === 'image') {
      if (!provider) throw new Error(`Unsupported image provider: ${message?.imageProvider || 'missing'}`);
      result = await processImageProvider(message, provider);
    } else {
      const response = await persistenceProcessorHandler({ Records: [record] });
      result = await resultAfterProcessor(message, response);
    }
  } catch (error) {
    console.error('[FullEnrich] Stage processing failed', {
      message: error?.message || String(error),
      hex: getHex(message),
      stage,
      provider,
    });
    // If failure-callback delivery itself fails, let it escape so SQS retries.
    await sendTaskFailure(message, error);
    return;
  }

  console.log('[FullEnrich] Stage result', JSON.stringify(result));
  if (result?.status === 'duplicate_in_progress') {
    console.log('[FullEnrich] Duplicate delivery acknowledged without callback; reservation owner retains task token', {
      hex: getHex(message),
      stage,
      provider,
    });
    return;
  }

  // Success-callback transport is deliberately outside the processing catch.
  // A transient SendTaskSuccess failure therefore retries via SQS rather than
  // converting a successfully persisted provider result into SendTaskFailure.
  await sendTaskSuccess(message, result);
}

export async function lambdaHandler(event) {
  const records = Array.isArray(event?.Records) ? event.Records : [];
  if (records.length === 0) return persistenceProcessorHandler(event);

  const standardRecords = [];
  for (const record of records) {
    const message = parseRecord(record);
    if (message && isFullEnrichMessage(message)) {
      await handleFullRecord(record, message);
    } else {
      standardRecords.push(record);
    }
  }

  if (standardRecords.length > 0) return persistenceProcessorHandler({ ...event, Records: standardRecords });
  return { statusCode: 200, body: JSON.stringify({ message: 'Full enrichment stages processed' }) };
}
