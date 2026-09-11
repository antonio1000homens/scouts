import https from 'https';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { SFNClient, SendTaskFailureCommand, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import sharp from 'sharp';
import { getOptionalSecret, getRequiredSecret } from '/opt/nodejs/ssm-secrets.mjs';
import { recordRequestActivity } from '/opt/nodejs/request-activity.mjs';
import { publishCanonicalEventToAgenda } from './agenda-publisher.mjs';
import { generateGeminiTextWithFallback, parseGeminiTextModels, GEMINI_TEXT_RESPONSE_SCHEMAS, validateGeminiTextResponse } from './gemini-text-models.mjs';
import { buildRuntimeRequestEntry } from './runtime-request-entry.mjs';
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

// Load configuration from environment variables
console.log('sqs2scouts: Loading configuration from environment variables');

// Constants from environment variables
const SLACK_CHANNEL = (process.env.SCOUTS_NOTIFICATION_CHANNEL || 'C0C1996TGQZ').trim() || 'C0C1996TGQZ';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || 'https://slack.com/api/chat.postMessage';
const DLQ_URL = process.env.DLQ_URL || "https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessingDLQ";
const SLACK_CHAT_UPDATE_URL = process.env.SLACK_CHAT_UPDATE_URL || 'https://slack.com/api/chat.update';
const SLACK_VIEWS_OPEN_URL = process.env.SLACK_VIEWS_OPEN_URL || 'https://slack.com/api/views.open';
const AWS_REGION = process.env.AWS_REGION || 'eu-west-2';
const DEFAULT_BUCKET = 'scouts-2ndtolworth-prod-553490163883';
const TARGET_BUCKET = process.env.TARGET_BUCKET || DEFAULT_BUCKET;
const EVENT_IMAGE_PREFIX = 'website/eventImages/';
const GEMINI_API_VERSION = (process.env.GEMINI_API_VERSION || 'v1').trim() || 'v1';
const GEMINI_IMAGE_API_VERSION = (process.env.GEMINI_IMAGE_API_VERSION || 'v1beta').trim() || 'v1beta';
const GEMINI_TEXT_MODEL_PREFERENCES = parseGeminiTextModels(
    process.env.GEMINI_TEXT_MODELS || process.env.GEMINI_TEXT_MODEL,
);
const GEMINI_PROMPT_VERSION = (process.env.GEMINI_PROMPT_VERSION || '1').trim() || '1';
const GENERATED_IMAGE_WIDTH = Number.isFinite(Number(process.env.GEMINI_IMAGE_OUTPUT_WIDTH))
    ? Math.max(320, Number(process.env.GEMINI_IMAGE_OUTPUT_WIDTH))
    : 1366;
const GENERATED_IMAGE_HEIGHT = Number.isFinite(Number(process.env.GEMINI_IMAGE_OUTPUT_HEIGHT))
    ? Math.max(180, Number(process.env.GEMINI_IMAGE_OUTPUT_HEIGHT))
    : 768;
const s3Client = new S3Client({ region: AWS_REGION });
const sqsClient = new SQSClient({ region: AWS_REGION });
const sfnClient = new SFNClient({ region: AWS_REGION });
const SCOUTS_DECISION_QUEUE_URL = process.env.SCOUTS_DECISION_QUEUE_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsDecision';
const SCOUTS_PROCESSING_QUEUE_URL_FALLBACK =
    process.env.SCOUTS_PROCESSING_QUEUE_URL
    || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessing';
const COMPLETED_REQUESTS_RUNTIME_KEY = 'runtime/scoutsComplete.json';
const APPROVAL_METADATA_PREFIX = process.env.APPROVAL_METADATA_PREFIX || 'approvals';
const S3_WEBSITE_BASE_URL = process.env.S3_WEBSITE_BASE_URL || 'https://scouts-2ndtolworth-prod-553490163883.s3.eu-west-2.amazonaws.com';
const S3_PUBLIC_ASSET_BASE_URL = (process.env.S3_PUBLIC_ASSET_BASE_URL || '').trim() ||
    (S3_WEBSITE_BASE_URL.startsWith('https://') ? S3_WEBSITE_BASE_URL : `https://${TARGET_BUCKET}.s3.${AWS_REGION}.amazonaws.com`);
const DEFAULT_GEMINI_IMAGE_MODELS = Object.freeze([
    // Gemini 3.1 Flash Image / Nano Banana 2
    'gemini-3.1-flash-image',
]);

const GEMINI_IMAGE_MODEL_PREFERENCES = (() => {
    const override = [process.env.GEMINI_IMAGE_MODELS, process.env.GEMINI_IMAGE_MODEL]
        .filter(Boolean)
        .join(',');
    const entries = (override ? override.split(',') : DEFAULT_GEMINI_IMAGE_MODELS)
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean);
    return Array.from(new Set(entries.length > 0 ? entries : DEFAULT_GEMINI_IMAGE_MODELS));
})();

const GEMINI_TEXT_FEATURE_FLAG_SOURCE = process.env.GEMINI;
const GEMINI_TEXT_FEATURE_ENABLED = isFeatureFlagEnabled(GEMINI_TEXT_FEATURE_FLAG_SOURCE, false);
const GEMINI_IMAGE_FEATURE_FLAG_SOURCE =
    process.env.GEMINI_IMAGES;
const GEMINI_IMAGE_FEATURE_ENABLED = isFeatureFlagEnabled(GEMINI_IMAGE_FEATURE_FLAG_SOURCE, false);
const SLACK_FEATURE_FLAG_SOURCE = process.env.slack ?? process.env.SLACK;
const SLACK_FEATURE_ENABLED = isFeatureFlagEnabled(SLACK_FEATURE_FLAG_SOURCE, true);
const PERSISTENCE_FEATURE_FLAG_SOURCE =
    process.env.PERSISTENCE;
const PERSISTENCE_FEATURE_ENABLED = isFeatureFlagEnabled(PERSISTENCE_FEATURE_FLAG_SOURCE, true);
const APPROVAL_PERSISTENCE_FLAG_SOURCE =
    process.env.APPROVAL_PERSISTENCE
    ?? process.env.APPROVAL_METADATA_PERSISTENCE
    ?? PERSISTENCE_FEATURE_FLAG_SOURCE;
const APPROVAL_PERSISTENCE_ENABLED = isFeatureFlagEnabled(APPROVAL_PERSISTENCE_FLAG_SOURCE, true);
let geminiTextRuntimeDisabled = false;
let geminiImageRuntimeDisabled = false;

function readBundledScoutsConfigSource() {
    const candidateUrls = [
        new URL('./scouts.conf', import.meta.url),
        new URL('../scouts.conf', import.meta.url),
    ];

    for (const candidateUrl of candidateUrls) {
        try {
            const raw = readFileSync(candidateUrl, 'utf8');
            return JSON.parse(raw);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                continue;
            }
            throw new Error(`[Config] Failed to read bundled scouts.conf: ${error?.message || error}`);
        }
    }

    throw new Error('[Config] Failed to read bundled scouts.conf: file not found');
}
const BUNDLED_SCOUTS_CONFIG_SOURCE = Object.freeze(readBundledScoutsConfigSource());

const DEFAULT_OSM_CDN_BASE_URL = 'https://oymcdn.co.uk';

function resolveOsmCdnBaseUrl() {
    const source = (process.env.OSM_CDN_BASE_URL ?? DEFAULT_OSM_CDN_BASE_URL) || '';
    const trimmed = source.trim();
    if (!trimmed) {
        return DEFAULT_OSM_CDN_BASE_URL;
    }
    return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function deriveThemedIconUrl(eventTitle, config) {
    const cdnBase = resolveOsmCdnBaseUrl();
    const defaultUrl = `${cdnBase}/ext/mymember/dashboard/images/global.jpg`;

    const candidates = Array.isArray(config?.themedIcons) ? config.themedIcons : [];
    if (!eventTitle || candidates.length === 0) {
        return defaultUrl;
    }

    const lowerCased = String(eventTitle).toLowerCase();
    for (const entry of candidates) {
        const pattern = typeof entry?.pattern === 'string' ? entry.pattern : null;
        const iconName = typeof entry?.icon === 'string' ? entry.icon.trim() : null;
        if (!pattern || !iconName) {
            continue;
        }
        try {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(lowerCased)) {
                return `${cdnBase}/ext/mymember/dashboard/images/${iconName}.jpg`;
            }
        } catch (error) {
            console.warn(`[ThemedIcon] Invalid pattern "${pattern}":`, error?.message || error);
        }
    }

    return defaultUrl;
}

const SCOUTS_CONFIG_KEY = process.env.SCOUTS_CONFIG_KEY || 'scouts.conf';
const SCOUTS_CONFIG_TTL_MS = Number.isFinite(Number(process.env.SCOUTS_CONFIG_TTL_MS))
    ? Number(process.env.SCOUTS_CONFIG_TTL_MS)
    : 5 * 60 * 1000;

let cachedScoutsConfig = null;
let cachedScoutsConfigExpiresAt = 0;

function parseQueueUrlFromArn(queueArn, fallbackUrl = null) {
    if (!queueArn || typeof queueArn !== 'string') return fallbackUrl;
    const parts = queueArn.split(':');
    if (parts.length < 6) return fallbackUrl;
    const region = parts[3];
    const accountId = parts[4];
    const queueName = parts.slice(5).join(':');
    if (!region || !accountId || !queueName) return fallbackUrl;
    return `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`;
}

function resolveScoutsProcessingQueueUrl(records = []) {
    for (const record of records) {
        const arn = record?.eventSourceARN || record?.eventSourceArn || null;
        const fromArn = parseQueueUrlFromArn(arn, null);
        if (fromArn) return fromArn;
    }
    return SCOUTS_PROCESSING_QUEUE_URL_FALLBACK;
}

function hasStepFunctionsTaskToken(messageBody) {
    return Boolean(
        typeof messageBody?.taskToken === 'string'
        && messageBody.taskToken.trim()
        && messageBody?.orchestrationType === 'imageEnrich'
    );
}

async function completeImageEnrichTask(messageBody, payload) {
    if (!hasStepFunctionsTaskToken(messageBody)) {
        return false;
    }

    await sfnClient.send(new SendTaskSuccessCommand({
        taskToken: messageBody.taskToken.trim(),
        output: JSON.stringify(payload ?? {}),
    }));
    return true;
}

async function failImageEnrichTask(messageBody, error) {
    if (!hasStepFunctionsTaskToken(messageBody)) {
        return false;
    }

    const errorName = typeof error?.name === 'string' && error.name.trim()
        ? error.name.trim()
        : 'ImageEnrichStepFailed';
    await sfnClient.send(new SendTaskFailureCommand({
        taskToken: messageBody.taskToken.trim(),
        error: errorName,
        cause: JSON.stringify({
            message: error?.message || String(error),
            hex: getHexHintFromMessageBody(messageBody),
            requestId: normaliseRuntimeText(messageBody?.requestId ?? null),
            orchestrationStep: normaliseRuntimeText(messageBody?.orchestrationStep ?? null),
        }),
    }));
    return true;
}

function getHexHintFromSubject(subject) {
    if (typeof subject === 'string') {
        const trimmed = subject.trim();
        return trimmed && /^[0-9a-f]+$/i.test(trimmed) ? trimmed.toLowerCase() : null;
    }
    if (!subject || typeof subject !== 'object') {
        return null;
    }
    if (typeof subject.metadata?.hex === 'string' && subject.metadata.hex.trim()) {
        return subject.metadata.hex.trim().toLowerCase();
    }
    if (typeof subject.hex === 'string' && subject.hex.trim()) {
        return subject.hex.trim().toLowerCase();
    }
    return null;
}

function normaliseRuntimeText(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim();
    return normalized || null;
}

function getHexHintFromMessageBody(messageBody) {
    const directHex = normaliseRuntimeText(
        messageBody?.hex
        ?? messageBody?.requestHex
        ?? null
    );
    if (directHex && /^[0-9a-f]+$/i.test(directHex)) {
        return directHex.toLowerCase();
    }
    return getHexHintFromSubject(messageBody?.subject);
}

function getTitleHintFromMessageBody(messageBody) {
    if (!messageBody || typeof messageBody !== 'object') {
        return null;
    }

    const directTitle = normaliseRuntimeText(messageBody.title ?? null);
    if (directTitle) {
        return directTitle;
    }

    const subject = messageBody.subject;
    if (subject && typeof subject === 'object') {
        return normaliseRuntimeText(subject.title ?? null);
    }

    return null;
}

function getSubjectHintFromMessageBody(messageBody) {
    if (!messageBody || typeof messageBody !== 'object') {
        return null;
    }

    const explicitSubject = normaliseRuntimeText(messageBody.subjectLabel ?? null);
    if (explicitSubject) {
        return explicitSubject;
    }

    if (typeof messageBody.subject === 'string') {
        return normaliseRuntimeText(messageBody.subject);
    }

    if (messageBody.subject && typeof messageBody.subject === 'object') {
        return normaliseRuntimeText(messageBody.subject.value ?? null);
    }

    return null;
}

function normaliseActionHint(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

function getRequestTimeHint(record, messageBody) {
    const directTimeCandidates = [
        messageBody?.requestTime,
        messageBody?.requestedAt,
        messageBody?.timestamp,
        messageBody?.createdAt,
    ];

    for (const candidate of directTimeCandidates) {
        if (typeof candidate !== 'string' || !candidate.trim()) continue;
        const parsed = new Date(candidate);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
    }

    const sentTimestamp = Number(record?.attributes?.SentTimestamp);
    if (Number.isFinite(sentTimestamp) && sentTimestamp > 0) {
        return new Date(sentTimestamp).toISOString();
    }

    const firstReceiveTimestamp = Number(record?.attributes?.ApproximateFirstReceiveTimestamp);
    if (Number.isFinite(firstReceiveTimestamp) && firstReceiveTimestamp > 0) {
        return new Date(firstReceiveTimestamp).toISOString();
    }

    return null;
}

function deduplicateRuntimeRequestEntries(entries = []) {
    const deduped = new Map();

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const taskToken = normaliseRuntimeText(entry.taskToken ?? null);
        const key = taskToken
            ? [
                'taskToken',
                taskToken,
                entry.orchestrationStep ?? '',
                entry.status ?? '',
            ].join('|')
            : [
                entry.requestId ?? '',
                entry.messageId ?? '',
                entry.hex ?? '',
                entry.realm ?? '',
                entry.action ?? '',
                entry.status ?? '',
            ].join('|');
        deduped.set(key, entry);
    }

    return Array.from(deduped.values()).slice(0, 200);
}

function collectRequestHints(record, messageBody) {
    const requestIds = new Set();
    const hexes = new Set();
    const links = [];

    const requestId =
        (messageBody && typeof messageBody === 'object'
            ? (messageBody.requestId ?? null)
            : null)
        ?? record?.messageId
        ?? null;
    const normalizedRequestId = requestId ? String(requestId) : null;

    if (record?.messageId) {
        requestIds.add(String(record.messageId));
    }
    if (normalizedRequestId) {
        requestIds.add(normalizedRequestId);
    }

    if (messageBody && typeof messageBody === 'object') {
        const hexHint = getHexHintFromSubject(messageBody.subject);
        if (hexHint) {
            hexes.add(hexHint);
            if (normalizedRequestId) {
                links.push({
                    requestId: normalizedRequestId,
                    hex: hexHint,
                    sourceMessageId: record?.messageId ? String(record.messageId) : null,
                    realm: messageBody?.realm ?? null,
                    action: messageBody?.action ?? null,
                });
            }
        }
    }

    const requests = [buildRuntimeRequestEntry(record, messageBody, 'processing')]
        .filter((entry) => entry.requestId || entry.messageId || entry.hex || entry.title);

    return {
        requestIds: Array.from(requestIds),
        hexes: Array.from(hexes),
        links,
        requests,
    };
}

function buildRequestContext(record, messageBody) {
    const baseRequestId =
        messageBody?.requestId
        ?? record?.messageId
        ?? crypto.randomUUID();
    const requestId = String(baseRequestId);
    const hex = getHexHintFromMessageBody(messageBody);
    return { requestId, hex };
}

function isStepFunctionsInvocation(event) {
    return !!(
        event
        && typeof event === 'object'
        && !Array.isArray(event)
        && !Array.isArray(event.Records)
        && event.invocationType === 'stepFunctions'
    );
}

