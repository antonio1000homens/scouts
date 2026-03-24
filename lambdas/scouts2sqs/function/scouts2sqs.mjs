import { SQSClient, SendMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import https from 'https';
import crypto from 'crypto';

// Load configuration from environment variables
const { REQUIRED_API_KEY, TARGET_BUCKET } = process.env;
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL || "https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessing";
const DLQ_URL = process.env.DLQ_URL || "https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessingDLQ";
const DEFAULT_BUCKET = 'scouts-2ndtolworth-prod-553490163883';
const SCOUTS_REQUESTS_QUEUE_URL_FALLBACK =
    process.env.SCOUTS_REQUESTS_QUEUE_URL
    || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests';
const QUEUED_REQUESTS_RUNTIME_KEY = 'runtime/scoutsQueued.json';
const PROCESSING_REQUESTS_RUNTIME_KEY = 'runtime/scoutsProcessing.json';
const FULL_ENRICH_STATE_MACHINE_ARN = process.env.FULL_ENRICH_STATE_MACHINE_ARN || '';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'eu-west-2' });
const sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'eu-west-2' });
const sfnClient = new SFNClient({ region: process.env.AWS_REGION || 'eu-west-2' });

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'OPTIONS,POST',
    'Access-Control-Allow-Headers': 'content-type,x-api-key,x-requested-with',
};

const withCors = (response = {}) => ({
    statusCode: response.statusCode ?? 200,
    headers: { ...CORS_HEADERS, ...(response.headers || {}) },
    body: response.body ?? '',
});

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