function isAutoApprovalMode(messageBody) {
    if (messageBody?.autoApprove === true) return true;
    const approvalMode = typeof messageBody?.approvalMode === 'string' ? messageBody.approvalMode.trim().toLowerCase() : '';
    const requestMode = typeof messageBody?.requestMode === 'string' ? messageBody.requestMode.trim().toLowerCase() : '';
    return approvalMode === 'auto' || requestMode === 'auto';
}

async function fetchQueueDepthSnapshot(queueUrl) {
    if (!queueUrl) {
        return {
            queueUrl: null,
            visible: null,
            inFlight: null,
            delayed: null,
        };
    }

    try {
        const command = new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: [
                'ApproximateNumberOfMessages',
                'ApproximateNumberOfMessagesNotVisible',
                'ApproximateNumberOfMessagesDelayed',
            ],
        });
        const response = await sqsClient.send(command);
        const attrs = response?.Attributes || {};
        return {
            queueUrl,
            visible: Number(attrs.ApproximateNumberOfMessages ?? 0),
            inFlight: Number(attrs.ApproximateNumberOfMessagesNotVisible ?? 0),
            delayed: Number(attrs.ApproximateNumberOfMessagesDelayed ?? 0),
        };
    } catch (error) {
        console.warn('[Runtime] Failed to read scoutsProcessing queue depth:', error?.message || error);
        return {
            queueUrl,
            visible: null,
            inFlight: null,
            delayed: null,
            error: error?.message || String(error),
        };
    }
}

async function writeRuntimeSnapshot(key, payload) {
    const command = new PutObjectCommand({
        Bucket: TARGET_BUCKET,
        Key: key,
        Body: JSON.stringify(payload, null, 2),
        ContentType: 'application/json',
        CacheControl: 'no-store',
    });
    await s3Client.send(command);
}

function withRuntimeRequestStatus(entries = [], status = 'completed', failure = null) {
    return (Array.isArray(entries) ? entries : []).map((entry) => ({
        ...entry,
        status,
        completedAt: new Date().toISOString(),
        ...(failure ? { failure } : {}),
    }));
}

async function persistCompletedRequestsRuntimeSnapshot(records, requestIds, hexes, links, requests = [], outcome = {}) {
    const payload = {
        source: 'sqs2scouts',
        queue: 'scoutsComplete',
        updatedAt: new Date().toISOString(),
        requests: deduplicateRuntimeRequestEntries(withRuntimeRequestStatus(
            requests,
            outcome.status || 'completed',
            outcome.failure || null,
        )),
        requestIds: Array.from(new Set((requestIds || []).filter(Boolean))).slice(0, 50),
        hexes: Array.from(new Set((hexes || []).filter(Boolean))).slice(0, 50),
        links: Array.from(
            new Map(
                (Array.isArray(links) ? links : [])
                    .filter((entry) => entry && entry.requestId && entry.hex)
                    .map((entry) => [`${entry.requestId}|${entry.hex}`, entry])
            ).values()
        ).slice(0, 100),
        recordCount: Array.isArray(records) ? records.length : 0,
    };

    try {
        await writeRuntimeSnapshot(COMPLETED_REQUESTS_RUNTIME_KEY, payload);
        console.log(`[Runtime] Wrote queue snapshot to ${COMPLETED_REQUESTS_RUNTIME_KEY}`);
    } catch (error) {
        console.warn('[Runtime] Failed writing scoutsComplete snapshot:', error?.message || error);
    }
}

async function readBodyStream(body) {
    if (!body) return '';
    if (typeof body.transformToString === 'function') {
        return body.transformToString();
    }
    return new Promise((resolve, reject) => {
        const chunks = [];
        body.setEncoding?.('utf8');
        body.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
        body.once('end', () => resolve(chunks.join('')));
        body.once('error', reject);
    });
}

function cloneDefaultScoutsConfig() {
    const bundled = BUNDLED_SCOUTS_CONFIG_SOURCE && typeof BUNDLED_SCOUTS_CONFIG_SOURCE === 'object'
        ? BUNDLED_SCOUTS_CONFIG_SOURCE
        : {};
    return {
        // Keep the bundled fallback compatible with the pre-schema-migration
        // config names. Runtime S3 config is normalised below as well.
        taglineThemePromptTemplate: toNonEmptyString(
            bundled.taglineThemePromptTemplate ?? bundled.aiPromptTemplate
        ),
        imageThemePromptTemplate: toNonEmptyString(
            bundled.imageThemePromptTemplate ?? bundled.imagePromptTemplate
        ),
        imageGenerationPromptTemplate: toNonEmptyString(bundled.imageGenerationPromptTemplate),
        imageGenerationPromptSpecifications: Array.isArray(bundled.imageGenerationPromptSpecifications)
            ? bundled.imageGenerationPromptSpecifications.map((entry) => (typeof entry === 'string' ? entry.trim() : null)).filter(Boolean)
            : [],
        imageThemeGuidelines: Array.isArray(bundled.imageThemeGuidelines ?? bundled.imageTagGuidelines)
            ? (bundled.imageThemeGuidelines ?? bundled.imageTagGuidelines).map((entry) => (typeof entry === 'string' ? entry.trim() : null)).filter(Boolean)
            : [],
        scouts2sqs: bundled.scouts2sqs === true,
        themedIcons: Array.isArray(bundled.themedIcons) ? cloneJsonValue(bundled.themedIcons) : [],
    };
}

function sanitiseBooleanLike(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
    return undefined;
}

function isFeatureFlagEnabled(value, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (!normalized) return defaultValue;
    if (normalized === 'on' || normalized === 'enable' || normalized === 'enabled') return true;
    if (normalized === 'off' || normalized === 'disable' || normalized === 'disabled') return false;
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
    if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
    return defaultValue;
}

function emitGeminiMetric(kind, outcome) {
    const timestamp = Date.now();
    console.log(JSON.stringify({
        _aws: {
            Timestamp: timestamp,
            CloudWatchMetrics: [{
                Namespace: 'Scouts/Gemini',
                Dimensions: [['Outcome'], ['Kind', 'Outcome']],
                Metrics: [{ Name: 'Requests', Unit: 'Count' }],
            }],
        },
        Kind: kind,
        Outcome: outcome,
        Requests: 1,
    }));
}

function emitEnrichmentMetric(name, stage, outcome = 'count') {
    console.log(JSON.stringify({
        _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [{
                Namespace: 'Scouts/Gemini',
                Dimensions: [['Stage', 'Outcome']],
                Metrics: [{ Name: name, Unit: 'Count' }],
            }],
        },
        Stage: stage,
        Outcome: outcome,
        [name]: 1,
    }));
}

async function notifyEnrichmentTransition(stage, state, details = {}) {
    const attemptCount = Number(state?.attemptCount || 0);
    const category = state?.lastErrorType || 'UNKNOWN';
    const message = String(state?.lastErrorMessage || 'unknown error').replace(/[\r\n]+/g, ' ').slice(0, 300);
    if (state?.state === 'retry_wait' && attemptCount === 2) {
        await postSlackMessage({ text: `⚠️ Scouts enrichment retry warning\n\nHEX: ${details.hex}\nStage: ${stage}\nAttempts: ${attemptCount} / ${enrichmentStateConfig.MAX_ATTEMPTS}\nLast error: ${category}: ${message}\nNext retry: ${state.nextRetryAt || 'unknown'}\nRequest ID: ${details.requestId || 'unknown'}` });
    } else if (state?.state === 'manual_review' && await claimEnrichmentEscalation({ hex: details.hex, stage })) {
        await postSlackMessage({ text: `🚨 Scouts enrichment suspended\n\nHEX: ${details.hex}\nStage: ${stage}\nAutomatic enrichment has been stopped.\nAttempts: ${attemptCount}\nLast error: ${category}: ${message}\nGeneration ID: ${details.generationId || state.generationId || 'unknown'}\nRequest ID: ${details.requestId || state.lastRequestId || 'unknown'}` });
    }
}

async function checkStageEligibility(hex, stage, generationId = null) {
    try {
        const state = await getEnrichmentState(hex, stage);
        const evaluation = evaluateEnrichmentEligibility(state, new Date(), generationId);
        if (!evaluation.eligible) {
            emitEnrichmentMetric('EnrichmentSkipped', stage, evaluation.reason || 'ineligible');
        }
        return { ...evaluation, state };
    } catch (error) {
        console.error('[Enrichment] State lookup failed; blocking request:', error?.message || error);
        emitEnrichmentMetric('EnrichmentSkipped', stage, 'state_store_error');
        return { eligible: false, reason: 'state_store_error' };
    }
}

function toNonEmptyString(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function sanitiseScoutsConfig(raw) {
    const config = cloneDefaultScoutsConfig();
    if (!raw || typeof raw !== 'object') {
        return config;
    }

    const taglineTemplate = raw.taglineThemePromptTemplate ?? raw.aiPromptTemplate;
    if (typeof taglineTemplate === 'string' && taglineTemplate.trim()) {
        config.taglineThemePromptTemplate = taglineTemplate;
    }

    const imageThemeTemplate = raw.imageThemePromptTemplate ?? raw.imagePromptTemplate;
    if (typeof imageThemeTemplate === 'string' && imageThemeTemplate.trim()) {
        config.imageThemePromptTemplate = imageThemeTemplate;
    }

    if (typeof raw.imageGenerationPromptTemplate === 'string' && raw.imageGenerationPromptTemplate.trim()) {
        config.imageGenerationPromptTemplate = raw.imageGenerationPromptTemplate;
    }

    if (Array.isArray(raw.imageGenerationPromptSpecifications) && raw.imageGenerationPromptSpecifications.length > 0) {
        config.imageGenerationPromptSpecifications = raw.imageGenerationPromptSpecifications
            .map((entry) => (typeof entry === 'string' ? entry.trim() : null))
            .filter(Boolean);
    }

    const imageThemeGuidelines = raw.imageThemeGuidelines ?? raw.imageTagGuidelines;
    if (Array.isArray(imageThemeGuidelines) && imageThemeGuidelines.length > 0) {
        config.imageThemeGuidelines = imageThemeGuidelines
            .map((entry) => (typeof entry === 'string' ? entry.trim() : null))
            .filter(Boolean);
    }

    if (Array.isArray(raw.themedIcons)) {
        config.themedIcons = raw.themedIcons;
    }

    if (raw.scouts2sqs !== undefined) {
        config.scouts2sqs = raw.scouts2sqs === true || String(raw.scouts2sqs).trim().toLowerCase() === 'true';
    }

    return config;
}

async function loadScoutsConfig(force = false) {
    const now = Date.now();
    if (!force && cachedScoutsConfig && cachedScoutsConfigExpiresAt > now) {
        return cachedScoutsConfig;
    }

    try {
        const response = await s3Client.send(
            new GetObjectCommand({
                Bucket: TARGET_BUCKET,
                Key: SCOUTS_CONFIG_KEY,
            })
        );
        const body = await readBodyStream(response.Body);
        const parsed = JSON.parse(body);
        cachedScoutsConfig = sanitiseScoutsConfig(parsed);
        cachedScoutsConfigExpiresAt = now + Math.max(SCOUTS_CONFIG_TTL_MS, 60_000);
        console.log(`[Config] Loaded scouts configuration from s3://${TARGET_BUCKET}/${SCOUTS_CONFIG_KEY}`);
        return cachedScoutsConfig;
    } catch (error) {
        const isNotFound =
            error?.name === 'NoSuchKey'
            || error?.name === 'NotFound'
            || error?.$metadata?.httpStatusCode === 404;
        if (isNotFound) {
            console.log(`[Config] scouts configuration not found at s3://${TARGET_BUCKET}/${SCOUTS_CONFIG_KEY}; using defaults`);
        } else {
            console.warn(`[Config] Failed to load scouts configuration:`, error.message);
        }
        if (!cachedScoutsConfig) {
            cachedScoutsConfig = cloneDefaultScoutsConfig();
        }
        cachedScoutsConfigExpiresAt = now + 60_000;
        return cachedScoutsConfig;
    }
}

function normalizeImagePrompt(value) {
    if (value === undefined || value === null) return null;
    const cleaned = String(value)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned ? cleaned.slice(0, 80) : null;
}

function buildImageGenerationPromptSpecificationsText(specifications) {
    if (!Array.isArray(specifications) || specifications.length === 0) return '';
    const cleaned = specifications
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean);
    return cleaned.length > 0 ? cleaned.join(', ') : '';
}

function buildImageGenerationPromptFromTheme(theme, config = null) {
    if (theme === undefined || theme === null) {
        return null;
    }
    const normalizedTheme = String(theme).trim();
    if (!normalizedTheme) {
        return null;
    }
    const template = toNonEmptyString(config?.imageGenerationPromptTemplate);
    if (!template) {
        return null;
    }
    const specifications = buildImageGenerationPromptSpecificationsText(config?.imageGenerationPromptSpecifications);
    return template
        .replace(/{{IMAGE_THEME}}/g, normalizedTheme)
        .replace(/{{IMAGE_PROMPT_SPECIFICATIONS}}/g, specifications)
        .replace(/\s+/g, ' ')
        .trim();
}

function getDerivedImageGenerationPromptForEvent(event, config = null) {
    const theme = toNonEmptyString(event?.image?.theme);
    if (!theme) {
        return null;
    }
    return buildImageGenerationPromptFromTheme(theme, config);
}

function buildEventDetailsForPrompt(event) {
    const details = [];
    
    // Try to get title from event or decode from hex
    let title = event.title ?? event.summary ?? event.name;
    if (!title && event.hex) {
        const decodedTitle = decodeHexTitle(event.hex);
        if (decodedTitle) {
            title = decodedTitle;
        }
    }
    
    if (title) {
        details.push(`Title: ${title}`);
    }
    if (event.section) {
        details.push(`Section: ${event.section}`);
    }
    const start = event.start?.iso ?? event.start?.raw ?? event.start ?? null;
    if (start) {
        details.push(`Start: ${start}`);
    }
    if (event.location) {
        details.push(`Location: ${event.location}`);
    }
    if (event.description) {
        details.push(`Description: ${event.description}`);
    }
    if (event.notes) {
        details.push(`Notes: ${event.notes}`);
    }
    if (event.source ?? event.calendar) {
        details.push(`Source: ${event.source ?? event.calendar}`);
    }
    return details.join('\n') || 'No additional event context provided.';
}

function buildImageThemeGuidelinesText(guidelines) {
    if (!Array.isArray(guidelines) || guidelines.length === 0) {
        return '';
    }
    return guidelines.map((line) => `- ${line}`).join('\n');
}

async function buildGeminiTextRequestPrompt(event, mode, configOverride = null) {
    const config = configOverride ?? (await loadScoutsConfig());
    
    let template;
    if (mode === 'tagline') {
        template = typeof config.taglineThemePromptTemplate === 'string' && config.taglineThemePromptTemplate.trim()
            ? config.taglineThemePromptTemplate
            : null;
    } else if (mode === 'imageTheme') {
        template = typeof config.imageThemePromptTemplate === 'string' && config.imageThemePromptTemplate.trim()
            ? config.imageThemePromptTemplate
            : null;
    } else {
        template = typeof config.taglineThemePromptTemplate === 'string' && config.taglineThemePromptTemplate.trim()
            ? config.taglineThemePromptTemplate
            : null;
    }
    if (!template) {
        throw new Error(`Missing prompt template in scouts.conf for mode=${mode}`);
    }
    
    const guidelines = buildImageThemeGuidelinesText(config.imageThemeGuidelines);
    const details = buildEventDetailsForPrompt(event);

    return template
        .replace(/{{EVENT_DETAILS}}/g, details)
        .replace(/{{IMAGE_TAG_GUIDELINES}}/g, guidelines);
}

function normaliseGeminiTextResponse(result) {
    if (!result || typeof result !== 'object') {
        return { raw: result, tagline: null, imageTheme: null, imageTag: null };
    }

    const tagline = typeof result.tagline === 'string' ? result.tagline.trim() : null;
    const imageTag =
        typeof result.imageTag === 'string'
            ? normalizeImagePrompt(result.imageTag)
            : null;

    return {
        raw: result,
        tagline,
        imageTheme: imageTag,
        imageTag,
    };
}

function blockedEnrichmentResult(reason, state = null, failure = null) {
    return { enrichmentBlocked: true, reason, state: state || reason, failureCategory: failure?.type || reason, failureMessage: failure?.message || reason };
}