function resolveScoutsRequestsQueueUrl(records = []) {
    for (const record of records) {
        const arn = record?.eventSourceARN || record?.eventSourceArn || null;
        const fromArn = parseQueueUrlFromArn(arn, null);
        if (fromArn) return fromArn;
    }
    return SCOUTS_REQUESTS_QUEUE_URL_FALLBACK;
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

function inferRequestedFieldFromSubject(subject) {
    if (!subject || typeof subject !== 'object') {
        return null;
    }

    if (
        Object.prototype.hasOwnProperty.call(subject, 'tagline')
        || Object.prototype.hasOwnProperty.call(subject.metadata ?? {}, 'tagline')
    ) {
        return 'tagline';
    }

    const metadataImage = subject.metadata?.image && typeof subject.metadata.image === 'object'
        ? subject.metadata.image
        : {};
    const image = subject.image && typeof subject.image === 'object'
        ? subject.image
        : {};

    if (
        Object.prototype.hasOwnProperty.call(subject, 'imageTheme')
        || Object.prototype.hasOwnProperty.call(metadataImage, 'theme')
        || Object.prototype.hasOwnProperty.call(image, 'theme')
    ) {
        return 'imageTheme';
    }

    if (
        Object.prototype.hasOwnProperty.call(subject, 'imageUrl')
        || Object.prototype.hasOwnProperty.call(metadataImage, 'url')
        || Object.prototype.hasOwnProperty.call(image, 'url')
    ) {
        return 'imageUrl';
    }

    return null;
}

function normalizeRuntimeRequestDescriptor(messageBody) {
    const rawRealm = typeof messageBody?.realm === 'string' && messageBody.realm.trim()
        ? messageBody.realm.trim()
        : null;
    const action = normaliseActionHint(messageBody?.action);
    const explicitSubject = getSubjectHintFromMessageBody(messageBody);
    const inferredSubject = explicitSubject
        ?? inferRequestedFieldFromSubject(messageBody?.subject)
        ?? (rawRealm === 'persist' ? 'persist' : null);
    const internalRealmToSubject = {
        tagline: 'tagline',
        imageTheme: 'imageTheme',
        image: 'imageUrl',
        imageUrl: 'imageUrl',
        persist: inferredSubject,
    };
    const logicalSubject = inferredSubject ?? internalRealmToSubject[rawRealm] ?? null;
    const usesLogicalRequestContract = rawRealm === 'scoutsRequest'
        || Object.prototype.hasOwnProperty.call(internalRealmToSubject, rawRealm ?? '');

    return {
        realm: usesLogicalRequestContract && logicalSubject ? 'scoutsRequest' : rawRealm,
        subject: logicalSubject,
        action,
    };
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

function buildRuntimeRequestEntry(record, messageBody, status) {
    const requestId =
        (messageBody && typeof messageBody === 'object'
            ? (messageBody.requestId ?? null)
            : null)
        ?? record?.messageId
        ?? null;
    const messageId =
        (messageBody && typeof messageBody === 'object' ? messageBody.messageId ?? null : null)
        ?? record?.messageId
        ?? null;

    const descriptor = normalizeRuntimeRequestDescriptor(messageBody);

    return {
        requestTime: getRequestTimeHint(record, messageBody),
        requestId: requestId ? String(requestId) : null,
        messageId: messageId ? String(messageId) : null,
        hex: getHexHintFromMessageBody(messageBody),
        title: getTitleHintFromMessageBody(messageBody),
        subject: descriptor.subject,
        realm: descriptor.realm,
        action: descriptor.action,
        taskToken: normaliseRuntimeText(messageBody?.taskToken ?? null),
        orchestrationType: normaliseRuntimeText(messageBody?.orchestrationType ?? null),
        orchestrationStep: normaliseRuntimeText(messageBody?.orchestrationStep ?? null),
        status,
    };
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

function getRuntimeSnapshotRequests(snapshot) {
    return Array.isArray(snapshot?.requests) ? snapshot.requests : [];
}

function getRuntimeRequestId(entry) {
    if (typeof entry?.requestId === 'string' && entry.requestId.trim()) return entry.requestId.trim();
    if (typeof entry?.messageId === 'string' && entry.messageId.trim()) return entry.messageId.trim();
    return '';
}

function getRuntimeRequestHex(entry) {
    if (typeof entry?.hex === 'string' && entry.hex.trim()) return entry.hex.trim().toLowerCase();
    return '';
}

function getRuntimeRequestKey(entry) {
    const requestId = getRuntimeRequestId(entry);
    if (requestId) return requestId;
    const hex = getRuntimeRequestHex(entry);
    const title = typeof entry?.title === 'string' && entry.title.trim() ? entry.title.trim() : '';
    return [hex, title].filter(Boolean).join('|');
}

async function readRuntimeSnapshot(key) {
    const bucket = TARGET_BUCKET || DEFAULT_BUCKET;
    try {
        const command = new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        });
        const response = await s3Client.send(command);
        const bodyString = await response.Body.transformToString();
        return JSON.parse(bodyString);
    } catch (error) {
        const notFound =
            error?.name === 'NoSuchKey'
            || error?.name === 'NotFound'
            || error?.$metadata?.httpStatusCode === 404;
        if (notFound) {
            return null;
        }
        throw error;
    }
}

function filterProcessingRequestsAgainstQueuedSnapshot(requests = [], queuedSnapshot = null) {
    const queuedKeys = new Set(
        getRuntimeSnapshotRequests(queuedSnapshot)
            .map((entry) => getRuntimeRequestKey(entry))
            .filter(Boolean)
    );

    if (queuedKeys.size === 0) {
        return {
            requests: [],
            removedCount: Array.isArray(requests) ? requests.length : 0,
        };
    }

    const retained = [];
    let removedCount = 0;
    for (const entry of Array.isArray(requests) ? requests : []) {
        const key = getRuntimeRequestKey(entry);
        if (key && queuedKeys.has(key)) {
            retained.push(entry);
            continue;
        }
        removedCount += 1;
    }

    return {
        requests: deduplicateRuntimeRequestEntries(retained),
        removedCount,
    };
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

    let hexHint = null;
    if (messageBody && typeof messageBody === 'object') {
        hexHint = getHexHintFromSubject(messageBody.subject);
        if (hexHint) {
            hexes.add(hexHint);
        }
    }

    if (normalizedRequestId && hexHint) {
        links.push({
            requestId: normalizedRequestId,
            hex: hexHint,
            sourceMessageId: record?.messageId ? String(record.messageId) : null,
            realm: messageBody?.realm ?? null,
            action: messageBody?.action ?? null,
        });
    }

    const requests = [buildRuntimeRequestEntry(record, messageBody, 'processing')]
        .filter((entry) => entry.requestId || entry.messageId || entry.hex || entry.title || entry.subject);

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

function withRequestContext(payload, context) {
    const next = { ...(payload || {}) };
    if (context?.requestId) {
        next.requestId = context.requestId;
    }
    if (context?.hex) {
        next.requestHex = context.hex;
    }
    return next;
}

function getOptionalOrchestrationMetadata(payload) {
    if (!payload || typeof payload !== 'object') {
        return {};
    }

    const metadata = {};
    const textFields = [
        'requestId',
        'requestHex',
        'taskToken',
        'orchestrationType',
        'orchestrationStep',
        'source',
        'approvalMode',
        'requestMode',
    ];

    for (const field of textFields) {
        const value = normaliseRuntimeText(payload[field]);
        if (value) {
            metadata[field] = value;
        }
    }

    return metadata;
}

function isFullEnrichRequest(payload) {
    const realm = typeof payload?.realm === 'string' ? payload.realm.trim() : '';
    const action = typeof payload?.action === 'string' ? payload.action.trim() : '';
    return realm === 'scoutsRequest' && action === 'fullEnrich';
}

function normalizeFlowMode(value, fallback) {
    if (typeof value !== 'string') return fallback;
    const normalized = value.trim().toLowerCase();
    return normalized || fallback;
}

function buildExecutionName(requestId, hex) {
    const requestToken = String(requestId ?? crypto.randomUUID())
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'request';
    const hexToken = String(hex ?? 'hex')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 40) || 'hex';
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `${hexToken}-${requestToken}-${timestamp}`.slice(0, 80);
}

function buildFullEnrichExecutionInput(payload, context = {}) {
    const subject = ensureObjectSubject(parseJsonSubject(payload?.subject) ?? payload?.subject);
    applySanitizedUidToSubject(subject);
    ensureRuntimeMetadata(subject);

    const hex = getHexHintFromMessageBody({
        ...payload,
        subject,
    });
    if (!hex) {
        throw new Error('fullEnrich request missing hex identifier');
    }

    return {
        requestId: context?.requestId ?? String(payload?.requestId ?? crypto.randomUUID()),
        hex,
        requestHex: context?.hex ?? hex,
        source: typeof payload?.source === 'string' && payload.source.trim() ? payload.source.trim() : 'scouts2sqs',
        orchestrationType: 'fullEnrich',
        requestMode: normalizeFlowMode(payload?.requestMode, 'auto'),
        approvalMode: normalizeFlowMode(payload?.approvalMode, 'auto'),
        subject,
    };
}

async function startFullEnrichExecution(payload, context = {}) {
    if (!FULL_ENRICH_STATE_MACHINE_ARN) {
        throw new Error('FULL_ENRICH_STATE_MACHINE_ARN is not configured');
    }

    const input = buildFullEnrichExecutionInput(payload, context);
    const command = new StartExecutionCommand({
        stateMachineArn: FULL_ENRICH_STATE_MACHINE_ARN,
        name: buildExecutionName(input.requestId, input.hex),
        input: JSON.stringify(input),
    });
    const response = await sfnClient.send(command);
    console.log('[StepFunctions] Started fullEnrich execution', {
        stateMachineArn: FULL_ENRICH_STATE_MACHINE_ARN,
        executionArn: response?.executionArn ?? null,
        hex: input.hex,
        requestId: input.requestId,
    });
    return {
        executionArn: response?.executionArn ?? null,
        startDate: response?.startDate ?? null,
        input,
    };
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
        console.warn('[Runtime] Failed to read scoutsRequests queue depth:', error?.message || error);
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
    const bucket = TARGET_BUCKET || DEFAULT_BUCKET;
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(payload, null, 2),
        ContentType: 'application/json',
        CacheControl: 'no-store',
    });
    await s3Client.send(command);
}

async function persistQueuedRequestsRuntimeSnapshot(records, requestIds, hexes, links, requests = []) {
    const queuedSnapshot = await readRuntimeSnapshot(QUEUED_REQUESTS_RUNTIME_KEY);
    const reconciled = filterProcessingRequestsAgainstQueuedSnapshot(
        deduplicateRuntimeRequestEntries(requests),
        queuedSnapshot,
    );
    const payload = {
        source: 'scouts2sqs',
        queue: 'scoutsRequests',
        updatedAt: new Date().toISOString(),
        requests: reconciled.requests,
        requestIds: Array.from(
            new Set(reconciled.requests.map((entry) => entry?.requestId).filter(Boolean))
        ).slice(0, 50),
        hexes: Array.from(
            new Set(reconciled.requests.map((entry) => entry?.hex).filter(Boolean))
        ).slice(0, 50),
    };

    try {
        await writeRuntimeSnapshot(PROCESSING_REQUESTS_RUNTIME_KEY, payload);
        console.log(`[Runtime] Wrote queue snapshot to ${PROCESSING_REQUESTS_RUNTIME_KEY}`);
    } catch (error) {
        console.warn('[Runtime] Failed writing scoutsProcessing snapshot:', error?.message || error);
    }
}

// Utility function to send HTTP requests
async function sendHttpRequest(url, options, data) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => (responseData += chunk));
            res.on('end', () => resolve(JSON.parse(responseData)));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

// Send a message to Slack
function normaliseSubjectForSlack(subject) {
    if (!subject) {
        return 'unknown subject';
    }

    if (typeof subject === 'string') {
        return subject;
    }

    if (typeof subject === 'object') {
        const title = subject.title ?? subject.hex ?? null;
        const location = subject.location ?? null;
        const parts = [title, location].filter(Boolean);
        if (parts.length > 0) {
            return parts.join(' | ');
        }

        try {
            return JSON.stringify(subject);
        } catch (_) {
            return String(subject);
        }
    }

    return String(subject);
}

function isResetNotification(realm, subject) {
    // Reset/agenda notifications are no longer supported by this lambda
    return false;
}

function formatResetActionForSlack(action) {
    if (Array.isArray(action)) {
        return action.join('\n');
    }
    if (typeof action === 'string') {
        const trimmed = action.trim();
        return trimmed || 'No events removed';
    }
    if (action === null || action === undefined) {
        return 'No events removed';
    }
    if (typeof action === 'object') {
        try {
            return JSON.stringify(action, null, 2);
        } catch (err) {
            return String(action);
        }
    }
    const stringified = String(action);
    return stringified.trim() || 'No events removed';
}

function sanitizeEventUid(uid) {
    if (uid === undefined || uid === null) return null;
    let candidate = String(uid).trim();
    if (!candidate) return null;
    candidate = candidate.split(/[\\\/]/)[0] || candidate;
    candidate = candidate.replace(/\s+/g, '-');
    candidate = candidate.replace(/[^a-zA-Z0-9._-]/g, '-');
    candidate = candidate.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    const digitPrefixMatch = candidate.match(/^(.*?\d+)/);
    if (digitPrefixMatch) {
        candidate = digitPrefixMatch[1];
    }
    return candidate || null;
}

function applySanitizedUidToSubject(subject) {
    if (!subject || typeof subject !== 'object') return;
    const rawUid = subject.uid ?? subject.originalUid ?? null;
    const sanitized = sanitizeEventUid(rawUid);
    if (!sanitized) return;
    if (rawUid && rawUid !== sanitized) {
        subject.originalUid = rawUid;
    }
    subject.uid = sanitized;
}

function ensureObjectSubject(subject) {
    if (subject && typeof subject === 'object') {
        ensureRuntimeMetadata(subject);
        return subject;
    }

    if (typeof subject === 'string') {
        const trimmed = subject.trim();
        if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
            return { hex: trimmed };
        }
        return { value: trimmed };
    }

    return { value: subject };
}