async function generateGeminiTextSuggestion(event, mode, configOverride = null, options = {}) {
    if (!GEMINI_TEXT_FEATURE_ENABLED) {
        console.log('[Gemini] Feature flag disabled; skipping AI suggestion', {
            geminiFlag: GEMINI_TEXT_FEATURE_FLAG_SOURCE ?? null,
        });
        return blockedEnrichmentResult('feature_disabled', 'manual_review');
    }
    if (geminiTextRuntimeDisabled) {
        console.log('[Gemini] Runtime disabled; skipping AI suggestion');
        return blockedEnrichmentResult('runtime_disabled', 'manual_review');
    }

    const hexValue = String(options.hexValue ?? event?.hex ?? '').trim().toLowerCase();
    const stage = mode === 'imageTheme' ? 'imageTheme' : 'tagline';
    const generationId = options.generationId || buildGenerationId(hexValue, stage, event, GEMINI_PROMPT_VERSION);
    
    const geminiApiKey = await getOptionalSecret('GEMINI_API_KEY_PARAMETER', '');
    if (!geminiApiKey) {
        console.warn('[Gemini] GEMINI_API_KEY not set; skipping AI suggestion');
        const failedState = await markEnrichmentFailure({ hex: hexValue, stage, error: new Error('Gemini API key is not configured'), attemptCount: 1 }).catch(() => null);
        await notifyEnrichmentTransition(stage, failedState, { hex: hexValue, generationId, requestId: options.requestId }).catch(() => {});
        return blockedEnrichmentResult('configuration_failure', 'manual_review');
    }

    const prompt = await buildGeminiTextRequestPrompt(event, mode, configOverride);
    if (!prompt) {
        console.warn('[Gemini] Built prompt is empty; skipping suggestion');
        return blockedEnrichmentResult('empty_prompt', 'manual_review');
    }

    // Diagnostic logs
    try {
        console.log(`[Gemini] Preparing to generate suggestion (mode=${mode}). Prompt length: ${String(prompt.length)}`);
    } catch {}

    // Load SDK lazily so local tests don't fail if package is not installed
    let GoogleGenerativeAILib;
    try {
        GoogleGenerativeAILib = (await import('@google/generative-ai')).GoogleGenerativeAI;
    } catch (err) {
        console.warn('[Gemini] @google/generative-ai SDK not available:', err?.message || err);
        return blockedEnrichmentResult('sdk_unavailable', 'manual_review');
    }

    const reusable = await loadReusableGeneration({ hex: hexValue, stage, generationId }).catch((error) => {
        console.warn('[Enrichment] Failed to read generation cache:', error?.message || error);
        return null;
    });
    if (reusable) {
        console.log(JSON.stringify({ hex: hexValue, stage, generationId, requestId: options.requestId || null, attemptCount: reusable.state?.attemptCount || 0, stateBefore: reusable.state?.state || 'succeeded', stateAfter: 'succeeded', geminiRequestAttempted: false, geminiResultReused: true, failureCategory: null }));
        emitEnrichmentMetric('GeminiResultReused', stage, 'reused');
        const reusableValidation = validateGeminiTextResponse(reusable.generatedValue, stage);
        return reusableValidation.valid ? normaliseGeminiTextResponse(reusableValidation.value) : blockedEnrichmentResult('invalid_cached_generation', 'manual_review');
    }

    const stageEligibility = await checkStageEligibility(hexValue, stage, generationId);
    if (!stageEligibility.eligible) {
        return blockedEnrichmentResult(stageEligibility.reason, stageEligibility.state?.state);
    }

    const reservation = await reserveEnrichmentAttempt({
        hex: hexValue,
        stage,
        generationId,
        requestId: options.requestId,
    }).catch((error) => {
        console.error('[Enrichment] Failed to reserve stage attempt:', error?.message || error);
        return { reserved: false, reason: 'state_store_error' };
    });
    if (!reservation?.reserved) {
        emitEnrichmentMetric('EnrichmentSkipped', stage, reservation?.reason || 'reservation_rejected');
        return blockedEnrichmentResult(reservation?.reason || 'reservation_rejected', reservation?.state?.state);
    }
    console.log(JSON.stringify({ hex: hexValue, stage, generationId, requestId: options.requestId || null, attemptCount: reservation.state?.attemptCount || null, stateBefore: stageEligibility.state?.state || 'pending', stateAfter: 'in_progress', geminiRequestAttempted: true, geminiResultReused: false, failureCategory: null }));

    try {
        const genAI = new GoogleGenerativeAILib(geminiApiKey);
        const { result, model, attemptedModels } = await generateGeminiTextWithFallback({
            models: GEMINI_TEXT_MODEL_PREFERENCES,
            generate: async (modelName) => {
                const suggestionModel = genAI.getGenerativeModel({
                    model: modelName,
                    generationConfig: {
                        temperature: 0.3,
                        maxOutputTokens: 2048,
                        responseMimeType: 'application/json',
                        responseSchema: GEMINI_TEXT_RESPONSE_SCHEMAS[stage],
                    },
                });
                console.log('[Gemini] Request payload:', { model: modelName, prompt: prompt.substring(0, 200) + '...' });
                return suggestionModel.generateContent(prompt);
            },
            onFailure: (modelName, modelError) => {
                console.warn(`[Gemini] Text model ${modelName} failed with ${modelError?.status || modelError?.code || 'unknown'}; trying the next model when retryable.`);
            },
        });
        console.log('[Gemini] Text suggestion generated', { model, attemptedModels });
        const responseObj = result?.response;
        const responseText = typeof responseObj?.text === 'function' ? responseObj.text().trim() : String(responseObj || '').trim();

        console.log('[Gemini] Raw response snippet:', responseText.slice(0, 200).replace(/\n/g, ' '));

        const cleaned = responseText.replace(/```json|```/gi, '').trim();
        let parsed = null;
        try {
            parsed = JSON.parse(cleaned);
        } catch (jsonErr) {
            emitGeminiMetric('text', 'failure');
            const failedState = await markEnrichmentFailure({
                hex: hexValue,
                stage,
                error: Object.assign(new Error('Model returned invalid JSON'), { cause: jsonErr }),
                attemptCount: reservation?.state?.attemptCount,
            }).catch(() => null);
            emitEnrichmentMetric(failedState?.state === 'manual_review' ? 'EnrichmentQuarantined' : 'EnrichmentRetry', stage, 'INVALID_EVENT_DATA');
            await notifyEnrichmentTransition(stage, failedState, { hex: hexValue, generationId, requestId: options.requestId }).catch(() => {});
            console.warn('[Gemini] Failed to parse JSON from model response:', jsonErr.message);
            console.warn('[Gemini] Cleaned response was:', cleaned.slice(0, 1000));
            return blockedEnrichmentResult('invalid_json', 'manual_review', { type: 'INVALID_EVENT_DATA', message: 'Model returned invalid JSON' });
        }

        const validation = validateGeminiTextResponse(parsed, stage);
        if (!validation.valid) {
            const failedState = await markEnrichmentFailure({
                hex: hexValue, stage,
                error: new Error(`Model returned invalid event data: ${validation.reason}`),
                attemptCount: reservation?.state?.attemptCount,
            }).catch(() => null);
            emitEnrichmentMetric('EnrichmentQuarantined', stage, 'INVALID_EVENT_DATA');
            await notifyEnrichmentTransition(stage, failedState, { hex: hexValue, generationId, requestId: options.requestId }).catch(() => {});
            return blockedEnrichmentResult(validation.reason, 'manual_review', { type: 'INVALID_EVENT_DATA', message: validation.reason });
        }
        const normalized = normaliseGeminiTextResponse(validation.value);
        await markGeminiSucceeded({ hex: hexValue, stage, generationId, generatedValue: normalized.raw ?? parsed });
        emitGeminiMetric('text', 'success');
        return normalized;
    } catch (error) {
        emitGeminiMetric('text', 'failure');
        const failedState = await markEnrichmentFailure({
            hex: hexValue,
            stage,
            error,
            attemptCount: reservation?.state?.attemptCount,
        }).catch((stateError) => {
            console.error('[Enrichment] Failed to persist text failure state:', stateError?.message || stateError);
            return null;
        });
        emitEnrichmentMetric(failedState?.state === 'manual_review' ? 'EnrichmentQuarantined' : 'EnrichmentRetry', stage, failedState?.lastErrorType || 'failure');
        await notifyEnrichmentTransition(stage, failedState, { hex: hexValue, generationId, requestId: options.requestId }).catch((notifyError) => {
            console.warn('[Enrichment] Failed to send transition alert:', notifyError?.message || notifyError);
        });
        console.warn(`[Gemini] Failed to generate ${mode} suggestion:`, error?.message || error);
        if (error && error.stack) console.debug(error.stack);
        if (isGeminiBillingRestrictionError(error)) {
            geminiTextRuntimeDisabled = true;
            console.warn('[Gemini] Disabling AI suggestions for the remainder of this runtime due to billing restrictions.');
        }
        return blockedEnrichmentResult(failedState?.state || 'generation_failed', failedState?.state, { type: failedState?.lastErrorType || 'GENERATION_FAILED', message: error?.message || String(error) });
    }
}

function ensureImageContainer(image = {}) {
    return {
        theme: image.theme ?? null,
        url: image.url ?? null,
    };
}

function getMetadataObject(event) {
    if (!event || typeof event !== 'object') return null;
    return event.metadata && typeof event.metadata === 'object' ? event.metadata : null;
}

function getStatusObject(event) {
    if (!event || typeof event !== 'object') return null;
    const metadataStatus = getMetadataObject(event)?.status;
    if (metadataStatus && typeof metadataStatus === 'object') return metadataStatus;
    return null;
}

function normalizeBooleanLike(value) {
    if (value === true || value === false) return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
        if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
    }
    return null;
}

function firstDefinedBoolean(...values) {
    for (const value of values) {
        const normalized = normalizeBooleanLike(value);
        if (normalized !== null) return normalized;
    }
    return null;
}

function normalizeLegacyText(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text ? text : null;
}

function ensureRuntimeMetadata(event, fallbackHex = null) {
    if (!event || typeof event !== 'object') return event;

    const metadata = getMetadataObject(event) || {};
    if (!event.metadata || typeof event.metadata !== 'object') {
        event.metadata = metadata;
    }

    const hexValue = normalizeLegacyText(
        metadata.hex
        ?? fallbackHex
    );
    if (hexValue) {
        const normalizedHex = hexValue.toLowerCase();
        event.hex = normalizedHex;
        metadata.hex = normalizedHex;
    } else if ('hex' in event) {
        delete event.hex;
    }
    const tagline = normalizeLegacyText(metadata.tagline);
    metadata.tagline = tagline;
    event.tagline = tagline;

    const metadataImage = metadata.image && typeof metadata.image === 'object' ? metadata.image : {};
    const imageTheme = normalizeLegacyText(
        metadataImage.theme
    );
    const imageUrl = normalizeLegacyText(metadataImage.url);
    event.image = ensureImageContainer({
        theme: imageTheme,
        url: imageUrl,
    });
    metadata.image = {
        theme: imageTheme,
        url: imageUrl,
    };

    const metadataStatus = metadata.status && typeof metadata.status === 'object' ? metadata.status : {};
    const isApproved = firstDefinedBoolean(metadataStatus.isApproved) ?? false;
    const isHidden = firstDefinedBoolean(metadataStatus.isHidden) ?? false;

    metadata.status = {
        isApproved,
        isHidden,
    };
    event.metadata = metadata;
    return event;
}

function getImageThemeValue(event) {
    const metadataImage = getMetadataObject(event)?.image;
    if (!metadataImage || typeof metadataImage !== 'object') return null;
    return normalizeLegacyText(metadataImage.theme);
}

function getImageUrlValue(event) {
    const metadataImage = getMetadataObject(event)?.image;
    if (!metadataImage || typeof metadataImage !== 'object') return null;
    return normalizeLegacyText(metadataImage.url);
}

function removeTopLevelFieldsDuplicatedByMetadata(event) {
    if (!event || typeof event !== 'object') return;
    const metadata = getMetadataObject(event);
    if (!metadata || typeof metadata !== 'object') return;

    if ('tagline' in metadata) {
        delete event.tagline;
        if ('AI' in event) delete event.AI;
    }

    if (metadata.image && typeof metadata.image === 'object') {
        delete event.image;
    }

    if (metadata.status && typeof metadata.status === 'object') {
        delete event.status;
        delete event.approved;
        delete event.isApproved;
        delete event.isHidden;
        delete event.hidden;
        delete event.hiddenAt;
    }

    if (typeof metadata.hex === 'string' && metadata.hex.trim()) {
        delete event.hex;
        delete event.hexId;
    }
}

function normalizeHexEventShape(eventData, fallbackHex = null) {
    if (!eventData || typeof eventData !== 'object') return eventData;
    return ensureRuntimeMetadata(eventData, fallbackHex);
}

function getTagline(event) {
    return normalizeLegacyText(getMetadataObject(event)?.tagline);
}

function setTagline(event, value) {
    if (!event || typeof event !== 'object') return;
    const finalValue = normalizeLegacyText(value);
    if (!event.metadata || typeof event.metadata !== 'object') {
        event.metadata = {};
    }
    event.metadata.tagline = finalValue;
    event.tagline = finalValue;
}

function setImageTheme(event, value) {
    const theme = normalizeImagePrompt(value);
    if (!theme) return;
    ensureRuntimeMetadata(event);
    event.image = event.image && typeof event.image === 'object' ? event.image : {};
    event.image.theme = theme;
    event.metadata.image = event.metadata.image && typeof event.metadata.image === 'object' ? event.metadata.image : {};
    event.metadata.image.theme = theme;
    delete event.image.prompt;
}

function setImageApprovalState(event, isApproved) {
    if (!event || typeof event !== 'object') return;
    const approved = isApproved === true;
    ensureRuntimeMetadata(event);
    if (!event.metadata || typeof event.metadata !== 'object') {
        event.metadata = {};
    }
    const metadataStatus = event.metadata.status && typeof event.metadata.status === 'object'
        ? event.metadata.status
        : {};
    event.metadata.status = {
        ...metadataStatus,
        isApproved: approved,
        isHidden: metadataStatus.isHidden === true,
    };
}

function hasCompleteApprovalData(event) {
    if (!event || typeof event !== 'object') {
        return false;
    }
    const hasTagline = typeof getTagline(event) === 'string';
    const hasTheme = typeof getImageThemeValue(event) === 'string';
    return hasTagline && hasTheme;
}

function resolveImageUrlForDisplay(url) {
    if (!url || typeof url !== 'string') {
        return null;
    }
    const trimmed = url.trim();
    if (!trimmed) {
        return null;
    }
    const publicBase = S3_PUBLIC_ASSET_BASE_URL.replace(/\/+$/, '');
    const websiteBase = S3_WEBSITE_BASE_URL.replace(/\/+$/, '');

    const buildFromRelative = (relativePath) => {
        const cleaned = relativePath.replace(/^\/+/, '');
        if (!cleaned) {
            return publicBase;
        }
        return `${publicBase}/${cleaned}`;
    };

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        if (websiteBase && trimmed.startsWith(websiteBase)) {
            const relative = trimmed.slice(websiteBase.length);
            return buildFromRelative(relative);
        }
        if (trimmed.startsWith('http://')) {
            return `https://${trimmed.slice('http://'.length)}`;
        }
        return trimmed;
    }

    return buildFromRelative(trimmed);
}

function sanitizeEventUid(uid) {
    if (uid === undefined || uid === null) return null;
    let candidate = String(uid).trim();
    if (!candidate) return null;
    candidate = candidate.split(/[\\/]/)[0] || candidate;
    candidate = candidate.replace(/\s+/g, '-');
    candidate = candidate.replace(/[^a-zA-Z0-9._-]/g, '-');
    candidate = candidate.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    const digitPrefixMatch = candidate.match(/^(.*?\d+)/);
    if (digitPrefixMatch) {
        candidate = digitPrefixMatch[1];
    }
    return candidate || null;
}

function applySanitizedUidToEvent(event) {
    if (!event) return null;
    const rawUid = event.uid ?? event.originalUid ?? null;
    const sanitized = sanitizeEventUid(rawUid);
    if (!sanitized) return null;
    if (rawUid && rawUid !== sanitized) {
        event.originalUid = rawUid;
    }
    event.uid = sanitized;
    return sanitized;
}