function ensureImageContainer(image = {}) {
    if (!image || typeof image !== 'object') {
        return { theme: null, prompt: null, url: null };
    }
    return {
        theme: typeof image.theme === 'string' ? image.theme : null,
        prompt: typeof image.prompt === 'string' ? image.prompt : null,
        url: typeof image.url === 'string' ? image.url : null,
    };
}

function getMetadataObject(event) {
    if (!event || typeof event !== 'object') return null;
    return event.metadata && typeof event.metadata === 'object' ? event.metadata : null;
}

function normalizeNullableText(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text ? text : null;
}

function normalizeOptionalBoolean(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    }
    return null;
}

function getTagline(event) {
    const metadata = getMetadataObject(event);
    return normalizeNullableText(metadata?.tagline);
}

function getImageThemeValue(event) {
    const metadataImage = getMetadataObject(event)?.image;
    if (!metadataImage || typeof metadataImage !== 'object') return null;
    return normalizeNullableText(metadataImage.theme ?? metadataImage.prompt);
}

function getImageUrlValue(event) {
    const metadataImage = getMetadataObject(event)?.image;
    if (!metadataImage || typeof metadataImage !== 'object') return null;
    return normalizeNullableText(metadataImage.url);
}

function ensureRuntimeMetadata(event, fallbackHex = null) {
    if (!event || typeof event !== 'object') return event;

    const metadata = getMetadataObject(event) || {};
    if (!event.metadata || typeof event.metadata !== 'object') {
        event.metadata = metadata;
    }

    const hexValue = normalizeNullableText(
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
    const tagline = normalizeNullableText(metadata.tagline);
    metadata.tagline = tagline;
    event.tagline = tagline;

    const metadataImage = metadata.image && typeof metadata.image === 'object' ? metadata.image : {};
    const imageTheme = normalizeNullableText(
        metadataImage.theme
    );
    const imageUrl = normalizeNullableText(metadataImage.url);
    metadata.image = {
        theme: imageTheme,
        url: imageUrl,
    };
    event.image = ensureImageContainer({
        theme: imageTheme,
        url: imageUrl,
    });

    const metadataStatus = metadata.status && typeof metadata.status === 'object' ? metadata.status : {};
    metadata.status = {
        isApproved: normalizeOptionalBoolean(metadataStatus.isApproved) ?? false,
        isHidden: normalizeOptionalBoolean(metadataStatus.isHidden) ?? false,
    };

    event.metadata = metadata;
    return event;
}

function applySanitizedUidToEvent(event) {
    if (!event || typeof event !== 'object') {
        return null;
    }
    const rawUid = event.uid ?? event.originalUid ?? event.hex ?? null;
    const sanitized = sanitizeEventUid(rawUid);
    if (!sanitized) {
        return null;
    }
    if (rawUid && rawUid !== sanitized) {
        event.originalUid = rawUid;
    }
    event.uid = sanitized;
    return sanitized;
}

function decodeHexValue(hexValue) {
    if (typeof hexValue !== 'string') return null;
    const trimmed = hexValue.trim();
    if (!trimmed || trimmed.length % 2 !== 0) return null;
    if (!/^[0-9a-f]+$/i.test(trimmed)) return null;
    try {
        const decoded = Buffer.from(trimmed, 'hex').toString('utf8');
        return decoded.trim() || decoded;
    } catch (error) {
        console.warn(`[HEX] Failed to decode HEX value ${trimmed}:`, error.message);
        return null;
    }
}

function parseJsonSubject(subject) {
    if (typeof subject === 'string') {
        const trimmed = subject.trim();
        if (!trimmed) return null;
        try {
            const parsed = JSON.parse(trimmed);
            ensureRuntimeMetadata(parsed);
            return parsed;
        } catch (error) {
            console.warn('[Payload] Failed to parse subject JSON string:', error.message);
            return null;
        }
    }
    if (typeof subject === 'object' && subject !== null) {
        ensureRuntimeMetadata(subject);
        return subject;
    }
    return null;
}

async function getHexFileFromS3(hexValue) {
    const bucket = TARGET_BUCKET || DEFAULT_BUCKET;
    const candidateKeys = [`events/${hexValue}.json`];
    const legacyKey = `events/{{${hexValue}}}.json`;
    candidateKeys.push(legacyKey);

    for (const key of candidateKeys) {
        try {
            const command = new GetObjectCommand({
                Bucket: bucket,
                Key: key,
            });
            const response = await s3Client.send(command);
            const bodyString = await response.Body.transformToString();
            const data = JSON.parse(bodyString);
            ensureRuntimeMetadata(data, hexValue);
            console.log(`[HEX] Retrieved HEX file from s3://${bucket}/${key}`);
            return data;
        } catch (error) {
            if (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey') {
                console.log(`[HEX] No HEX file found at s3://${bucket}/${key}`);
                continue;
            }
            console.error(`[HEX] Error reading s3://${bucket}/${key}:`, error.message);
            throw error;
        }
    }

    return null;
}

function buildPersistPatchForProcessing(rawSubject) {
    const compactSubject = parseJsonSubject(rawSubject);
    if (!compactSubject || typeof compactSubject !== 'object') {
        throw new Error('Persist request subject must be an object');
    }

    const hexValue = normalizeNullableText(compactSubject.metadata?.hex ?? compactSubject.hex)?.toLowerCase();
    if (!hexValue) {
        throw new Error('Persist request missing hex identifier');
    }

    const patch = {};
    ensureRuntimeMetadata(compactSubject, hexValue);

    if (Object.prototype.hasOwnProperty.call(compactSubject.metadata ?? {}, 'tagline')) {
        patch.metadata = patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : {};
        patch.metadata.tagline = normalizeNullableText(compactSubject.metadata?.tagline);
    }

    if (Object.prototype.hasOwnProperty.call(compactSubject.metadata ?? {}, 'image')) {
        patch.metadata = patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : {};
        patch.metadata.image = patch.metadata.image && typeof patch.metadata.image === 'object'
            ? patch.metadata.image
            : {};
        patch.metadata.image.theme = normalizeNullableText(
            compactSubject.metadata?.image?.theme
        );
    }
    if (Object.prototype.hasOwnProperty.call(compactSubject.metadata ?? {}, 'image')) {
        patch.metadata = patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : {};
        patch.metadata.image = patch.metadata.image && typeof patch.metadata.image === 'object'
            ? patch.metadata.image
            : {};
        patch.metadata.image.url = normalizeNullableText(
            compactSubject.metadata?.image?.url
        );
    }

    const isHidden = normalizeOptionalBoolean(compactSubject.metadata?.status?.isHidden);
    if (isHidden !== null) {
        patch.metadata = patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : {};
        patch.metadata.status = patch.metadata.status && typeof patch.metadata.status === 'object'
            ? patch.metadata.status
            : {};
        patch.metadata.status.isHidden = isHidden;
    }

    const isApproved = normalizeOptionalBoolean(compactSubject.metadata?.status?.isApproved);
    if (isApproved !== null) {
        patch.metadata = patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : {};
        patch.metadata.status = patch.metadata.status && typeof patch.metadata.status === 'object'
            ? patch.metadata.status
            : {};
        patch.metadata.status.isApproved = isApproved;
    }

    if (Object.keys(patch).length === 0) {
        throw new Error('Persist request did not include any patchable fields');
    }

    return {
        hexValue,
        action: patch,
        subject: hexValue,
    };
}

async function processScoutsRequest(hexValue, action) {
    console.log(`[scoutsRequest] Processing ${action} for HEX ${hexValue}`);
    
    try {
        const hexData = await getHexFileFromS3(hexValue);
        if (!hexData) {
            console.warn(`[scoutsRequest] HEX ${hexValue} not found`);
            return { status: 'missing', hex: hexValue };
        }
        ensureRuntimeMetadata(hexData, hexValue);
        
        // Determine what field needs populating
        let realm = null;
        let subject = hexValue;
        let sqsAction = null;
        
        if (!getTagline(hexData)) {
            realm = 'tagline';
            subject = hexValue;
            sqsAction = hexData.title;
        } else if (!getImageThemeValue(hexData)) {
            realm = 'imageTheme';
            subject = hexValue;
            sqsAction = hexData.title;
        }
        
        if (realm) {
            const payload = {
                realm,
                subject,
                action: sqsAction,
            };
            
            await sendToSQS(payload);
            console.log(`[scoutsRequest] Sent ${realm} request for HEX ${hexValue}`);
            return { status: 'sent', hex: hexValue, realm };
        } else {
            console.log(`[scoutsRequest] HEX ${hexValue} is already fully populated`);
            return { status: 'complete', hex: hexValue };
        }
    } catch (error) {
        console.error(`[scoutsRequest] Error processing HEX ${hexValue}:`, error.message);
        return { status: 'error', hex: hexValue, error: error.message };
    }
}

function extractHexFromSubject(subject) {
    if (typeof subject === 'string') {
        const trimmed = subject.trim();
        return trimmed || null;
    }

    if (subject && typeof subject === 'object') {
        if (typeof subject.hex === 'string') {
            const trimmedHex = subject.hex.trim();
            if (trimmedHex) {
                return trimmedHex;
            }
        }

        if (typeof subject.value === 'string') {
            const trimmedValue = subject.value.trim();
            if (trimmedValue) {
                return trimmedValue;
            }
        }
    }

    return null;
}

function buildQueuePayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }
    const realm = typeof payload.realm === 'string' ? payload.realm.trim() : payload.realm;
    const action = typeof payload.action === 'string' ? payload.action.trim() : payload.action;
    const subject = payload.subject;

    if (realm === 'scoutsRequest') {
        const requestedField = normaliseRuntimeText(payload.subjectLabel ?? subject);
        const hex = getHexHintFromMessageBody(payload);
        const title = getTitleHintFromMessageBody(payload);

        if (requestedField !== 'tagline' && requestedField !== 'imageTheme' && requestedField !== 'imageUrl' && requestedField !== 'persist') {
            throw new Error(`scoutsRequest subject ${requestedField} not supported by this lambda`);
        }
        if (!hex) {
            throw new Error(`Unable to derive HEX subject for realm=${realm} action=${action}`);
        }

        if (action === 'request') {
            if (requestedField === 'persist') {
                throw new Error(`Action ${action} not supported for realm=${realm} subject=${requestedField}`);
            }
            return {
                realm: requestedField === 'tagline' ? 'tagline' : requestedField === 'imageTheme' ? 'imageTheme' : 'image',
                action: 'request',
                subject: hex,
                subjectLabel: requestedField,
                hex,
                ...(title ? { title } : {}),
                ...getOptionalOrchestrationMetadata(payload),
            };
        }

        if (action === 'persist') {
            if (requestedField === 'persist') {
                return {
                    realm: 'persist',
                    action: 'persist',
                    subject: {
                        hex,
                        ...(title ? { title } : {}),
                    },
                    subjectLabel: requestedField,
                    hex,
                    ...(title ? { title } : {}),
                    ...getOptionalOrchestrationMetadata(payload),
                };
            }
            const fieldValue = requestedField === 'tagline'
                ? normaliseRuntimeText(payload.tagline ?? payload.value ?? payload?.subject?.tagline ?? null)
                : requestedField === 'imageTheme'
                    ? normaliseRuntimeText(payload.imageTheme ?? payload.value ?? payload?.subject?.imageTheme ?? null)
                    : normaliseRuntimeText(payload.imageUrl ?? payload.value ?? payload?.subject?.imageUrl ?? null);
            if (!fieldValue) {
                throw new Error(`${requestedField} persist request missing ${requestedField} value`);
            }
            return {
                realm: 'persist',
                action: 'persist',
                subject: {
                    hex,
                    ...(requestedField === 'tagline' ? { tagline: fieldValue } : {}),
                    ...(requestedField === 'imageTheme' ? { imageTheme: fieldValue } : {}),
                    ...(requestedField === 'imageUrl' ? { imageUrl: fieldValue } : {}),
                    ...(title ? { title } : {}),
                },
                subjectLabel: requestedField,
                hex,
                ...(title ? { title } : {}),
                ...getOptionalOrchestrationMetadata(payload),
            };
        }

        throw new Error(`Action ${action} not supported for realm=${realm} subject=${requestedField}`);
    }

    // Only allow a small set of realms through (include 'persist' so this lambda
    // can publish persist messages created during approval flows)
    const allowedRealms = new Set(['tagline', 'imageTheme', 'image', 'persist']);
    if (!allowedRealms.has(realm)) {
        throw new Error(`Realm ${realm} not supported by this lambda`);
    }

    const requiresHexOnly =
        typeof realm === 'string'
        && realm === 'tagline'
        && action === 'request';

    if (requiresHexOnly) {
        const hexSubject = extractHexFromSubject(subject);
        if (!hexSubject) {
            throw new Error(`Unable to derive HEX subject for realm=${realm} action=${action}`);
        }
        return {
            realm,
            action,
            subject: hexSubject,
        };
    }

    return {
        ...payload,
        ...getOptionalOrchestrationMetadata(payload),
    };
}