const KNOWN_IMAGE_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);

function sanitizeHexForImageKey(hexValue) {
    if (typeof hexValue !== 'string') return '';
    return hexValue.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function sanitizeTitleForImageKey(eventTitle) {
    if (typeof eventTitle !== 'string') return 'event';
    const trimmed = eventTitle.trim().toLowerCase();
    if (!trimmed) return 'event';
    return trimmed.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 50) || 'event';
}

function sanitizeRequestIdForImageKey(requestId) {
    if (typeof requestId !== 'string') return '';
    const trimmed = requestId.trim().toLowerCase();
    if (!trimmed) return '';
    return trimmed.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeImageExtension(extension) {
    if (typeof extension !== 'string') return null;
    const trimmed = extension.trim();
    if (!trimmed) return null;
    const prefixed = trimmed.startsWith('.') ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`;
    if (KNOWN_IMAGE_EXTENSIONS.includes(prefixed)) {
        return prefixed;
    }
    return null;
}

function inferExtensionFromMimeType(type) {
    if (!type || typeof type !== 'string') {
        return null;
    }
    const lower = type.toLowerCase();
    if (lower.includes('png')) return '.png';
    if (lower.includes('gif')) return '.gif';
    if (lower.includes('webp')) return '.webp';
    if (lower.includes('svg')) return '.svg';
    if (lower.includes('jpeg')) return '.jpeg';
    if (lower.includes('jpg')) return '.jpg';
    return null;
}

async function uploadImageBufferToWebsiteS3(imageBuffer, {
    contentType = 'image/jpeg',
    hexValue,
    eventTitle,
    requestId,
    extensionHint,
} = {}) {
    if (!imageBuffer || !(imageBuffer instanceof Buffer) || imageBuffer.length === 0) {
        throw new Error('Image buffer is empty');
    }

    const sanitizedHex = sanitizeHexForImageKey(hexValue);
    const sanitizedTitle = sanitizeTitleForImageKey(eventTitle);
    const sanitizedRequestId = sanitizeRequestIdForImageKey(requestId);

    let finalBuffer = imageBuffer;
    let finalContentType = 'image/jpeg';
    let finalExtension = '.jpg';

    try {
        finalBuffer = await sharp(imageBuffer)
            .rotate()
            .trim()
            .resize({
                width: GENERATED_IMAGE_WIDTH,
                height: GENERATED_IMAGE_HEIGHT,
                fit: 'inside',
                withoutEnlargement: true,
            })
            .jpeg({ mozjpeg: true, quality: 85 })
            .toBuffer();
        console.log('[Image Conversion] Converted Gemini image to resized JPEG for storage', {
            width: GENERATED_IMAGE_WIDTH,
            height: GENERATED_IMAGE_HEIGHT,
        });
    } catch (conversionError) {
        console.warn(`[Image Conversion] Failed to convert image to JPEG: ${conversionError.message}. Using original buffer without conversion.`);
        finalBuffer = imageBuffer;
        finalContentType = contentType || 'image/jpeg';
        finalExtension = normalizeImageExtension(extensionHint)
            || inferExtensionFromMimeType(contentType)
            || '.jpg';
        if (!KNOWN_IMAGE_EXTENSIONS.includes(finalExtension)) {
            finalExtension = '.jpg';
        }
    }

    const timestamp = Date.now();
    const baseBaseFilename = sanitizedHex || `${sanitizedTitle}-${timestamp}`;
    const baseFilename = sanitizedRequestId
        ? `${baseBaseFilename}-${sanitizedRequestId}`
        : baseBaseFilename;
    const s3Key = `${EVENT_IMAGE_PREFIX}${baseFilename}${finalExtension}`;

    const command = new PutObjectCommand({
        Bucket: TARGET_BUCKET,
        Key: s3Key,
        Body: finalBuffer,
        ContentType: finalContentType,
        CacheControl: 'public, max-age=31536000',
    });

    await s3Client.send(command);
    console.log(`[Image Upload] Uploaded generated image to s3://${TARGET_BUCKET}/${s3Key}`);

    return {
        success: true,
        relativeUrl: s3Key,
    };
}

function extractInlineImageDataFromGemini(response) {
    if (!response) return null;
    const generatedImages = Array.isArray(response.generatedImages) ? response.generatedImages : [];
    for (const entry of generatedImages) {
        const imagePayload = entry?.image ?? entry;
        if (!imagePayload) continue;
        const data =
            imagePayload.imageBytes ||
            imagePayload.bytesBase64Encoded ||
            imagePayload.base64Data ||
            imagePayload.data ||
            null;
        if (data) {
            return {
                data,
                mimeType:
                    imagePayload.mimeType ||
                    imagePayload.mediaType ||
                    imagePayload.contentType ||
                    'image/png',
            };
        }
    }
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    for (const candidate of candidates) {
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        for (const part of parts) {
            if (part?.inlineData?.data) {
                return part.inlineData;
            }
            if (part?.inline_data?.data) {
                return part.inline_data;
            }
        }
    }
    return null;
}

function normaliseGeminiImageError(error) {
    if (error instanceof Error) {
        if (typeof error.status === 'undefined' && typeof error.response?.status === 'number') {
            error.status = error.response.status;
        }
        return error;
    }
    if (error && typeof error === 'object' && typeof error.message === 'string') {
        const enriched = new Error(error.message);
        if (typeof error.status !== 'undefined') enriched.status = error.status;
        if (typeof error.response?.status === 'number') enriched.status = error.response.status;
        if (typeof error.code !== 'undefined') enriched.code = error.code;
        return enriched;
    }
    return new Error(typeof error === 'string' ? error : 'Gemini image generation failed');
}

function extractGeminiStatusCode(error) {
    if (!error) return null;
    const candidates = [
        error.status,
        error.statusCode,
        error.code,
        error?.response?.status,
        error?.response?.statusCode,
    ];
    for (const candidate of candidates) {
        const numeric = Number(candidate);
        if (Number.isFinite(numeric)) {
            return numeric;
        }
    }
    return null;
}

function isGeminiBillingRestrictionError(error) {
    if (!error) return false;
    const status = extractGeminiStatusCode(error);
    const messageCandidates = [
        error?.message,
        error?.error?.message,
        error?.reason,
        error?.details && JSON.stringify(error.details),
        error?.response?.data && JSON.stringify(error.response.data),
    ];
    for (const candidate of messageCandidates) {
        if (!candidate || typeof candidate !== 'string') continue;
        const normalized = candidate.toLowerCase();
        if (normalized.includes('only accessible to billed users')) return true;
        if (normalized.includes('billing') && normalized.includes('imagen')) return true;
    }
    return false;
}

function extractRetryAfterHeader(error) {
    const rawHeader =
        error?.response?.headers?.get?.('retry-after') ??
        error?.response?.headers?.['retry-after'] ??
        error?.response?.headers?.get?.('Retry-After') ??
        error?.response?.headers?.['Retry-After'] ??
        null;
    if (!rawHeader) {
        return null;
    }
    return String(rawHeader).trim();
}

function formatGeminiImageErrorForSlack(error) {
    if (!error) {
        return 'Gemini image generation failed';
    }
    const parts = [];
    const status = extractGeminiStatusCode(error);
    if (status) {
        const statusText =
            status === 429
                ? 'Too Many Requests'
                : typeof error?.response?.statusText === 'string'
                    ? error.response.statusText.trim()
                    : '';
        parts.push(statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`);
    }
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    if (message) {
        parts.push(message);
    } else if (typeof error === 'string') {
        parts.push(error);
    }
    const retryAfter = extractRetryAfterHeader(error);
    if (retryAfter) {
        parts.push(`Retry After: ${retryAfter}`);
    }
    return parts.join(' - ') || 'Gemini image generation failed';
}

function isGeminiNotFoundError(error) {
    if (!error) return false;
    const status = extractGeminiStatusCode(error);
    if (status === 404) {
        return true;
    }
    const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
    return message.includes('404') || message.includes('not found');
}

async function generateGeminiImageAsset(promptText, { hexValue, eventTitle, requestId, event = {}, generationId: suppliedGenerationId } = {}) {
    if (geminiImageRuntimeDisabled) {
        console.log('[GeminiImage] Runtime disabled; skipping Gemini image generation');
        return null;
    }
    const normalisedHexValue = String(hexValue ?? event?.hex ?? '').trim().toLowerCase();
    const generationId = suppliedGenerationId || buildGenerationId(normalisedHexValue, 'image', event, GEMINI_PROMPT_VERSION);
    const geminiApiKey = await getOptionalSecret('GEMINI_API_KEY_PARAMETER', '');
    if (!geminiApiKey) {
        console.warn('[GeminiImage] GEMINI_API_KEY not set; cannot generate image');
        const failedState = await markEnrichmentFailure({ hex: normalisedHexValue, stage: 'image', error: new Error('Gemini API key is not configured'), attemptCount: 1 }).catch(() => null);
        await notifyEnrichmentTransition('image', failedState, { hex: normalisedHexValue, generationId, requestId }).catch(() => {});
        return null;
    }

    const requestPrompt = typeof promptText === 'string' ? promptText.trim() : '';
    if (!requestPrompt) {
        console.warn('[GeminiImage] Missing prompt for image generation');
        return null;
    }

    let GoogleGenAIClient;
    try {
        ({ GoogleGenAI: GoogleGenAIClient } = await import('@google/genai'));
    } catch (err) {
        console.warn('[GeminiImage] @google/genai SDK not available:', err?.message || err);
        return null;
    }

    if (!Array.isArray(GEMINI_IMAGE_MODEL_PREFERENCES) || GEMINI_IMAGE_MODEL_PREFERENCES.length === 0) {
        console.warn('[GeminiImage] No Gemini image models configured');
        return null;
    }

    const reusable = await loadReusableGeneration({ hex: normalisedHexValue, stage: 'image', generationId }).catch((error) => {
        console.warn('[Enrichment] Failed to read image generation cache:', error?.message || error);
        return null;
    });
    if (reusable) {
        console.log(JSON.stringify({ hex: normalisedHexValue, stage: 'image', generationId, requestId: requestId || null, attemptCount: reusable.state?.attemptCount || 0, stateBefore: reusable.state?.state || 'succeeded', stateAfter: 'succeeded', geminiRequestAttempted: false, geminiResultReused: true, failureCategory: null }));
        emitEnrichmentMetric('GeminiResultReused', 'image', 'reused');
        return reusable.generatedValue;
    }

    const stageEligibility = await checkStageEligibility(normalisedHexValue, 'image', generationId);
    if (!stageEligibility.eligible) {
        return { enrichmentBlocked: true, reason: stageEligibility.reason };
    }
    const reservation = await reserveEnrichmentAttempt({
        hex: normalisedHexValue,
        stage: 'image',
        generationId,
        requestId,
    }).catch((error) => {
        console.error('[Enrichment] Failed to reserve image attempt:', error?.message || error);
        return { reserved: false, reason: 'state_store_error' };
    });
    if (!reservation?.reserved) {
        emitEnrichmentMetric('EnrichmentSkipped', 'image', reservation?.reason || 'reservation_rejected');
        return { enrichmentBlocked: true, reason: reservation?.reason || 'reservation_rejected' };
    }
    console.log(JSON.stringify({ hex: normalisedHexValue, stage: 'image', generationId, requestId: requestId || null, attemptCount: reservation.state?.attemptCount || null, stateBefore: stageEligibility.state?.state || 'pending', stateAfter: 'in_progress', geminiRequestAttempted: true, geminiResultReused: false, failureCategory: null }));

    const genAI = new GoogleGenAIClient({
        apiKey: geminiApiKey,
        apiVersion: GEMINI_IMAGE_API_VERSION,
    });
    let lastError = null;

    for (const modelName of GEMINI_IMAGE_MODEL_PREFERENCES) {
        if (!modelName) continue;
        console.log(`[GeminiImage] Generating image with model ${modelName} and prompt:`, requestPrompt);
        try {
            const isImagenModel = /^imagen-/i.test(modelName);
            const response = isImagenModel
                ? await genAI.models.generateImages({
                    model: modelName,
                    prompt: requestPrompt,
                    config: {
                        numberOfImages: 1,
                        aspectRatio: '16:9',
                    },
                })
                : await genAI.models.generateContent({
                    model: modelName,
                    contents: requestPrompt,
                });

            const inlineData = extractInlineImageDataFromGemini(response);
            if (!inlineData?.data) {
                lastError = new Error(`Model ${modelName} did not return inline image data`);
                console.warn(`[GeminiImage] Model ${modelName} did not return inline image data`);
                continue;
            }

            const mimeType = inlineData?.mimeType || inlineData?.mime_type || 'image/png';
            const imageBuffer = Buffer.from(inlineData.data, 'base64');
            const uploadResult = await uploadImageBufferToWebsiteS3(imageBuffer, {
                contentType: mimeType,
                hexValue,
                eventTitle,
                requestId,
                extensionHint: inferExtensionFromMimeType(mimeType) || '.png',
            });

            if (!uploadResult?.success || !uploadResult.relativeUrl) {
                throw new Error('Gemini image upload failed; no relative URL returned');
            }

            const generatedValue = {
                relativeUrl: uploadResult.relativeUrl,
                mimeType,
                prompt: requestPrompt,
            };
            await markGeminiSucceeded({ hex: hexValue, stage: 'image', generationId, generatedValue });
            emitGeminiMetric('image', 'success');
            return generatedValue;
        } catch (error) {
            emitGeminiMetric('image', 'failure');
            const normalizedError = normaliseGeminiImageError(error);
            if (typeof error?.status === 'number' && typeof normalizedError.status !== 'number') {
                normalizedError.status = error.status;
            }
            if (typeof error?.code === 'number' && typeof normalizedError.code !== 'number') {
                normalizedError.code = error.code;
            }
            console.warn(`[GeminiImage] Model ${modelName} failed:`, formatGeminiImageErrorForSlack(normalizedError));
            lastError = normalizedError;

            const failedState = await markEnrichmentFailure({
                hex: hexValue,
                stage: 'image',
                error: normalizedError,
                attemptCount: reservation?.state?.attemptCount,
            }).catch(() => null);
            emitEnrichmentMetric(failedState?.state === 'manual_review' ? 'EnrichmentQuarantined' : 'EnrichmentRetry', 'image', failedState?.lastErrorType || 'failure');
            await notifyEnrichmentTransition('image', failedState, { hex: hexValue, generationId, requestId }).catch(() => {});

            if (isGeminiNotFoundError(normalizedError)) {
                continue;
            }

            if (isGeminiBillingRestrictionError(normalizedError)) {
                geminiImageRuntimeDisabled = true;
                console.warn('[GeminiImage] Disabling Gemini image generation for the remainder of this runtime due to billing restrictions.');
            }
            throw normalizedError;
        }
    }

    if (lastError) {
        throw lastError;
    }

    console.warn('[GeminiImage] No Gemini image models returned a response');
    return null;
}

function parseJsonSubject(subject) {
    if (typeof subject === 'string') {
        const trimmed = subject.trim();
        if (!trimmed) return null;
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            console.warn('[Payload] Failed to parse subject JSON string:', error.message);
            return null;
        }
    }
    if (typeof subject === 'object' && subject !== null) {
        return subject;
    }
    return null;
}

function decodeHexTitle(hexValue) {
    if (typeof hexValue !== 'string') return null;
    const trimmed = hexValue.trim();
    if (!trimmed || trimmed.length % 2 !== 0) return null;
    if (!/^[0-9a-f]+$/i.test(trimmed)) return null;
    try {
        const decoded = Buffer.from(trimmed, 'hex').toString('utf8');
        return decoded.trim() || decoded;
    } catch (error) {
        console.warn(`[Hex] Failed to decode title from HEX ${trimmed}:`, error.message);
        return null;
    }
}

async function loadHexEventFromS3(hexValue) {
    if (typeof hexValue !== 'string') return null;
    const trimmed = hexValue.trim();
    if (!trimmed) return null;

    const candidateKeys = [`events/${trimmed}.json`, `events/{{${trimmed}}}.json`];

    for (const key of candidateKeys) {
        try {
            const response = await s3Client.send(
                new GetObjectCommand({
                    Bucket: TARGET_BUCKET,
                    Key: key,
                })
            );
            const body = await readBodyStream(response.Body);
            const data = JSON.parse(body);
            if (!data.hex) {
                data.hex = trimmed;
            }
            normalizeHexEventShape(data, trimmed);
            console.log(`[Hex] Loaded enrichment data from s3://${TARGET_BUCKET}/${key}`);
            return data;
        } catch (error) {
            if (
                error?.name === 'NoSuchKey'
                || error?.name === 'NotFound'
                || error?.$metadata?.httpStatusCode === 404
            ) {
                continue;
            }
            console.warn(`[Hex] Error loading s3://${TARGET_BUCKET}/${key}:`, error.message);
            throw error;
        }
    }

    console.warn(`[Hex] No enrichment data found for HEX ${trimmed}`);
    return null;
}

async function downloadImageToWebsiteS3(imageUrl, hexValue, eventTitle, requestId) {
    const failureResponse = (reason, extras = {}) => ({
        success: false,
        reason,
        sourceUrl: typeof imageUrl === 'string' ? imageUrl.trim() : null,
        ...extras,
    });

    if (!imageUrl || typeof imageUrl !== 'string') {
        console.warn('[Image Download] Invalid image URL provided');
        return failureResponse('Invalid image URL');
    }

    const trimmedUrl = imageUrl.trim();
    const isRemote = trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://');
    if (!isRemote) {
        const relativePath = trimmedUrl.replace(/^\/+/, '');
        if (!relativePath) {
            console.warn('[Image Download] Relative image path is empty');
            return failureResponse('Relative image path missing');
        }
        console.log('[Image Download] Received relative image path, skipping download');
        return {
            success: true,
            relativeUrl: relativePath,
            sourceUrl: null,
            reused: true,
        };
    }

    const sanitizedHex = sanitizeHexForImageKey(hexValue);
    const sanitizedTitle = sanitizeTitleForImageKey(eventTitle);

    try {
        console.log(`[Image Download] Downloading image from: ${trimmedUrl}`);
        
        const response = await fetch(trimmedUrl);
        if (!response.ok) {
            const statusText = `${response.status} ${response.statusText}`.trim();
            console.warn(`[Image Download] Failed to fetch image: ${statusText}`);
            return failureResponse(`HTTP ${statusText}`, { statusCode: response.status });
        }

        const contentType = response.headers.get('content-type') || 'image/jpeg';

        const inferExtensionFromUrl = (url) => {
            try {
                const { pathname } = new URL(url);
                const match = pathname.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i);
                return match ? `.${match[1].toLowerCase()}` : null;
            } catch {
                return null;
            }
        };

        const inferExtensionFromContentType = (type) => {
            if (!type || typeof type !== 'string') {
                return null;
            }
            const lower = type.toLowerCase();
            if (lower.includes('png')) return '.png';
            if (lower.includes('gif')) return '.gif';
            if (lower.includes('webp')) return '.webp';
            if (lower.includes('svg')) return '.svg';
            if (lower.includes('jpeg')) return '.jpeg';
            if (lower.includes('jpg')) return '.jpg';
            return null;
        };

        let extension = inferExtensionFromUrl(trimmedUrl)
            || inferExtensionFromContentType(contentType)
            || '.jpg';
        extension = normalizeImageExtension(extension) || '.jpg';

        const imageBuffer = Buffer.from(await response.arrayBuffer());
        const uploadResult = await uploadImageBufferToWebsiteS3(imageBuffer, {
            contentType,
            hexValue,
            eventTitle,
            requestId,
            extensionHint: extension,
        });

        const relativeUrl = uploadResult.relativeUrl;
        console.log(`[Image Download] Image available at relative URL: ${relativeUrl}`);
        return {
            success: true,
            relativeUrl,
            sourceUrl: trimmedUrl,
            reused: false,
        };
    } catch (error) {
        console.error(`[Image Download] Error downloading image from ${trimmedUrl}:`, error.message);
        return failureResponse(error.message || 'Unexpected error');
    }
}