function isSqsPublishEnabled() {
    const rawValue = process.env.SCOUTS2SQS_PUBLISH_ENABLED;
    if (rawValue === undefined || rawValue === null) {
        return true;
    }

    const normalized = String(rawValue).trim().toLowerCase();
    if (!normalized) {
        return true;
    }

    return !['false', '0', 'no', 'off', 'disabled'].includes(normalized);
}

// Send a message to SQS with DLQ fallback
async function sendToSQS(payload, retryCount = 0) {
    const normalisedPayload = buildQueuePayload(payload);
    console.log("[SQS] Payload to be sent:", JSON.stringify(normalisedPayload, null, 2));
    
    const enabled = isSqsPublishEnabled();
    if (!enabled) {
        console.log('[SQS] Publish disabled by SCOUTS2SQS_PUBLISH_ENABLED; skipping SQS publish');
        return;
    }

    try {
        const command = new SendMessageCommand({
            QueueUrl: SQS_QUEUE_URL,
            MessageBody: JSON.stringify(normalisedPayload)
        });
        await sqsClient.send(command);
        console.log("[SQS] Message published successfully");
    } catch (error) {
        console.error(`[SQS] Error publishing message (attempt ${retryCount + 1}):`, error.message);
        
        if (retryCount < 2) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return sendToSQS(payload, retryCount + 1);
        }
        
        // Send to DLQ as last resort
        try {
            const dlqCommand = new SendMessageCommand({
                QueueUrl: DLQ_URL,
                MessageBody: JSON.stringify({ ...normalisedPayload, error: error.message, timestamp: new Date().toISOString() }),
            });
            await sqsClient.send(dlqCommand);
            console.log('[DLQ] Message sent to DLQ after SQS failure');
        } catch (dlqError) {
            console.error('[DLQ] Failed to send to DLQ:', dlqError.message);
        }
        
        throw error;
    }
}