async function saveHexEventToS3(hexValue, payload) {
    const trimmed = typeof hexValue === 'string' ? hexValue.trim() : '';
    if (!trimmed) {
        throw new Error('Cannot store HEX payload without identifier');
    }

    const key = `events/${trimmed}.json`;
    const bucket = TARGET_BUCKET;
    const toStore = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? JSON.parse(JSON.stringify(payload))
        : payload;

    // Normalize legacy AI -> tagline for event files and remove AI key before persistence.
    if (toStore && typeof toStore === 'object' && !Array.isArray(toStore)) {
        normalizeHexEventShape(toStore, trimmed);
        removeTopLevelFieldsDuplicatedByMetadata(toStore);
        delete toStore.location;
        delete toStore.section;
        delete toStore.icsType;
        delete toStore.processing;
    }
    
    try {
        const command = new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: JSON.stringify(toStore, null, 2),
            ContentType: 'application/json',
            CacheControl: 'no-store',
        });
        
        const putResult = await s3Client.send(command);
        console.log(`[Hex] Successfully saved HEX file to s3://${bucket}/${key}`, {
            eTag: putResult?.ETag || null,
            versionId: putResult?.VersionId || null,
        });

        // Read-after-write verification to prove what was persisted to this exact key.
        try {
            const verifyResponse = await s3Client.send(
                new GetObjectCommand({
                    Bucket: bucket,
                    Key: key,
                })
            );
            const verifyBody = await readBodyStream(verifyResponse.Body);
            const verified = JSON.parse(verifyBody);
            console.log(`[Hex] Verified persisted HEX content at s3://${bucket}/${key}`, {
                tagline: getTagline(verified),
                imageTheme: getImageThemeValue(verified),
                imageUrl: getImageUrlValue(verified),
                eTag: verifyResponse?.ETag || null,
                versionId: verifyResponse?.VersionId || null,
            });
        } catch (verifyError) {
            console.error(`[Hex] Read-after-write verification failed for s3://${bucket}/${key}:`, verifyError?.message || verifyError);
            throw verifyError;
        }
    } catch (error) {
        console.error(`[Hex] Failed to save HEX file to s3://${bucket}/${key}:`, error.message);
        throw error;
    }
}

async function publishHexEventToAgenda(hexValue, event) {
    try {
        const result = await publishCanonicalEventToAgenda({
            hex: hexValue,
            event,
            loadAgenda: async () => {
                const response = await s3Client.send(new GetObjectCommand({ Bucket: TARGET_BUCKET, Key: 'agenda.json' }));
                return JSON.parse(await readBodyStream(response.Body));
            },
            writeAgenda: (agenda) => s3Client.send(new PutObjectCommand({
                Bucket: TARGET_BUCKET,
                Key: 'agenda.json',
                Body: JSON.stringify(agenda, null, 2),
                ContentType: 'application/json',
                CacheControl: 'no-store',
            })),
        });
        console.log(`[Agenda] Published canonical HEX ${hexValue} to agenda.json`, result);
        return result;
    } catch (error) {
        error.message = `Agenda publication failed for HEX ${hexValue}: ${error?.message || error}`;
        console.error('[Agenda] Canonical event persisted but agenda publication failed', error.message);
        throw error;
    }
}

async function loadEventFromS3(uid, fallbackUid) {
    const sanitized = sanitizeEventUid(uid);
    if (!sanitized) return null;
    const tryKeys = [`events/${sanitized}.json`];
    if (fallbackUid && fallbackUid !== sanitized) {
        tryKeys.push(`events/${fallbackUid}.json`);
    }

    for (const key of tryKeys) {
        try {
            const response = await s3Client.send(
                new GetObjectCommand({
                    Bucket: TARGET_BUCKET,
                    Key: key,
                })
            );
            const body = await readBodyStream(response.Body);
            const data = JSON.parse(body);
            console.log(`[GeminiImage] Loaded existing event data from s3://${TARGET_BUCKET}/${key}`);
            applySanitizedUidToEvent(data);
            return data;
        } catch (error) {
            if (
                error?.name === 'NoSuchKey'
                || error?.name === 'NotFound'
                || error?.$metadata?.httpStatusCode === 404
            ) {
                console.log(`[GeminiImage] No existing event data found at s3://${TARGET_BUCKET}/${key}`);
                continue;
            }
            throw error;
        }
    }

    return null;
}

async function saveEventToS3(eventData) {
    const sanitized = applySanitizedUidToEvent(eventData);
    if (!sanitized) {
        console.warn('[GeminiImage] Persistence disabled; event missing uid, nothing to store');
        return;
    }
    if (!PERSISTENCE_FEATURE_ENABLED) {
        console.log(`[GeminiImage] Persistence disabled by flag; skipping save for event ${sanitized}`);
        return;
    }

    const key = `events/${sanitized}.json`;
    const toStore =
        eventData && typeof eventData === 'object' && !Array.isArray(eventData)
            ? JSON.parse(JSON.stringify(eventData))
            : eventData;
    if (toStore && typeof toStore === 'object' && !Array.isArray(toStore)) {
        normalizeHexEventShape(toStore, sanitized);
        removeTopLevelFieldsDuplicatedByMetadata(toStore);
        delete toStore.location;
        delete toStore.section;
        delete toStore.icsType;
        delete toStore.processing;
    }
    await s3Client.send(
        new PutObjectCommand({
            Bucket: TARGET_BUCKET,
            Key: key,
            Body: JSON.stringify(toStore, null, 2),
            ContentType: 'application/json',
            CacheControl: 'no-store',
        })
    );
    console.log(`[GeminiImage] Saved event data to s3://${TARGET_BUCKET}/${key}`);
}

function deriveApprovalIdentifiers(event) {
    if (!event || typeof event !== 'object') {
        return [];
    }
    const identifiers = new Set();
    if (typeof event.hex === 'string' && event.hex.trim()) {
        identifiers.add(event.hex.trim().toLowerCase());
    }
    const candidateUid = sanitizeEventUid(event.uid);
    if (candidateUid) {
        identifiers.add(candidateUid);
    }
    const candidateOriginalUid = sanitizeEventUid(event.originalUid);
    if (candidateOriginalUid) {
        identifiers.add(candidateOriginalUid);
    }
    return Array.from(identifiers);
}

function sanitiseRealmForPath(realm) {
    if (typeof realm !== 'string' || !realm.trim()) {
        return 'unknown';
    }
    return realm.trim().toLowerCase().replace(/[^a-z0-9._-]/gi, '-');
}

function buildApprovalMetadataKey(identifier, realm) {
    const safeIdentifier = typeof identifier === 'string'
        ? identifier.trim().replace(/[^a-zA-Z0-9._-]/g, '-')
        : null;
    if (!safeIdentifier) {
        throw new Error('Cannot build metadata key without identifier');
    }
    const safeRealm = sanitiseRealmForPath(realm);
    return `${APPROVAL_METADATA_PREFIX}/${safeIdentifier}/${safeRealm}.json`;
}

async function storeApprovalMessageReference(event, realm, slackResponse, additionalMetadata = {}) {
    if (!slackResponse?.ok) {
        console.warn('[Approval] Slack response missing ok flag; skipping metadata storage');
        return;
    }
    const channel = slackResponse.channel ?? slackResponse.channelId ?? slackResponse.message?.channel ?? null;
    const ts = slackResponse.ts ?? slackResponse.message?.ts ?? null;
    if (!channel || !ts) {
        console.warn('[Approval] Slack response missing channel or ts; skipping metadata storage');
        return;
    }

    const identifiers = deriveApprovalIdentifiers(event);
    if (identifiers.length === 0) {
        console.warn('[Approval] No identifiers found on event; skipping metadata storage');
        return;
    }

    const clonedEvent = JSON.parse(JSON.stringify(event));
    normalizeHexEventShape(clonedEvent, clonedEvent.hex ?? event.hex ?? null);
    removeTopLevelFieldsDuplicatedByMetadata(clonedEvent);

    const metadata = {
        realm,
        channel,
        ts,
        identifiers,
        hex: event.hex ?? null,
        storedAt: new Date().toISOString(),
        status: 'PENDING',
        event: clonedEvent,
    };

    if (additionalMetadata && typeof additionalMetadata === 'object') {
        for (const [key, value] of Object.entries(additionalMetadata)) {
            if (value !== undefined) {
                metadata[key] = value;
            }
        }
    }

    if (!APPROVAL_PERSISTENCE_ENABLED) {
        console.log('[Approval] Persistence disabled by flag; not storing approval metadata', {
            realm,
            channel,
            identifiers,
        });
        return;
    }

    await Promise.all(
        identifiers.map((identifier) => {
            const key = buildApprovalMetadataKey(identifier, realm);
            return s3Client.send(
                new PutObjectCommand({
                    Bucket: TARGET_BUCKET,
                    Key: key,
                    Body: JSON.stringify(metadata, null, 2),
                    ContentType: 'application/json',
                    CacheControl: 'no-store',
                })
            );
        })
    );
    console.log('[Approval] Stored approval metadata', { realm, channel, identifiers });
}

async function loadApprovalMessageMetadata(identifiers, realm) {
    const triedKeys = [];
    for (const identifier of identifiers) {
        const key = buildApprovalMetadataKey(identifier, realm);
        triedKeys.push(key);
        try {
            const response = await s3Client.send(
                new GetObjectCommand({
                    Bucket: TARGET_BUCKET,
                    Key: key,
                })
            );
            const body = await readBodyStream(response.Body);
            const metadata = JSON.parse(body);
            metadata._keys = identifiers.map((id) => buildApprovalMetadataKey(id, realm));
            return metadata;
        } catch (error) {
            if (
                error?.name === 'NoSuchKey'
                || error?.name === 'NotFound'
                || error?.$metadata?.httpStatusCode === 404
            ) {
                continue;
            }
            console.warn(`[Approval] Error loading metadata ${key}:`, error.message);
        }
    }
    if (triedKeys.length > 0) {
        console.warn(`[Approval] No metadata found for realm=${realm} identifiers=${triedKeys.join(', ')}`);
    }
    return null;
}

async function persistApprovalMetadata(metadata, overrides = {}) {
    if (!metadata) {
        return;
    }
    const merged = {
        ...metadata,
        ...overrides,
        updatedAt: new Date().toISOString(),
    };
    delete merged._keys;

    const identifierCandidates = Array.isArray(merged.identifiers)
        ? merged.identifiers
        : Array.isArray(metadata.identifiers)
            ? metadata.identifiers
            : [];
    const identifiers = Array.from(
        new Set(
            identifierCandidates
                .map((entry) => (typeof entry === 'string' ? entry.trim() : entry))
                .filter((entry) => typeof entry === 'string' && entry.length > 0)
        )
    );

    if (identifiers.length === 0) {
        console.warn('[Approval] Metadata missing identifiers; skipping persistence');
        return;
    }

    if (merged.event) {
        merged.event = JSON.parse(JSON.stringify(merged.event));
    }
    merged.identifiers = identifiers;

    if (!APPROVAL_PERSISTENCE_ENABLED) {
        console.log('[Approval] Persistence disabled by flag; not updating approval metadata', {
            realm: merged.realm ?? metadata.realm,
            identifiers,
        });
        return;
    }

    const realm = merged.realm ?? metadata.realm;
    const candidateKeys = Array.isArray(metadata._keys)
        ? metadata._keys.filter((key) => typeof key === 'string' && key.trim())
        : [];
    const keys = candidateKeys.length > 0
        ? candidateKeys
        : identifiers.map((identifier) => buildApprovalMetadataKey(identifier, realm));

    await Promise.all(
        keys.map((key) =>
            s3Client.send(
                new PutObjectCommand({
                    Bucket: TARGET_BUCKET,
                    Key: key,
                    Body: JSON.stringify(merged, null, 2),
                    ContentType: 'application/json',
                    CacheControl: 'no-store',
                })
            )
        )
    );
    console.log('[Approval] Updated approval metadata', { realm, identifiers });
}

async function sendSlackApiRequest(url, payload, retryCount = 0) {
    const slackBotToken = await getRequiredSecret('SLACK_BOT_TOKEN_PARAMETER');
    const options = {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${slackBotToken}`,
            'Content-Type': 'application/json',
        },
    };

    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => (responseData += chunk));
            res.on('end', () => {
                try {
                    const response = JSON.parse(responseData);
                    if (!response.ok) {
                        const error = new Error(`Slack API error: ${JSON.stringify(response)}`);
                        if (retryCount < 2) {
                            setTimeout(() => {
                                sendSlackApiRequest(url, payload, retryCount + 1)
                                    .then(resolve)
                                    .catch(reject);
                            }, 1000 * (retryCount + 1));
                            return;
                        }
                        reject(error);
                        return;
                    }
                    resolve(response);
                } catch (error) {
                    reject(new Error(`Failed to parse Slack response: ${error.message}`));
                }
            });
        });
        req.on('error', (error) => {
            if (retryCount < 2) {
                setTimeout(() => {
                    sendSlackApiRequest(url, payload, retryCount + 1)
                        .then(resolve)
                        .catch(reject);
                }, 1000 * (retryCount + 1));
                return;
            }
            reject(error);
        });
        req.write(JSON.stringify(payload));
        req.end();
    });
}

async function sendToDLQ(payload, error) {
    try {
        const dlqCommand = new SendMessageCommand({
            QueueUrl: DLQ_URL,
            MessageBody: JSON.stringify({ ...payload, error: error.message, timestamp: new Date().toISOString() }),
        });
        await sqsClient.send(dlqCommand);
        console.log('[DLQ] Message sent to DLQ after processing failure');
    } catch (dlqError) {
        console.error('[DLQ] Failed to send to DLQ:', dlqError.message);
    }
}

async function postToResponseUrl(responseUrl, payload) {
    if (!responseUrl || typeof responseUrl !== 'string') {
        throw new Error('Invalid response_url');
    }

    return new Promise((resolve, reject) => {
        try {
            const data = JSON.stringify(payload);
            const parsed = new URL(responseUrl);
            const options = {
                method: 'POST',
                hostname: parsed.hostname,
                path: parsed.pathname + (parsed.search || ''),
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                },
            };

            const req = https.request(options, (res) => {
                let responseData = '';
                res.on('data', (chunk) => (responseData += chunk));
                res.on('end', () => {
                    try {
                        // Some response_urls return plain text; try to parse but don't fail if unparsable
                        let parsedBody = null;
                        try {
                            parsedBody = JSON.parse(responseData);
                        } catch (e) {
                            parsedBody = responseData;
                        }
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(parsedBody);
                        } else {
                            reject(new Error(`response_url POST failed: ${res.statusCode} ${res.statusMessage} ${String(parsedBody)}`));
                        }
                    } catch (err) {
                        reject(err);
                    }
                });
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

async function updateSlackApprovalMessage(channel, ts, text, blocks = null) {
    const payload = {
        channel,
        ts,
        text,
    };
    if (blocks) {
        payload.blocks = blocks;
    }
    return sendSlackApiRequest(SLACK_CHAT_UPDATE_URL, payload);
}

function ensureObjectSubject(subject) {
    if (!subject) return {};

    if (typeof subject === 'string') {
        const trimmed = subject.trim();
        if (!trimmed) return {};

        const seemsJson = trimmed.startsWith('{') || trimmed.startsWith('[');
        if (seemsJson) {
            try {
                const parsed = JSON.parse(trimmed);
                ensureRuntimeMetadata(parsed);
                return parsed;
            } catch (error) {
                console.warn('Failed to parse JSON subject string, falling back to raw value:', error.message);
            }
        }

        if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
            return { hex: trimmed };
        }

        return { value: trimmed };
    }

    ensureRuntimeMetadata(subject);
    return subject;
}

function cloneJsonValue(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function parsePersistPatch(action) {
    if (!action) return null;
    if (typeof action === 'object' && !Array.isArray(action)) {
        return cloneJsonValue(action);
    }
    if (typeof action !== 'string') {
        return null;
    }
    const trimmed = action.trim();
    if (!trimmed.startsWith('{')) {
        return null;
    }
    try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
    } catch (error) {
        console.warn('[Persist] Failed to parse persist patch action JSON:', error.message);
        return null;
    }
}

export function buildPersistEventPayload(existingEvent, rawSubject, action) {
    const baseEvent =
        existingEvent && typeof existingEvent === 'object' && !Array.isArray(existingEvent)
            ? cloneJsonValue(existingEvent)
            : {};
    const persistPatch = parsePersistPatch(action);
    const subjectObject = ensureObjectSubject(rawSubject);

    if (persistPatch) {
        mergePersistPatch(baseEvent, persistPatch);
    }
    if (subjectObject && Object.keys(subjectObject).length > 0) {
        mergePersistPatch(baseEvent, subjectObject);
    }

    ensureRuntimeMetadata(baseEvent);
    applySanitizedUidToEvent(baseEvent);
    return baseEvent;
}

function mergePersistPatch(target, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return target;
    }
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
        return cloneJsonValue(patch);
    }

    for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const baseChild = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
                ? target[key]
                : {};
            target[key] = mergePersistPatch(baseChild, value);
            continue;
        }
        target[key] = value;
    }

    return target;
}

function formatDetailLine(label, value, fallback = '_not provided_') {
    if (value === null || value === undefined || value === '') {
        return `*${label}:* ${fallback}`;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            // For image-related fields prefer a plain URL so Slack can auto-unfurl/preview the image.
            // For other links keep the existing wrapped <url|url> format so the link text is clear.
            const isImageLabel = /image/i.test(label);
            if (isImageLabel) {
                return `*${label}:* ${trimmed}`;
            }
            return `*${label}:* <${trimmed}|${trimmed}>`;
        }
        return `*${label}:* ${trimmed}`;
    }
    try {
        return `*${label}:* ${JSON.stringify(value)}`;
    } catch {
        return `*${label}:* ${String(value)}`;
    }
}

function buildEventDetailsSection(event, actionLabel, realm = null, options = {}) {
    applySanitizedUidToEvent(event);

    const {
        excludeFields = [],
        suppressEmptyFallback = false,
    } = options;

    const exclusionSet = excludeFields instanceof Set
        ? new Set(excludeFields)
        : Array.isArray(excludeFields)
            ? new Set(excludeFields)
            : new Set();
    
    // Always exclude UID fields from Slack notifications
    exclusionSet.add('uid');
    exclusionSet.add('originalUid');
    
    const shouldInclude = (field) => !exclusionSet.has(field);
    const config = options.config ?? cachedScoutsConfig ?? null;
    const derivedImagePrompt = getDerivedImageGenerationPromptForEvent(event, config);

    const lines = [];

    if (shouldInclude('hex') && event.hex) {
        lines.push(formatDetailLine('Hex ID', event.hex));
    }

    // For tagline realm: show title, tagline and image theme
    if (realm === 'tagline') {
        if (shouldInclude('title') && (event.title ?? event.summary ?? event.name)) {
            lines.push(formatDetailLine('Title', event.title ?? event.summary ?? event.name));
        }
        const tagline = getTagline(event);
        if (shouldInclude('tagline') && tagline) {
            lines.push(formatDetailLine('Tagline', tagline));
        }
        if (shouldInclude('imageTheme') && event.image?.theme) {
            lines.push(formatDetailLine('Image Theme', event.image.theme));
        }
    }
    // For imageTheme realm: show image theme
    else if (realm === 'imageTheme') {
        if (shouldInclude('imageTheme') && event.image?.theme) {
            lines.push(formatDetailLine('Image Theme', event.image.theme));
        }
    }
    // For image/imageUrl realms: show image link only if assigned
    else if (realm === 'image' || realm === 'imageUrl') {
        if (shouldInclude('imageTheme') && derivedImagePrompt) {
            lines.push(formatDetailLine('Image Prompt', derivedImagePrompt));
        }
        if (shouldInclude('imageUrl') && event.image?.url) {
            const displayUrl = resolveImageUrlForDisplay(event.image.url);
            lines.push(formatDetailLine('Image Link', displayUrl));
        }
    }
    // For other realms, show all details (legacy behavior)
    else {
        if (shouldInclude('action')) {
            lines.push(formatDetailLine('Action', actionLabel ?? 'unknown'));
        }
        if (shouldInclude('tagline')) {
            lines.push(formatDetailLine('Tagline', getTagline(event)));
        }
        if (shouldInclude('title')) {
            lines.push(formatDetailLine('Title', event.title ?? event.summary ?? event.name));
        }
        if (shouldInclude('imageTheme') && event.image?.theme) {
            lines.push(formatDetailLine('Image Theme', event.image.theme));
        }
        if (shouldInclude('imageTheme') && derivedImagePrompt) {
            lines.push(formatDetailLine('Image Prompt', derivedImagePrompt));
        }
        if (shouldInclude('imageUrl')) {
            const displayUrl = resolveImageUrlForDisplay(event.image?.url);
            lines.push(formatDetailLine('Image URL', displayUrl));
        }
    }

    if (lines.length === 0) {
        return suppressEmptyFallback ? null : '_No additional details available._';
    }

    return lines.join('\n');
}

function buildApprovalBlocks(event, actionLabel, options = {}) {
    const {
        config = null,
        realm = 'scouts',
        approveAction = actionLabel,
        rejectAction = 'reject',
        previewText = null,
        excludeFields = [],
        suppressEmptyFallback = false,
    } = options;

    const eventTitle = event.title ?? event.summary ?? event.name ?? 'Scouts Event';

    let reviewTarget;
    if (realm === 'tagline') {
        reviewTarget = 'Tagline';
    } else if (realm === 'imageTheme') {
        reviewTarget = 'Image Theme';
    } else if (realm === 'image' || realm === 'imageUrl') {
        reviewTarget = 'Image Link';
    } else {
        reviewTarget = actionLabel ?? 'update';
    }
    const headerText = `${eventTitle} needs approval for: ${reviewTarget}`.slice(0, 150);
    
    const blocks = [
        {
            type: 'header',
            text: {
                type: 'plain_text',
                text: headerText,
                emoji: true,
            },
        },
    ];

    if (previewText) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: previewText },
        });
    }

    // For approval realm, add editable input fields instead of read-only details
    // Show read-only details in the message; editing happens via modal
    const detailsText = buildEventDetailsSection(event, actionLabel, realm, {
        config: config ?? cachedScoutsConfig ?? null,
        excludeFields,
        suppressEmptyFallback,
    });

    if (detailsText) {
        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: detailsText,
            },
        });
    }
    
    // Only add image block if URL is valid and accessible
    if (event.image?.url) {
        const imageUrl = event.image.url.trim();
        const displayUrl = resolveImageUrlForDisplay(imageUrl);

        if (displayUrl && (displayUrl.startsWith('http://') || displayUrl.startsWith('https://'))) {
            try {
                new URL(displayUrl); // Validate URL format
                
                // Display as image block with full URL
                blocks.push({
                    type: 'image',
                    image_url: displayUrl,
                    alt_text: `Image for ${eventTitle}`,
                });
            } catch (urlError) {
                console.warn(`[Slack] Invalid image URL format: ${displayUrl}`);
                blocks.push({
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `*Image URL:* ${imageUrl} _(URL format invalid)_`,
                    },
                });
            }
        } else {
            console.warn(`[Slack] Invalid URL format: ${displayUrl}`);
            blocks.push({
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Image URL:* ${imageUrl} _(invalid URL format)_`,
                },
            });
        }
    }

    // Create hide value object
    const buildActionValue = (actionTag) => JSON.stringify({
        action: actionTag || null,
        realm: options.realm ?? realm ?? null,
        previewText: previewText ?? null,
        event,
    });
    const approveValue = buildActionValue(options.approveAction ?? 'APPROVE');
    const editValue = buildActionValue('EDIT');
    const skipValue = buildActionValue(options.rejectAction ?? 'REJECT');
    const hideValue = buildActionValue('HIDE');

    blocks.push({
        type: 'actions',
        block_id: 'scouts_request_actions',
        elements: [
            {
                type: 'button',
                action_id: 'scouts_request_approve',
                text: {
                    type: 'plain_text',
                    emoji: true,
                    text: 'Approve',
                },
                style: 'primary',
                value: approveValue,
            },
            {
                type: 'button',
                action_id: 'scouts_request_edit',
                text: {
                    type: 'plain_text',
                    emoji: true,
                    text: 'Edit',
                },
                value: editValue,
            },
            {
                type: 'button',
                action_id: 'scouts_request_skip',
                text: {
                    type: 'plain_text',
                    emoji: true,
                    text: 'Skip',
                },
                style: 'danger',
                value: skipValue,
            },
            {
                type: 'button',
                action_id: 'scouts_request_hide',
                text: {
                    type: 'plain_text',
                    emoji: true,
                    text: 'Hide',
                },
                value: hideValue,
            },
        ],
    });

    return blocks;
}

async function prepareEnrichmentReview(realm, subject, configOverride = null) {
    let subjectHex = null;
    let incomingEvent = {};

    if (typeof subject === 'string') {
        subjectHex = subject.trim();
    } else if (subject && typeof subject === 'object') {
        incomingEvent = ensureObjectSubject(subject);
        if (typeof incomingEvent.hex === 'string') {
            subjectHex = incomingEvent.hex;
        }
    }

    if (!subjectHex && subject && typeof subject === 'object' && typeof subject.hex === 'string') {
        subjectHex = subject.hex;
    }

    let hexData = null;
    if (subjectHex) {
        hexData = await loadHexEventFromS3(subjectHex);
    }

    const candidateUid = incomingEvent.uid ?? hexData?.uid ?? null;
    const candidateOriginalUid = incomingEvent.originalUid ?? hexData?.originalUid ?? null;
    let storedEvent = null;
    if (candidateUid) {
        try {
            storedEvent = await loadEventFromS3(candidateUid, candidateOriginalUid);
        } catch (error) {
            console.warn(`[Hex] Unable to load stored event for uid ${candidateUid}:`, error.message);
        }
    }

    const mergedEvent = {
        ...(storedEvent || {}),
        ...(hexData || {}),
        ...(incomingEvent || {}),
    };

    if (subjectHex) {
        mergedEvent.hex = subjectHex;
    }

    if (!mergedEvent.title && subjectHex) {
        const decodedTitle = decodeHexTitle(subjectHex);
        if (decodedTitle) {
            mergedEvent.title = decodedTitle;
        }
    }

    mergedEvent.image = ensureImageContainer(mergedEvent.image);
    applySanitizedUidToEvent(mergedEvent);

    const scoutsConfig = configOverride ?? (await loadScoutsConfig());

    let previewText = '';
    let previewTagline = null;
    let previewTheme = null;
    if (realm === 'tagline') {
        const result = await generateGeminiTextSuggestion(mergedEvent, 'tagline', scoutsConfig);
        const tagline = typeof result?.tagline === 'string' ? result.tagline.trim() : null;
        const theme = typeof result?.imageTheme === 'string' ? result.imageTheme : null;
        
        if (tagline) {
            setTagline(mergedEvent, tagline);
            previewTagline = tagline;
        }
        if (theme) {
            mergedEvent.image.theme = theme;
        }
        if (theme) {
            previewTheme = theme;
        }
        
        if (tagline && theme) {
            previewText = `*Tagline:* ${tagline}\n*Image Theme:* ${theme}`;
        } else if (tagline) {
            previewText = `*Tagline:* ${tagline}`;
        } else if (theme) {
            previewText = `*Image Theme:* ${theme}`;
        } else {
            previewText = '_Gemini did not return suggestions. Approve to keep the current values or reject for manual edits._';
        }
    } else if (realm === 'imageUrl') {
        const displayUrl = resolveImageUrlForDisplay(mergedEvent.image?.url);
        if (displayUrl) {
            previewText = `*Image downloaded and ready:* ${displayUrl}`;
        } else {
            previewText = '_No image available._';
        }
    }

    const excludeFields = new Set(['title']);
    if (realm === 'tagline') {
        if (previewTagline) {
            excludeFields.add('tagline');
        }
        if (previewTheme) {
            excludeFields.add('imageTheme');
        }
    }

    const actionLabel = `Review ${realm}`;
    const blocks = buildApprovalBlocks(mergedEvent, actionLabel, {
        config: scoutsConfig,
        realm,
        approveAction: 'APPROVE',
        rejectAction: 'REJECT',
        previewText,
        excludeFields: Array.from(excludeFields),
        suppressEmptyFallback: true,
    });

    return {
        text: `Enrichment review for ${mergedEvent.title ?? 'Scouts event'}`,
        blocks,
        approvalContext: {
            realm,
            event: mergedEvent,
            previewText,
        },
    };
}

function buildSimpleMessage(event, actionLabel) {
    const title = event.title ?? event.summary ?? event.name ?? 'Unknown event';
    const detailsText = buildEventDetailsSection(event, actionLabel, null, {
        excludeFields: ['uid', 'originalUid'] // Exclude UIDs from Slack notifications
    });

    return {
        text: `Scouts message received for ${title}`,
        blocks: [
            {
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: `Scouts Update: ${title}`.slice(0, 150),
                    emoji: true,
                },
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: detailsText,
                },
            },
        ],
    };
}