// Lambda handler
export async function lambdaHandler(event) {
    console.log("Lambda function invoked with event:", JSON.stringify(event));

    // Handle CORS preflight early
    if (event?.requestContext?.http?.method === 'OPTIONS' || event?.httpMethod === 'OPTIONS') {
        return withCors({ statusCode: 200, body: '' });
    }
    
    // Handle SQS events from scoutsRequests queue
    if (event.Records && Array.isArray(event.Records)) {
        const observedRequestIds = [];
        const observedHexes = [];
        const observedLinks = [];
        const observedRequests = [];
        for (const record of event.Records) {
            if (record.eventSource === 'aws:sqs') {
                try {
                    const messageBody = JSON.parse(record.body);
                    console.log('Processing SQS message:', JSON.stringify(messageBody));
                    const hints = collectRequestHints(record, messageBody);
                    observedRequestIds.push(...hints.requestIds);
                    observedHexes.push(...hints.hexes);
                    observedLinks.push(...hints.links);
                    observedRequests.push(...hints.requests);
                    const requestContext = buildRequestContext(record, messageBody);
                    
                    const rawRealm = typeof messageBody.realm === 'string' ? messageBody.realm.trim() : '';
                    const rawAction = typeof messageBody.action === 'string' ? messageBody.action.trim() : '';
                    const rawSubject = messageBody.subject;

                    if (!rawRealm || !rawAction || rawSubject === undefined || rawSubject === null) {
                        console.error('SQS message missing required fields:', { rawRealm, rawAction, rawSubject });
                        continue;
                    }

                    if (isFullEnrichRequest(messageBody)) {
                        try {
                            const orchestratedPayload = withRequestContext(messageBody, requestContext);
                            await startFullEnrichExecution(orchestratedPayload, requestContext);
                            console.log('[scoutsRequest] fullEnrich request started successfully');
                        } catch (error) {
                            console.error(`[scoutsRequest] Failed to start fullEnrich execution: ${error.message}`);
                        }
                        continue;
                    }

                    if (rawRealm === 'scoutsRequest' && (rawAction === 'request' || rawAction === 'persist')) {
                        try {
                            const translatedPayload = withRequestContext(messageBody, requestContext);
                            console.log(`[${rawRealm}] Translating field-level request:`, JSON.stringify(translatedPayload));
                            await sendToSQS(translatedPayload);
                            console.log(`[${rawRealm}] ${rawAction} field request forwarded successfully`);
                        } catch (error) {
                            console.error(`[${rawRealm}] Failed to translate field-level request: ${error.message}`);
                        }
                        continue;
                    }

                    // Process scoutsRequest messages
                    if (rawRealm === 'scoutsRequest' && (rawAction === 'retry' || rawAction === 'new' || rawAction === 'repair')) {
                        console.log(`[scoutsRequest] Processing ${rawAction} action for:`, rawSubject.title || 'unknown');
                        ensureRuntimeMetadata(rawSubject);
                        
                        const hexValue = rawSubject.hex;
                        if (!hexValue) {
                            console.error('[scoutsRequest] Missing hex value in subject');
                            continue;
                        }
                        
                        // Determine what's needed based on the subject fields
                        let targetRealm = null;
                        let targetAction = null;
                        
                        if (!getTagline(rawSubject)) {
                            // Need tagline generation
                            targetRealm = 'tagline';
                            targetAction = 'request';
                            console.log(`[scoutsRequest] Tagline needed for hex: ${hexValue}`);
                        } else if (!getImageThemeValue(rawSubject)) {
                            // Need image prompt generation
                            targetRealm = 'imageTheme';
                            targetAction = 'request';
                            console.log(`[scoutsRequest] Image prompt needed for hex: ${hexValue}`);
                        } else if (!getImageUrlValue(rawSubject)) {
                            // Need a generated event image
                            targetRealm = 'image';
                            targetAction = 'request';
                            console.log(`[scoutsRequest] Event image needed for hex: ${hexValue}`);
                        } else {
                            console.log(`[scoutsRequest] Subject appears complete for hex: ${hexValue}`);
                            continue;
                        }
                        
                        if (targetRealm) {
                            // Send request to scoutsProcessing queue (NOT scoutsRequests queue)
                            const scoutsPayload = {
                                realm: targetRealm,
                                subject: hexValue,
                                action: targetAction ?? 'request'
                            };
                            
                            const finalScoutsPayload = withRequestContext(scoutsPayload, requestContext);
                            console.log(`[scoutsRequest] Sending to scoutsProcessing queue:`, JSON.stringify(finalScoutsPayload));
                            await sendToSQS(finalScoutsPayload);
                            console.log(`[scoutsRequest] ${rawAction} processed - sent ${targetRealm} request`);
                        }
                    } else {
                        // Only allow tagline, imageTheme, image and persist realms through from SQS
                        const allowed = new Set(['tagline', 'imageTheme', 'image', 'persist']);
                        if (!allowed.has(rawRealm)) {
                            console.error(`[SQS] Dropping unsupported realm=${rawRealm} action=${rawAction} subject=${(rawSubject && rawSubject.title) || 'unknown'}`);
                            // drop the message (don't throw) so SQS won't retry
                            continue;
                        }

                        // Forward allowed realms to the scoutsProcessing queue.
                        try {
                            let forwardPayload = { realm: rawRealm, subject: rawSubject, action: rawAction };
                            if (rawRealm === 'persist') {
                                const expandedPersist = buildPersistPatchForProcessing(rawSubject);
                                forwardPayload = {
                                    realm: 'persist',
                                    subject: expandedPersist.subject,
                                    action: expandedPersist.action,
                                };
                            }
                            if (messageBody.slackMetadata && typeof messageBody.slackMetadata === 'object') {
                                forwardPayload.slackMetadata = { ...messageBody.slackMetadata };
                            }
                            const payload = withRequestContext(forwardPayload, requestContext);
                            await sendToSQS(payload);
                            console.log('SQS message processed and forwarded (no relay Slack post for scouts-origin realm)');
                        } catch (err) {
                            // If forwarding fails, log and drop to avoid retries from downstream issues
                            console.error(`[SQS] Failed to forward message for realm=${rawRealm}:`, err.message);
                            continue;
                        }
                    }
                } catch (error) {
                    console.error('Error processing SQS message:', error.message);
                    // Send to DLQ for processing errors
                    try {
                        const dlqCommand = new SendMessageCommand({
                            QueueUrl: DLQ_URL,
                            MessageBody: JSON.stringify({ ...messageBody, error: error.message, timestamp: new Date().toISOString() }),
                        });
                        await sqsClient.send(dlqCommand);
                        console.log('[DLQ] Error message sent to DLQ');
                    } catch (dlqError) {
                        console.error('[DLQ] Failed to send error to DLQ:', dlqError.message);
                    }
                    // Don't throw to avoid SQS retries
                }
            }
        }

        await persistQueuedRequestsRuntimeSnapshot(event.Records, observedRequestIds, observedHexes, observedLinks, observedRequests);
        
        return withCors({ statusCode: 200, body: 'SQS messages processed' });
    }
    
    try {
        const headers = event.headers || {};
        const queryParams = event.queryStringParameters || {};
        const requestApiKey =
            headers['x-api-key'] ??
            headers['X-Api-Key'] ??
            headers['X-API-KEY'] ??
            headers['x_api_key'] ??
            queryParams.apiKey ??
            queryParams.API_KEY ??
            queryParams['x-api-key'];

        // Skip API key check for SQS-triggered events
        const isSQSTriggered = event.Records && Array.isArray(event.Records) && event.Records.some(r => r.eventSource === 'aws:sqs');
        if (REQUIRED_API_KEY && requestApiKey !== REQUIRED_API_KEY && !isSQSTriggered) {
            return withCors({ statusCode: 403, body: JSON.stringify({ error: 'Forbidden: Invalid API Key' }) });
        }

        let body;
        if (typeof event.body === 'string') {
            body = JSON.parse(event.body || '{}');
        } else if (event.body && typeof event.body === 'object') {
            body = event.body;
        } else {
            body = {};
        }

        const rawRealm = typeof body.realm === 'string' ? body.realm.trim() : '';
        const rawAction = typeof body.action === 'string' ? body.action.trim() : '';
        const rawSubject = body.subject;

        if (!rawRealm || !rawAction || rawSubject === undefined || rawSubject === null) {
            // Send malformed requests to DLQ
            try {
                const dlqCommand = new SendMessageCommand({
                    QueueUrl: DLQ_URL,
                    MessageBody: JSON.stringify({ body, error: 'Missing required fields: realm, subject, action', timestamp: new Date().toISOString() }),
                });
                await sqsClient.send(dlqCommand);
                console.log('[DLQ] Malformed request sent to DLQ');
            } catch (dlqError) {
                console.error('[DLQ] Failed to send malformed request to DLQ:', dlqError.message);
            }
            return withCors({ statusCode: 400, body: JSON.stringify({ error: "Missing required fields: realm, subject, action" }) });
        }

        let normalizedRealm = rawRealm;
        let normalizedAction = rawAction;
        let processedSubject = rawSubject;

        if (processedSubject && typeof processedSubject === 'object') {
            applySanitizedUidToSubject(processedSubject);
        }

        if (isFullEnrichRequest(body)) {
            const requestContext = buildRequestContext(null, body);
            const orchestratedPayload = withRequestContext({
                ...body,
                subject: processedSubject,
            }, requestContext);
            await startFullEnrichExecution(orchestratedPayload, requestContext);
            return withCors({ statusCode: 200, body: JSON.stringify({ message: 'fullEnrich execution started' }) });
        }

        const allowed = new Set(['tagline', 'imageTheme', 'image', 'persist']);
        if (!allowed.has(normalizedRealm)) {
            console.error(`[HTTP] Dropping unsupported realm=${normalizedRealm} action=${normalizedAction}`);
            // Send unsupported realm to DLQ
            try {
                const dlqCommand = new SendMessageCommand({
                    QueueUrl: DLQ_URL,
                    MessageBody: JSON.stringify({ realm: normalizedRealm, action: normalizedAction, subject: processedSubject, error: 'Unsupported realm', timestamp: new Date().toISOString() }),
                });
                await sqsClient.send(dlqCommand);
                console.log('[DLQ] Unsupported realm sent to DLQ');
            } catch (dlqError) {
                console.error('[DLQ] Failed to send unsupported realm to DLQ:', dlqError.message);
            }
            return withCors({ statusCode: 200, body: JSON.stringify({ message: 'Dropped unsupported realm' }) });
        }

        const payload = { realm: normalizedRealm, subject: processedSubject, action: normalizedAction };
        try {
            await sendToSQS(payload);
            return withCors({ statusCode: 200, body: JSON.stringify({ message: 'Payload sent to SQS successfully' }) });
        } catch (err) {
            console.error('[HTTP] Failed to forward payload:', err.message);
            // Log and drop (return 200 so caller won't retry)
            return withCors({ statusCode: 200, body: JSON.stringify({ message: 'Dropped due to forwarding failure' }) });
        }
    } catch (error) {
        console.error("Exception occurred:", error.message);
        return withCors({ statusCode: 500, body: JSON.stringify({ error: error.message }) });
    }
}

export { buildFullEnrichExecutionInput, buildQueuePayload, buildRuntimeRequestEntry };