async function sendToScoutsDecisionQueue(payload) {
    try {
        const command = new SendMessageCommand({
            QueueUrl: SCOUTS_DECISION_QUEUE_URL,
            MessageBody: JSON.stringify(payload)
        });
        await sqsClient.send(command);
        console.log('[SQS] Message sent to scoutsDecision queue successfully');
    } catch (error) {
        console.error('[SQS] Failed to send message to scoutsDecision queue:', error.message);
        throw error;
    }
}

async function postSlackMessage(message) {
    const slackBotToken = await getRequiredSecret('SLACK_BOT_TOKEN_PARAMETER');
    if (!SLACK_FEATURE_ENABLED) {
        console.log('[Slack] Slack notifications disabled by feature flag; skipping message');
        console.log('[Slack] Message that would have been sent:', JSON.stringify(message, null, 2));
        return { ok: true, channel: SLACK_CHANNEL, ts: Date.now().toString() };
    }
    
    const slackMessage = {
        channel: SLACK_CHANNEL,
        text: message.text ?? 'Scouts notification',
    };

    if (message.blocks) {
        slackMessage.blocks = message.blocks;
    }

    const headers = {
        Authorization: `Bearer ***`,
        'Content-Type': 'application/json',
    };
    
    console.log('[Slack] Request payload:', JSON.stringify(slackMessage, null, 2));
    
    const actualHeaders = {
        Authorization: `Bearer ${slackBotToken}`,
        'Content-Type': 'application/json',
    };

    try {
        const data = JSON.stringify(slackMessage);
        const options = {
            method: 'POST',
            headers: actualHeaders,
        };

        const response = await new Promise((resolve, reject) => {
            const req = https.request(SLACK_WEBHOOK_URL, options, (res) => {
                let responseData = '';
                res.on('data', (chunk) => (responseData += chunk));
                res.on('end', () => {
                    try {
                        const response = JSON.parse(responseData);
                        if (!response.ok) {
                            console.error('Slack API error:', response);
                            
                            // If it's an image download error, try sending without image blocks
                            if (response.error === 'invalid_blocks' && 
                                response.errors?.some(err => err.includes('downloading image failed'))) {
                                console.log('Retrying message without image blocks due to image download failure');
                                // Remove image blocks and retry
                                const fallbackMessage = {
                                    ...slackMessage,
                                    blocks: slackMessage.blocks?.filter(block => block.type !== 'image') || []
                                };
                                
                                // Add image URL as text instead
                                const imageBlocks = slackMessage.blocks?.filter(block => block.type === 'image') || [];
                                if (imageBlocks.length > 0) {
                                    fallbackMessage.blocks.push({
                                        type: 'section',
                                        text: {
                                            type: 'mrkdwn',
                                            text: `*Image URL:* ${imageBlocks[0].image_url} _(image could not be loaded by Slack)_`
                                        }
                                    });
                                }
                                
                                // Retry the request
                                const retryReq = https.request(SLACK_WEBHOOK_URL, actualHeaders, (retryRes) => {
                                    let retryData = '';
                                    retryRes.on('data', (chunk) => (retryData += chunk));
                                    retryRes.on('end', () => {
                                        try {
                                            const retryResponse = JSON.parse(retryData);
                                            if (!retryResponse.ok) {
                                                reject(new Error(`Slack API error (retry): ${JSON.stringify(retryResponse)}`));
                                            } else {
                                                console.log('Message sent to Slack successfully (retry without image)');
                                                resolve(retryResponse);
                                            }
                                        } catch (parseError) {
                                            reject(new Error(`Failed to parse Slack retry response: ${parseError.message}`));
                                        }
                                    });
                                });
                                retryReq.on('error', reject);
                                retryReq.write(JSON.stringify(fallbackMessage));
                                retryReq.end();
                                return;
                            }
                            
                            reject(new Error(`Slack API error: ${JSON.stringify(response)}`));
                        } else {
                            console.log('Message sent to Slack successfully');
                            resolve(response);
                        }
                    } catch (parseError) {
                        reject(new Error(`Failed to parse Slack response: ${parseError.message}`));
                    }
                });
            });
            req.on('error', (error) => {
                console.error('Error sending message to Slack:', error.message);
                reject(error);
            });
            req.write(data);
            req.end();
        });
        return response;
    } catch (error) {
        console.error('Slack API request failed:', error.message);
        throw new Error(`Slack API request failed: ${error.message}`);
    }
}

async function notifyImageIssue(event, info = {}) {
    const {
        type = 'generic',
        prompt,
        url,
        error,
        reason,
    } = info;

    const hexValue = typeof event?.hex === 'string' && event.hex.trim()
        ? event.hex.trim()
        : 'unknown';
    const eventTitle = event?.title || event?.summary || event?.name || 'Unknown Event';
    const promptValue = typeof prompt === 'string' && prompt.trim()
        ? prompt.trim()
        : getDerivedImageGenerationPromptForEvent(event, cachedScoutsConfig);
    const urlValue = typeof url === 'string' && url.trim()
        ? url.trim()
        : (typeof event?.image?.url === 'string' && event.image.url.trim()
            ? event.image.url.trim()
            : null);
    const reasonText = [error, reason].find((val) => typeof val === 'string' && val.trim())?.trim() || null;

    const formatPrompt = () => (promptValue ? `\`${promptValue}\`` : '_not provided_');
    const formatUrl = () => {
        if (!urlValue) return '_not provided_';
        if (urlValue.startsWith('http://') || urlValue.startsWith('https://')) {
            return `<${urlValue}|${urlValue}>`;
        }
        return urlValue;
    };

    let headerText = 'Image Assistance Required';
    let bodyIntro = '';
    let guidanceText = 'Please adjust the image prompt and clear the image URL (or supply a valid one) before retrying.';

    if (type === 'gemini-image-miss') {
        headerText = 'Gemini Could Not Generate An Image';
        bodyIntro = `Gemini returned no image for prompt ${formatPrompt()}.`;
    } else if (type === 'gemini-image-error') {
        headerText = 'Gemini Image Generation Failed';
        bodyIntro = reasonText
            ? `Gemini request failed: ${reasonText}.`
            : 'Gemini request failed.';
    } else if (type === 'download-failed' || type === 'download-error') {
        headerText = 'Image Download Failed';
        bodyIntro = `Unable to download the image from ${formatUrl()}.`;
        guidanceText = 'Replace the image URL with a reachable link, or clear the URL so a new Gemini image can be generated.';
    }

    const reasonLine = reasonText ? `\n*Details:* ${reasonText}` : '';
    const details = `*Event:* ${eventTitle}\n*HEX:* \`${hexValue}\`\n*Prompt:* ${formatPrompt()}\n*Image URL:* ${formatUrl()}${reasonLine}`;
    const instructionBlock = `${bodyIntro}\n${guidanceText}`;

    const blocks = [
        {
            type: 'header',
            text: {
                type: 'plain_text',
                text: headerText.slice(0, 150),
                emoji: true,
            },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: details,
            },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: instructionBlock,
            },
        },
    ];

    await postSlackMessage({
        text: `${headerText}: ${eventTitle}`,
        blocks,
    });
}

function mapActionId(actionId) {
    const actionMap = {
        'scouts_request_hide': 'HIDE',
        'scouts_request_skip': 'SKIP', 
        'scouts_request_approve': 'PERSIST',
        'scouts_request_edit': 'EDIT'
    };
    return actionMap[actionId] || actionId;
}

function summarizeInvocationEvent(event) {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    if (records.length > 0) {
        return {
            source: 'sqs',
            recordCount: records.length,
            messageIds: records
                .map((record) => (typeof record?.messageId === 'string' ? record.messageId : null))
                .filter(Boolean)
                .slice(0, 10),
            eventSources: Array.from(new Set(
                records
                    .map((record) => (typeof record?.eventSource === 'string' ? record.eventSource : null))
                    .filter(Boolean),
            )),
        };
    }

    return {
        source: isStepFunctionsInvocation(event) ? 'step-functions-direct' : 'direct',
        keys: event && typeof event === 'object' ? Object.keys(event).slice(0, 12) : [],
    };
}

function summarizeMessageBody(messageBody) {
    return {
        realm: typeof messageBody?.realm === 'string' ? messageBody.realm : null,
        action: typeof messageBody?.action === 'string' ? messageBody.action : null,
        requestId: normaliseRuntimeText(messageBody?.requestId ?? null),
        hex: getHexHintFromMessageBody(messageBody),
        title: getTitleHintFromMessageBody(messageBody),
        subject: getSubjectHintFromMessageBody(messageBody),
        orchestrationType: normaliseRuntimeText(messageBody?.orchestrationType ?? null),
        orchestrationStep: normaliseRuntimeText(messageBody?.orchestrationStep ?? null),
    };
}

export async function lambdaHandler(event) {
    console.log('[sqs2scouts] Lambda invoked:', JSON.stringify(summarizeInvocationEvent(event)));
    const directInvocation = isStepFunctionsInvocation(event);
    const records = Array.isArray(event?.Records) ? event.Records : [];
    const observedRequestIds = [];
    const observedHexes = [];
    const observedLinks = [];
    const observedRequests = [];
    let runtimeOutcome = { status: 'needs_attention', failure: { type: 'NO_SUCCESS_OUTCOME', message: 'Processing did not reach a verified terminal outcome' } };
    let activityContext = null;
    try {
        if (directInvocation) {
            const hints = collectRequestHints(null, event);
            observedRequestIds.push(...hints.requestIds);
            observedHexes.push(...hints.hexes);
            observedLinks.push(...hints.links);
            observedRequests.push(...hints.requests);
        } else {
            for (const record of records) {
                if (record?.eventSource !== 'aws:sqs') continue;
                try {
                    const body = typeof record.body === 'string' ? JSON.parse(record.body) : record.body;
                    const hints = collectRequestHints(record, body);
                    observedRequestIds.push(...hints.requestIds);
                    observedHexes.push(...hints.hexes);
                    observedLinks.push(...hints.links);
                    observedRequests.push(...hints.requests);
                } catch {
                    if (record?.messageId) {
                        observedRequestIds.push(String(record.messageId));
                    }
                }
            }
        }
        if (records.length === 0 && !directInvocation) {
            console.error("No records found in event");
            // Send malformed event to DLQ
            try {
                await sendToDLQ(event, new Error('No records found in event'));
            } catch (dlqError) {
                console.error('[DLQ] Failed to send malformed event to DLQ:', dlqError.message);
            }
            throw new Error("No records found in event");
        }

        const sqsMessage = directInvocation ? null : records[0];

        let messageBody;
        try {
            if (directInvocation) {
                messageBody = event;
            } else if (typeof sqsMessage.body === 'string') {
                messageBody = JSON.parse(sqsMessage.body);
            } else {
                messageBody = sqsMessage.body;
            }
        } catch (error) {
            console.error("Failed to parse SQS message body:", sqsMessage.body);
            // Send malformed message to DLQ
            try {
                await sendToDLQ({ body: sqsMessage.body }, error);
            } catch (dlqError) {
                console.error('[DLQ] Failed to send malformed message to DLQ:', dlqError.message);
            }
            throw new Error(`Invalid JSON in SQS message body: ${error.message}`);
        }

        console.log('[sqs2scouts] Parsed message body:', JSON.stringify(summarizeMessageBody(messageBody)));
        const requestContext = buildRequestContext(sqsMessage, messageBody);
        activityContext = { ...messageBody, requestId: requestContext.requestId, hex: requestContext.hex };
        await recordRequestActivity({ ...activityContext, state: 'processing', stage: messageBody.realm || 'processing' })
            .catch((activityError) => console.warn('[Activity] Unable to record worker start:', activityError?.message || activityError));
        const autoApproval = isAutoApprovalMode(messageBody);

        const realm = messageBody.realm || 'unknown';
        let action = messageBody.action || 'Unknown';
        
        // Map action_id to action if it looks like an action_id
        action = mapActionId(action);
        
        const rawSubject = messageBody.subject;
        const subject = ensureObjectSubject(rawSubject);

        console.log(`Processing scouts message - Realm: ${realm}, Action: ${action}`);

        const enrichmentRealms = new Set(['tagline', 'imageTheme', 'image']);
        let scoutsConfig = null;
        if (enrichmentRealms.has(realm)) {
            scoutsConfig = await loadScoutsConfig().catch((error) => {
                console.warn('[Config] Continuing with default scouts configuration after load failure:', error.message);
                return cloneDefaultScoutsConfig();
            });
        }

        // Only accept a small set of realms in this lambda.
        // Supported realms:
        // - 'tagline', 'imageTheme', 'image': enrichment tasks triggered by scouts2sqs
        // - 'persist': finalisation tasks routed internally
        // Anything else is dropped and shunted to the DLQ to avoid noisy retries.
        const allowedRealms = new Set(['tagline', 'imageTheme', 'image', 'persist']);
        if (!allowedRealms.has(realm)) {
            console.error(`[SQS2Scouts] Dropping unsupported realm=${realm} action=${action} subject=${(rawSubject && (rawSubject.title || rawSubject.hex)) || 'unknown'}`);
            // Send unsupported realm to DLQ
            try {
                await sendToDLQ(messageBody, new Error(`Unsupported realm: ${realm}`));
            } catch (dlqError) {
                console.error('[DLQ] Failed to send unsupported realm to DLQ:', dlqError.message);
            }
            return { statusCode: 200, body: JSON.stringify({ message: 'Dropped unsupported realm' }) };
        }

        // Handle tagline realm - generate tagline and image prompt
        if (realm === 'tagline') {
            const hexValue = typeof rawSubject === 'string' ? rawSubject.trim() : null;
            if (!hexValue) {
                throw new Error('tagline request missing hex identifier');
            }
            
            const hexData = await loadHexEventFromS3(hexValue);
            if (!hexData) {
                throw new Error(`HEX ${hexValue} not found`);
            }
            
            const generationId = buildGenerationId(hexValue, 'tagline', hexData, GEMINI_PROMPT_VERSION);
            const result = await generateGeminiTextSuggestion(hexData, 'tagline', scoutsConfig, { hexValue, generationId, requestId: requestContext.requestId });
            if (result?.enrichmentBlocked) {
                await completeImageEnrichTask(messageBody, {
                    status: result.state || 'manual_review',
                    hex: hexValue,
                    requestId: requestContext.requestId,
                    orchestrationStep: 'imageTheme',
                    skipped: result.reason || 'enrichment_unavailable',
                });
                runtimeOutcome = { status: result.state === 'retry_wait' ? 'waiting_for_retry' : 'manual_review', failure: { type: result.failureCategory || 'ENRICHMENT_BLOCKED', message: result.failureMessage || result.reason } };
                return {
                    statusCode: 202,
                    body: JSON.stringify({ message: 'Tagline enrichment is currently deferred' }),
                };
            }
            if (!result?.tagline || !result?.imageTheme) throw Object.assign(new Error('Validated tagline response did not contain required event data'), { name: 'INVALID_EVENT_DATA' });
            setTagline(hexData, result.tagline);
            if (result?.imageTheme && !getImageThemeValue(hexData)) setImageTheme(hexData, result.imageTheme);

            try {
                await saveHexEventToS3(hexValue, hexData);
                const persisted = await loadHexEventFromS3(hexValue);
                if (getTagline(persisted) !== result.tagline || getImageThemeValue(persisted) !== result.imageTheme) throw new Error('Tagline enrichment read-back did not contain the generated fields');
                await publishHexEventToAgenda(hexValue, hexData);
            } catch (error) {
                emitEnrichmentMetric('PersistenceRetry', 'tagline', 'publication_failed');
                throw error;
            }
            if (result) {
                await markEnrichmentSucceeded({ hex: hexValue, stage: 'tagline', generationId });
            }
            await completeImageEnrichTask(messageBody, {
                status: 'succeeded',
                hex: hexValue,
                requestId: requestContext.requestId,
                orchestrationStep: 'tagline',
                imageTheme: getImageThemeValue(hexData),
            });
            runtimeOutcome = { status: 'completed' };

            const requiresApproval = hasCompleteApprovalData(hexData);
            if (!requiresApproval || autoApproval) {
                return {
                    statusCode: 200,
                    body: JSON.stringify({ message: `Tagline enrichment persisted for HEX ${hexValue}` })
                };
            }

            const message = await prepareEnrichmentReview('approval', hexData, scoutsConfig);
            const slackResponse = await postSlackMessage(message);
            await storeApprovalMessageReference(hexData, 'approval', slackResponse);
            
            return {
                statusCode: 200,
                body: JSON.stringify({ message: `Tagline enrichment review generated for HEX ${hexValue}` })
            };
        }
        
        // Handle imageTheme realm - generate only the persisted image theme
        if (realm === 'imageTheme') {
            const hexValue = typeof rawSubject === 'string' ? rawSubject.trim() : null;
            if (!hexValue) {
                throw new Error('imageTheme request missing hex identifier');
            }
            
            const hexData = await loadHexEventFromS3(hexValue);
            if (!hexData) {
                throw new Error(`HEX ${hexValue} not found`);
            }
            
            const generationId = buildGenerationId(hexValue, 'imageTheme', hexData, GEMINI_PROMPT_VERSION);
            const result = await generateGeminiTextSuggestion(hexData, 'imageTheme', scoutsConfig, { hexValue, generationId, requestId: requestContext.requestId });
            if (result?.enrichmentBlocked) {
                await completeImageEnrichTask(messageBody, {
                    status: result.state || 'manual_review',
                    hex: hexValue,
                    requestId: requestContext.requestId,
                    orchestrationStep: 'imageTheme',
                    skipped: result.reason || 'enrichment_unavailable',
                });
                runtimeOutcome = { status: result.state === 'retry_wait' ? 'waiting_for_retry' : 'manual_review', failure: { type: result.failureCategory || 'ENRICHMENT_BLOCKED', message: result.failureMessage || result.reason } };
                return {
                    statusCode: 202,
                    body: JSON.stringify({ message: 'Image theme enrichment is currently deferred' }),
                };
            }
            if (!result?.imageTheme) throw Object.assign(new Error('Validated image theme response did not contain imageTheme'), { name: 'INVALID_EVENT_DATA' });
            if (result?.imageTheme) {
                setImageTheme(hexData, result.imageTheme);
                setImageApprovalState(hexData, false);
            }

            try {
                await saveHexEventToS3(hexValue, hexData);
                const persisted = await loadHexEventFromS3(hexValue);
                if (getImageThemeValue(persisted) !== result.imageTheme) throw new Error('Image theme enrichment read-back did not contain the generated field');
                await publishHexEventToAgenda(hexValue, hexData);
            } catch (error) {
                emitEnrichmentMetric('PersistenceRetry', 'imageTheme', 'publication_failed');
                throw error;
            }
            if (result) {
                await markEnrichmentSucceeded({ hex: hexValue, stage: 'imageTheme', generationId });
            }
            await completeImageEnrichTask(messageBody, {
                status: 'succeeded',
                hex: hexValue,
                requestId: requestContext.requestId,
                orchestrationStep: 'imageTheme',
                imageTheme: getImageThemeValue(hexData),
            });
            runtimeOutcome = { status: 'completed' };

            const requiresApproval = hasCompleteApprovalData(hexData);
            if (!requiresApproval || autoApproval) {
                return {
                    statusCode: 200,
                    body: JSON.stringify({ message: `Image theme persisted for HEX ${hexValue}` })
                };
            }

            const message = await prepareEnrichmentReview('imageTheme', hexData, scoutsConfig);
            const slackResponse = await postSlackMessage(message);
            await storeApprovalMessageReference(hexData, 'approval', slackResponse);
            
            return {
                statusCode: 200,
                body: JSON.stringify({ message: `Image theme review generated for HEX ${hexValue}` })
            };
        }

        // Handle image realm - generate an event image using Gemini, persist it, then request approval
        if (realm === 'image') {
            const hexValue = typeof rawSubject === 'string' ? rawSubject.trim() : null;
            if (!hexValue) {
                throw new Error('image request missing hex identifier');
            }

            const hexData = await loadHexEventFromS3(hexValue);
            if (!hexData) {
                throw new Error(`HEX ${hexValue} not found`);
            }

            const imageTheme = normalizeImagePrompt(getImageThemeValue(hexData));
            if (!imageTheme) {
                throw new Error(`HEX ${hexValue} is missing an image theme`);
            }
            if (!GEMINI_IMAGE_FEATURE_ENABLED) {
                console.warn('[GeminiImage] Feature flag disabled; image enrichment deferred');
                await completeImageEnrichTask(messageBody, {
                    hex: hexValue,
                    requestId: requestContext.requestId,
                    orchestrationStep: 'image',
                    skipped: 'gemini_disabled',
                });
                return {
                    statusCode: 202,
                    body: JSON.stringify({ message: 'Gemini image generation is disabled; image enrichment deferred' }),
                };
            }

            const imagePrompt = buildImageGenerationPromptFromTheme(imageTheme, scoutsConfig);
            if (!imagePrompt) {
                throw new Error(`HEX ${hexValue} image theme did not produce a full prompt`);
            }

            const generationId = buildGenerationId(hexValue, 'image', hexData, GEMINI_PROMPT_VERSION);
            const generatedImage = await generateGeminiImageAsset(imagePrompt, {
                hexValue,
                eventTitle: hexData.title || hexData.summary || hexData.name || 'Scouts event',
                requestId: requestContext.requestId,
                event: hexData,
                generationId,
            });
            if (generatedImage?.enrichmentBlocked) {
                await completeImageEnrichTask(messageBody, {
                    hex: hexValue,
                    requestId: requestContext.requestId,
                    orchestrationStep: 'image',
                    skipped: generatedImage.reason || 'enrichment_unavailable',
                });
                return {
                    statusCode: 202,
                    body: JSON.stringify({ message: 'Image enrichment is currently deferred' }),
                };
            }
            if (!generatedImage?.relativeUrl) {
                throw new Error(`Gemini image generation did not return an image for HEX ${hexValue}`);
            }

            hexData.image = ensureImageContainer(hexData.image);
            hexData.image.theme = imageTheme;
            hexData.image.url = generatedImage.relativeUrl;
            hexData.image.mimeType = generatedImage.mimeType ?? hexData.image.mimeType ?? null;
            if ('prompt' in hexData.image) {
                delete hexData.image.prompt;
            }
            hexData.metadata = hexData.metadata && typeof hexData.metadata === 'object' ? hexData.metadata : {};
            hexData.metadata.image = {
                theme: imageTheme,
                url: generatedImage.relativeUrl,
            };
            setImageApprovalState(hexData, false);

            try {
                await saveHexEventToS3(hexValue, hexData);
                await publishHexEventToAgenda(hexValue, hexData);
            } catch (error) {
                emitEnrichmentMetric('PersistenceRetry', 'image', 'publication_failed');
                throw error;
            }
            await markEnrichmentSucceeded({ hex: hexValue, stage: 'image', generationId }).catch((error) => {
                console.warn('[Enrichment] Failed to mark image success:', error?.message || error);
            });
            await completeImageEnrichTask(messageBody, {
                status: 'succeeded',
                hex: hexValue,
                requestId: requestContext.requestId,
                orchestrationStep: 'image',
                imageTheme,
                imageUrl: generatedImage.relativeUrl,
            });

            if (autoApproval) {
                return {
                    statusCode: 200,
                    body: JSON.stringify({ message: `Image enrichment persisted for HEX ${hexValue}` })
                };
            }

            const message = await prepareEnrichmentReview('approval', hexData, scoutsConfig);
            const slackResponse = await postSlackMessage(message);
            await storeApprovalMessageReference(hexData, 'approval', slackResponse);

            return {
                statusCode: 200,
                body: JSON.stringify({ message: `Image review generated for HEX ${hexValue}` })
            };
        }
        
        // Handle persist realm - merge a persisted patch or accept a legacy full-event subject
        if (realm === 'persist') {
            console.log(`[persist] Processing persist action for subject:`, JSON.stringify(rawSubject));
            
            const subjectObject = ensureObjectSubject(rawSubject);
            const hexValue = (
                typeof rawSubject === 'string' ? rawSubject.trim().toLowerCase() : null
            ) || (
                typeof subjectObject.hex === 'string' ? subjectObject.hex.trim().toLowerCase() : null
            );
            
            if (!hexValue) {
                throw new Error('Persist request missing hex identifier');
            }

            const existingEvent = (await loadHexEventFromS3(hexValue)) || {};
            const event = buildPersistEventPayload(existingEvent, rawSubject, action);
            event.hex = hexValue;
            normalizeHexEventShape(event, hexValue);
            ensureRuntimeMetadata(event, hexValue);
            
            // Decide whether to download an external image into the website bucket.
            // If this persist is the result of a 'hidden' action we skip downloading images.
            const normalizedAction = (typeof action === 'string' ? action : String(action ?? '')).toLowerCase();
            event.metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
            const metadataStatus = getStatusObject(event) ?? {};
            const statusIsHidden = metadataStatus.isHidden === true;
            const actionIsHidden = normalizedAction === 'hidden';
            event.metadata.status = {
                isApproved: metadataStatus.isApproved === true,
                isHidden: (actionIsHidden || statusIsHidden)
                    ? true
                    : metadataStatus.isHidden === true,
            };
            ensureRuntimeMetadata(event, hexValue);

            if (actionIsHidden || statusIsHidden) {
                console.log('[Persist] Detected hidden action/status - skipping image download');
            } else {
                // Download image to website S3 bucket only if URL is not already a relative path.
                // Generated Gemini images already land under website/eventImages/.
                const imageUrl = event.image?.url ?? '';
                const isAlreadyRelative = typeof imageUrl === 'string' && /^\/?website\/(?:images|eventImages)\//.test(imageUrl);
                if (event.image?.url && isAlreadyRelative) {
                    event.metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
                    event.metadata.image = event.metadata.image && typeof event.metadata.image === 'object'
                        ? event.metadata.image
                        : {};
                    event.metadata.image.url = event.image.url;
                }
                if (event.image?.url && !isAlreadyRelative) {
                    const eventTitle = event.title || event.summary || event.name;
                    const originalImageUrl = imageUrl;
                    const downloadResult = await downloadImageToWebsiteS3(
                        originalImageUrl,
                        hexValue,
                        eventTitle,
                        requestContext.requestId
                    );

                    if (downloadResult?.success && downloadResult.relativeUrl) {
                        console.log(`[Persist] Downloaded image and updated URL from ${originalImageUrl} to ${downloadResult.relativeUrl}`);
                        event.image.url = downloadResult.relativeUrl;
                        event.metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
                        event.metadata.image = event.metadata.image && typeof event.metadata.image === 'object'
                            ? event.metadata.image
                            : {};
                        event.metadata.image.url = downloadResult.relativeUrl;
                        const sourceToPersist = downloadResult.sourceUrl ?? originalImageUrl;
                        if (sourceToPersist) {
                            event.sourceImg = sourceToPersist;
                        }
                    } else {
                        const reason = downloadResult?.reason || 'Unknown failure';
                        console.warn(`[Persist] Failed to download image (${reason}), keeping original URL: ${originalImageUrl}`);
                        await notifyImageIssue(event, {
                            type: 'download-failed',
                            url: downloadResult?.sourceUrl ?? originalImageUrl,
                            prompt: event.image?.prompt,
                            error: reason,
                        });
                    }
                }
            }

            if (!actionIsHidden && !statusIsHidden) {
                setImageApprovalState(event, true);
            }

            // Replace the hex file content with the subject content
            await saveHexEventToS3(hexValue, event);
            await publishHexEventToAgenda(hexValue, event);
            
            // Send Slack notification without UIDs
            const eventTitle = event.title || event.summary || event.name || 'Unknown Event';
            let notificationText = `Hex *${hexValue}* persisted for title "${eventTitle}"`;
            let headerText = 'Event Persisted';

            if (actionIsHidden || statusIsHidden) {
                headerText = `Event Hidden for ${eventTitle} (${hexValue})`;
                notificationText = 'The event has been hidden and will not be processed further.';
            }
            
            const blocks = [
                {
                    type: 'header',
                    text: {
                        type: 'plain_text',
                        text: headerText,
                        emoji: true
                    }
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `✅ ${notificationText}`
                    }
                }
            ];
            
            // Add image block if URL exists and event is not hidden
            const shouldIncludeImageBlock = !(actionIsHidden || statusIsHidden);
            if (shouldIncludeImageBlock && event.image?.url) {
                const fullImageUrl = resolveImageUrlForDisplay(event.image.url);
                if (fullImageUrl) {
                    blocks.push({
                        type: 'image',
                        image_url: fullImageUrl,
                        alt_text: `Image for ${eventTitle}`
                    });
                }
            }
            
            const slackMetadata = (messageBody.slackMetadata && typeof messageBody.slackMetadata === 'object')
                ? messageBody.slackMetadata
                : null;
            const responseUrl = slackMetadata?.responseUrl
                ?? slackMetadata?.response_url
                ?? messageBody.responseUrl
                ?? messageBody.response_url
                ?? null;
            const slackText = `✅ ${notificationText}`;
            const slackPayload = { text: slackText, blocks };
            let delivered = false;

            if (responseUrl) {
                try {
                    console.log('[Persist] Sending confirmation via response_url with replace_original');
                    const responsePayload = {
                        replace_original: true,
                        ...slackPayload,
                    };
                    await postToResponseUrl(responseUrl, responsePayload);
                    delivered = true;
                } catch (err) {
                    console.warn('[Persist] response_url delivery failed, sending new Slack message instead:', err.message);
                }
            }

            if (!delivered) {
                await postSlackMessage(slackPayload);
            }
            
            console.log(`[Persist] Successfully persisted HEX file for ${eventTitle}`);
            const decisionAction = actionIsHidden || statusIsHidden ? 'hidden' : 'persisted';
            const decisionSubject = {
                hex: hexValue,
                title: eventTitle,
            };
            if (event.uid) {
                decisionSubject.uid = event.uid;
            }

            try {
                const decisionPayload = {
                    realm: 'sqs2scouts',
                    action: decisionAction,
                    subject: decisionSubject,
                    source: 'sqs2scouts',
                    requestId: requestContext.requestId,
                    requestHex: requestContext.hex ?? hexValue,
                };
                console.log('[Persist] Sending notification to scoutsDecision queue:', JSON.stringify(decisionPayload));
                await sendToScoutsDecisionQueue(decisionPayload);
            } catch (queueErr) {
                console.warn('[Persist] Failed to notify scoutsDecision queue:', queueErr?.message || queueErr);
            }

            return {
                statusCode: 200,
                body: JSON.stringify({ message: `Hex file persisted for ${eventTitle}` })
            };
        }

        console.warn(`[SQS2Scouts] No handler matched realm=${realm} action=${action}`);
        return {
            statusCode: 200,
            body: JSON.stringify({ message: "No handler executed" })
        };

    } catch (error) {
        runtimeOutcome = {
            status: 'needs_attention',
            failure: {
                type: error?.name || 'PROCESSING_FAILED',
                message: error?.message || String(error),
            },
        };
        console.error("Exception occurred:", error.message);
        try {
            const callbackBody = event.Records?.[0]?.body ? JSON.parse(event.Records[0].body) : event;
            await failImageEnrichTask(callbackBody, error);
        } catch (callbackError) {
            console.warn('[Step Functions] Failed to report task failure:', callbackError?.message || callbackError);
        }
        // Send processing error to DLQ
        try {
            const messageBody = event.Records?.[0]?.body ? JSON.parse(event.Records[0].body) : event;
            await sendToDLQ(messageBody, error);
        } catch (dlqError) {
            console.error('[DLQ] Failed to send processing error to DLQ:', dlqError.message);
        }
        if (directInvocation) {
            throw error;
        }
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    } finally {
        if (activityContext?.requestId) {
            const isWorkflowStage = activityContext.invocationType === 'stepFunctions' && activityContext.realm !== 'image';
            const succeeded = runtimeOutcome.status === 'completed';
            const state = succeeded ? (isWorkflowStage ? 'published' : 'completed') : runtimeOutcome.status;
            await recordRequestActivity({
                ...activityContext,
                state,
                stage: succeeded ? (isWorkflowStage ? 'published' : 'agenda_published') : state,
                publication: succeeded ? 'published' : null,
                failure: runtimeOutcome.failure || null,
            }).catch((activityError) => console.warn('[Activity] Unable to record worker outcome:', activityError?.message || activityError));
        }
    }
}

export { buildRuntimeRequestEntry };
