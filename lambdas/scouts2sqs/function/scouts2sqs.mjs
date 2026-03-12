import { SQSClient, SendMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import https from 'https';
import crypto from 'crypto';

// Load configuration from environment variables
const { REQUIRED_API_KEY, SLACK_BOT_TOKEN, TARGET_BUCKET } = process.env;
// SLACK_WEBHOOK_URL is a fixed Slack API endpoint used by all Lambdas
const SLACK_WEBHOOK_URL = 'https://slack.com/api/chat.postMessage';
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL || "https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessing";
const DLQ_URL = process.env.DLQ_URL || "https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsProcessingDLQ";
const SLACK_CHANNEL = "#scouts";
const DEFAULT_BUCKET = 'scouts-2ndtolworth-prod-553490163883';
const APPROVAL_METADATA_PREFIX = process.env.APPROVAL_METADATA_PREFIX || 'approvals';
const SLACK_CHAT_UPDATE_URL = process.env.SLACK_CHAT_UPDATE_URL || 'https://slack.com/api/chat.update';
const SLACK_VIEWS_OPEN_URL = process.env.SLACK_VIEWS_OPEN_URL || 'https://slack.com/api/views.open';
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const SCOUTS2SQS_FUNCTION_URL = process.env.SCOUTS2SQS_FUNCTION_URL || '';
const SCOUTS_REQUESTS_QUEUE_URL_FALLBACK =
    process.env.SCOUTS_REQUESTS_QUEUE_URL
    || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests';
const QUEUED_REQUESTS_RUNTIME_KEY = 'runtime/scoutsQueued.json';
const PROCESSING_REQUESTS_RUNTIME_KEY = 'runtime/scoutsProcessing.json';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'eu-west-2' });
const sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'eu-west-2' });

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
    if (typeof subject.hex === 'string' && subject.hex.trim()) {
        return subject.hex.trim().toLowerCase();
    }
    if (typeof subject.hexId === 'string' && subject.hexId.trim()) {
        return subject.hexId.trim().toLowerCase();
    }
    return null;
}

function getTitleHintFromMessageBody(messageBody) {
    if (!messageBody || typeof messageBody !== 'object') {
        return null;
    }

    const directTitle = messageBody.title ?? messageBody.summary ?? messageBody.name ?? null;
    if (typeof directTitle === 'string' && directTitle.trim()) {
        return directTitle.trim();
    }

    const subject = messageBody.subject;
    if (subject && typeof subject === 'object') {
        const subjectTitle = subject.title ?? subject.summary ?? subject.name ?? null;
        if (typeof subjectTitle === 'string' && subjectTitle.trim()) {
            return subjectTitle.trim();
        }
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

function buildRuntimeRequestEntry(record, messageBody, status) {
    const requestId =
        (messageBody && typeof messageBody === 'object'
            ? (messageBody.requestId ?? messageBody.request_id ?? messageBody.id ?? null)
            : null)
        ?? record?.messageId
        ?? null;
    const messageId =
        (messageBody && typeof messageBody === 'object' ? messageBody.messageId ?? null : null)
        ?? record?.messageId
        ?? null;

    return {
        requestTime: getRequestTimeHint(record, messageBody),
        requestId: requestId ? String(requestId) : null,
        messageId: messageId ? String(messageId) : null,
        hexId: getHexHintFromSubject(messageBody?.subject),
        title: getTitleHintFromMessageBody(messageBody),
        realm: typeof messageBody?.realm === 'string' && messageBody.realm.trim() ? messageBody.realm.trim() : null,
        action: normaliseActionHint(messageBody?.action),
        status,
    };
}

function deduplicateRuntimeRequestEntries(entries = []) {
    const deduped = new Map();

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const key = [
            entry.requestId ?? '',
            entry.messageId ?? '',
            entry.hexId ?? '',
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
    if (typeof entry?.hexId === 'string' && entry.hexId.trim()) return entry.hexId.trim().toLowerCase();
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
    const hexIds = new Set();
    const links = [];

    const requestId =
        (messageBody && typeof messageBody === 'object'
            ? (messageBody.requestId ?? messageBody.request_id ?? messageBody.id ?? null)
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
            hexIds.add(hexHint);
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
        .filter((entry) => entry.requestId || entry.messageId || entry.hexId || entry.title);

    return {
        requestIds: Array.from(requestIds),
        hexIds: Array.from(hexIds),
        links,
        requests,
    };
}

function buildRequestContext(record, messageBody) {
    const baseRequestId =
        messageBody?.requestId
        ?? messageBody?.request_id
        ?? messageBody?.id
        ?? record?.messageId
        ?? crypto.randomUUID();
    const requestId = String(baseRequestId);
    const hex = getHexHintFromSubject(messageBody?.subject);
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

async function persistQueuedRequestsRuntimeSnapshot(records, requestIds, hexIds, links, requests = []) {
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
        hexIds: Array.from(
            new Set(reconciled.requests.map((entry) => entry?.hexId).filter(Boolean))
        ).slice(0, 50),
        links: Array.from(
            new Map(
                reconciled.requests
                    .filter((entry) => entry?.requestId && entry?.hexId)
                    .map((entry) => [`${entry.requestId}|${entry.hexId}`, {
                        requestId: entry.requestId,
                        hex: entry.hexId,
                        sourceMessageId: entry.messageId ?? null,
                        realm: entry.realm ?? null,
                        action: entry.action ?? null,
                    }])
            ).values()
        ).slice(0, 100),
        recordCount: reconciled.requests.length,
        scannedRecordCount: Array.isArray(records) ? records.length : 0,
        removedOrphanedRequestCount: reconciled.removedCount,
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
        const title = subject.title ?? subject.summary ?? subject.name ?? subject.hex ?? null;
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

function deriveApprovalIdentifiers(subject) {
    const obj = ensureObjectSubject(subject);
    applySanitizedUidToSubject(obj);
    const identifiers = new Set();
    if (typeof obj.hex === 'string' && obj.hex.trim()) {
        identifiers.add(obj.hex.trim().toLowerCase());
    }
    if (obj.uid) {
        identifiers.add(obj.uid);
    }
    if (obj.originalUid) {
        identifiers.add(obj.originalUid);
    }
    return Array.from(identifiers);
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
    if (!event || typeof event !== 'object') return null;
    const source = typeof event.tagline === 'string' && event.tagline.trim()
        ? event.tagline
        : event.AI;
    if (typeof source !== 'string') return null;
    const trimmed = source.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function setTagline(event, value) {
    if (!event || typeof event !== 'object') return;
    const normalized = typeof value === 'string' ? value.trim() : null;
    const finalValue = normalized && normalized.length > 0 ? normalized : null;
    event.tagline = finalValue;
    event.AI = finalValue;
}

function hasCompleteApprovalData(event) {
    if (!event || typeof event !== 'object') {
        return false;
    }
    const normalizedImage = ensureImageContainer(event.image);
    const hasTagline = typeof getTagline(event) === 'string';
    const hasTheme = typeof normalizedImage.theme === 'string' && normalizedImage.theme.trim().length > 0;
    return hasTagline && hasTheme;
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

function formatDetailLine(label, value, fallback = '_not provided_') {
    if (value === null || value === undefined || value === '') {
        return `*${label}:* ${fallback}`;
    }
    if (typeof value === 'string') {
        return `*${label}:* ${value}`;
    }
    try {
        return `*${label}:* ${JSON.stringify(value)}`;
    } catch {
        return `*${label}:* ${String(value)}`;
    }
}

function buildEventDetailsSection(event, actionLabel, realm = null) {
    applySanitizedUidToEvent(event);
    
    const lines = [];
    
    // For tagline realm (and legacy AI realm): show tagline and image prompt
    if (realm === 'tagline' || realm === 'AI') {
        const tagline = getTagline(event);
        if (tagline) {
            lines.push(formatDetailLine('Tagline', tagline));
        }
        if (event.image?.theme) {
            lines.push(formatDetailLine('Image Theme', event.image.theme));
        }
    }
    // For imageTheme realm: show image theme
    else if (realm === 'imageTheme' || realm === 'imagePrompt') {
        if (event.image?.theme) {
            lines.push(formatDetailLine('Image Theme', event.image.theme));
        }
    }
    // For image/imageUrl realms: show image link only if assigned
    else if (realm === 'image' || realm === 'imageUrl') {
        if (event.image?.url) {
            lines.push(formatDetailLine('Image Link', event.image.url));
        }
    }
    // For other realms, show all details (legacy behavior)
    else {
        lines.push(formatDetailLine('Action', actionLabel ?? 'unknown'));
        lines.push(formatDetailLine('Tagline', getTagline(event)));
        lines.push(formatDetailLine('Title', event.title ?? event.summary ?? event.name));
        lines.push(formatDetailLine('Image Theme', event.image?.theme));
        lines.push(formatDetailLine('Image URL', event.image?.url));
    }

    return lines.length > 0 ? lines.join('\n') : '_No additional details available._';
}

function buildApprovalBlocks(event, actionLabel, options = {}) {
    const {
        realm = 'scouts',
        approveAction = actionLabel,
        rejectAction = 'reject',
        previewText = null,
        enableEdit = true,
    } = options;

    const detailsText = buildEventDetailsSection(event, actionLabel, realm);
    
    // Determine header title based on realm
    let headerTitle;
    if (realm === 'tagline' || realm === 'AI') {
        headerTitle = 'Tagline';
    } else if (realm === 'imageTheme' || realm === 'imagePrompt') {
        headerTitle = 'Image Theme';
    } else if (realm === 'image' || realm === 'imageUrl') {
        headerTitle = 'Image Link';
    } else {
        headerTitle = event.title ?? event.summary ?? event.name ?? 'Scouts Event';
    }
    const approvePayload = Buffer.from(
        JSON.stringify({
            realm,
            action: approveAction,
            subject: event,
        })
    ).toString('base64');
    const rejectPayload = Buffer.from(
        JSON.stringify({
            realm,
            action: rejectAction,
            subject: event,
        })
    ).toString('base64');
    const editPayload = Buffer.from(
        JSON.stringify({
            realm,
            action: 'EDIT',
            subject: event,
        })
    ).toString('base64');

    const approveValue = JSON.stringify({
        decision: 'approve',
        realm: 'slack',
        payload: approvePayload,
    });
    const rejectValue = JSON.stringify({
        decision: 'reject',
        realm: 'slack', 
        payload: rejectPayload,
    });
    const editValue = JSON.stringify({
        decision: 'edit',
        realm: 'slack',
        payload: editPayload,
    });

    const blocks = [
        {
            type: 'header',
            text: {
                type: 'plain_text',
                text: `Scouts Approval Needed: ${headerTitle}`.slice(0, 150),
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

    blocks.push({
        type: 'section',
        text: {
            type: 'mrkdwn',
            text: detailsText,
        },
    });
    if (event.image?.url) {
        blocks.push({
            type: 'image',
            image_url: event.image.url,
            alt_text: `Image for ${headerTitle}`,
        });
    }

    blocks.push({
        type: 'actions',
        block_id: 'scouts_request_actions',
        elements: (() => {
            const elements = [
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
                    action_id: 'scouts_request_reject',
                    text: {
                        type: 'plain_text',
                        emoji: true,
                        text: 'Reject',
                    },
                    style: 'danger',
                    value: rejectValue,
                },
            ];
            if (enableEdit) {
                elements.splice(1, 0, {
                    type: 'button',
                    action_id: 'scouts_request_edit',
                    text: {
                        type: 'plain_text',
                        emoji: true,
                        text: 'Edit',
                    },
                    value: editValue,
                });
            }
            return elements;
        })(),
    });

    return blocks;
}

function cloneEvent(event) {
    if (!event) {
        return {};
    }
    try {
        return JSON.parse(JSON.stringify(event));
    } catch {
        if (typeof globalThis.structuredClone === 'function') {
            try {
                return globalThis.structuredClone(event);
            } catch {
                // fall through
            }
        }
        return { ...event };
    }
}

function normaliseInput(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
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

async function loadApprovalMessageMetadata(subject, realm) {
    const identifiers = deriveApprovalIdentifiers(subject);
    if (identifiers.length === 0) {
        return null;
    }

    for (const identifier of identifiers) {
        const key = buildApprovalMetadataKey(identifier, realm);
        try {
            const command = new GetObjectCommand({
                Bucket: TARGET_BUCKET || DEFAULT_BUCKET,
                Key: key,
            });
            const response = await s3Client.send(command);
            const bodyString = await response.Body.transformToString();
            const metadata = JSON.parse(bodyString);
            metadata.identifiers = identifiers;
            return metadata;
        } catch (error) {
            if (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
                continue;
            }
            console.warn(`[Approval] Error loading metadata ${key}:`, error.message);
        }
    }
    console.warn(`[Approval] No metadata found for realm=${realm} identifiers=${identifiers.join(', ')}`);
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
        console.warn('[Approval] Metadata missing identifiers; skipping update');
        return;
    }

    if (merged.event) {
        merged.event = JSON.parse(JSON.stringify(merged.event));
    }
    merged.identifiers = identifiers;

    await Promise.all(
        identifiers.map(async (identifier) => {
            const key = buildApprovalMetadataKey(identifier, merged.realm ?? metadata.realm);
            const command = new PutObjectCommand({
                Bucket: TARGET_BUCKET || DEFAULT_BUCKET,
                Key: key,
                Body: JSON.stringify(merged, null, 2),
                ContentType: 'application/json',
                CacheControl: 'no-store',
            });
            await s3Client.send(command);
            console.log(`[Approval] Updated metadata at s3://${TARGET_BUCKET || DEFAULT_BUCKET}/${key}`);
        })
    );
}

function getHeader(headers, name) {
    if (!headers) return undefined;
    if (headers[name] !== undefined) {
        return headers[name];
    }
    const lower = name.toLowerCase();
    if (headers[lower] !== undefined) {
        return headers[lower];
    }
    const upper = name.toUpperCase();
    if (headers[upper] !== undefined) {
        return headers[upper];
    }
    return undefined;
}

function verifySlackSignature(headers, rawBody) {
    if (!SLACK_SIGNING_SECRET) {
        return true;
    }
    const timestamp = getHeader(headers, 'X-Slack-Request-Timestamp');
    const slackSignature = getHeader(headers, 'X-Slack-Signature');
    if (!timestamp || !slackSignature) {
        return false;
    }
    const baseString = `v0:${timestamp}:${rawBody}`;
    const computedSignature = `v0=${crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(baseString).digest('hex')}`;
    const computedBuffer = Buffer.from(computedSignature, 'utf8');
    const receivedBuffer = Buffer.from(slackSignature, 'utf8');
    if (computedBuffer.length !== receivedBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(computedBuffer, receivedBuffer);
}

function parseSlackPayload(rawBody) {
    if (!rawBody) {
        throw new Error('Slack payload missing body');
    }
    const params = new URLSearchParams(rawBody);
    const payload = params.get('payload');
    if (!payload) {
        throw new Error('Slack payload missing payload parameter');
    }
    return JSON.parse(payload);
}

async function refreshApprovalMessage(metadata, event, realm, { previewText = null } = {}) {
    if (!metadata?.channel || !metadata?.ts) {
        throw new Error('Cannot refresh Slack message without channel and ts');
    }
    const eventClone = cloneEvent(event);
    eventClone.image = ensureImageContainer(eventClone.image);
    applySanitizedUidToEvent(eventClone);

    const blocks = buildApprovalBlocks(eventClone, `Review ${realm}`, {
        realm,
        approveAction: 'APPROVE',
        rejectAction: 'REJECT',
        previewText: previewText ?? metadata.previewText ?? null,
        enableEdit: true,
    });

    const text = `Enrichment review for ${eventClone.title ?? 'Scouts event'}`;
    const response = await sendHttpRequest(
        SLACK_CHAT_UPDATE_URL,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
                'Content-Type': 'application/json',
            },
        },
        JSON.stringify({
            channel: metadata.channel,
            ts: metadata.ts,
            text,
            blocks,
        })
    );
    if (!response.ok) {
        throw new Error(`Slack API error: ${JSON.stringify(response)}`);
    }
}

function buildEditModal(event, realm, metadata = {}, previewText = null) {
    const identifiers = Array.isArray(metadata.identifiers) && metadata.identifiers.length > 0
        ? metadata.identifiers
        : deriveApprovalIdentifiers(event);
    const contextLines = [
        `*Realm:* ${realm}`,
        event.hex ? `*HEX:* ${event.hex}` : null,
    ].filter(Boolean);

    const privateMetadata = JSON.stringify({
        realm,
        identifiers,
        channel: metadata.channel ?? null,
        ts: metadata.ts ?? null,
        previewText: previewText ?? metadata.previewText ?? null,
        event: Buffer.from(JSON.stringify(event)).toString('base64'),
    });

    return {
        type: 'modal',
        callback_id: 'scouts_request_edit_modal',
        private_metadata: privateMetadata,
        title: { type: 'plain_text', text: 'Edit Approval', emoji: true },
        submit: { type: 'plain_text', text: 'OK', emoji: true },
        close: { type: 'plain_text', text: 'Cancel', emoji: true },
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*${event.title ?? event.summary ?? event.name ?? 'Scouts event'}*`,
                },
            },
            ...(contextLines.length > 0
                ? [
                    {
                        type: 'context',
                        elements: contextLines.map((line) => ({ type: 'mrkdwn', text: line })),
                    },
                ]
                : []),
            {
                type: 'input',
                block_id: 'title_block',
                optional: true,
                label: { type: 'plain_text', text: 'Title', emoji: true },
                element: {
                    type: 'plain_text_input',
                    action_id: 'title_input',
                    initial_value: event.title ?? '',
                },
            },
            {
                type: 'input',
                block_id: 'ai_block',
                optional: true,
                label: { type: 'plain_text', text: 'Tagline', emoji: true },
                element: {
                    type: 'plain_text_input',
                    action_id: 'ai_input',
                    multiline: true,
                    initial_value: getTagline(event) ?? '',
                },
            },
            {
                type: 'input',
                block_id: 'image_prompt_block',
                optional: true,
                label: { type: 'plain_text', text: 'Image Theme', emoji: true },
                element: {
                    type: 'plain_text_input',
                    action_id: 'image_prompt_input',
                    initial_value: event.image?.theme ?? '',
                },
            },
            {
                type: 'input',
                block_id: 'image_url_block',
                optional: true,
                label: { type: 'plain_text', text: 'Image URL', emoji: true },
                element: {
                    type: 'plain_text_input',
                    action_id: 'image_url_input',
                    initial_value: event.image?.url ?? '',
                },
            },
        ],
    };
}

async function openEditModal(triggerId, event, realm, metadata = {}) {
    const modal = buildEditModal(event, realm, metadata, metadata.previewText ?? null);
    const response = await sendHttpRequest(
        SLACK_VIEWS_OPEN_URL,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
                'Content-Type': 'application/json',
            },
        },
        JSON.stringify({
            trigger_id: triggerId,
            view: modal,
        })
    );
    if (!response.ok) {
        throw new Error(`Slack API error: ${JSON.stringify(response)}`);
    }
}

function buildDecisionSummaryBlocks(subject, realm, decisionLabel, messageText) {
    const obj = ensureObjectSubject(subject);
    const details = [];
    const tagline = getTagline(obj);
    if (tagline) {
        details.push(`*Tagline:* ${tagline}`);
    }
    if (obj.image?.theme) {
        details.push(`*Image Theme:* ${obj.image.theme}`);
    }
    if (obj.image?.url) {
        details.push(formatDetailLine('Image URL', obj.image.url));
    }
    if (obj.title ?? obj.summary ?? obj.name) {
        details.push(`*Title:* ${obj.title ?? obj.summary ?? obj.name}`);
    }
    if (obj.hex) {
        details.push(`*HEX:* ${obj.hex}`);
    }

    const summaryLines = [`*Decision:* ${decisionLabel}`];
    if (messageText) {
        summaryLines.push(messageText);
    }
    const summaryText = summaryLines.join('\n');
    const detailText = details.length > 0 ? details.join('\n') : '_No additional details available._';

    return [
        {
            type: 'header',
            text: {
                type: 'plain_text',
                text: `Scouts ${realm} review`,
                emoji: true,
            },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: summaryText,
            },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: detailText,
            },
        },
    ];
}

async function updateApprovalMessageAfterDecision(subject, realm, messageText, decisionLabel, statusValue) {
    try {
        const metadata = await loadApprovalMessageMetadata(subject, realm);
        if (!metadata?.channel || !metadata?.ts) {
            console.warn('[Approval] Missing channel or ts in metadata; cannot update Slack message');
            return false;
        }

        const payload = {
            channel: metadata.channel,
            ts: metadata.ts,
            text: messageText,
            blocks: buildDecisionSummaryBlocks(subject, realm, decisionLabel, messageText),
        };
        const options = {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
                'Content-Type': 'application/json',
            },
        };
        const response = await sendHttpRequest(SLACK_CHAT_UPDATE_URL, options, JSON.stringify(payload));
        if (!response.ok) {
            throw new Error(`Slack API error: ${JSON.stringify(response)}`);
        }
        await persistApprovalMetadata(metadata, { status: statusValue ?? metadata.status });
        console.log('[Approval] Slack message replaced successfully');
        return true;
    } catch (error) {
        console.warn('[Approval] Failed to update Slack message:', error.message);
        return false;
    }
}

function decodeActionValue(rawValue) {
    if (typeof rawValue !== 'string' || !rawValue) {
        return {};
    }
    try {
        return JSON.parse(rawValue);
    } catch (error) {
        console.warn('[Slack] Failed to parse action value JSON:', error.message);
        return {};
    }
}

function decodeContextPayload(encoded) {
    if (typeof encoded !== 'string' || !encoded) {
        return {};
    }
    try {
        const json = Buffer.from(encoded, 'base64').toString('utf8');
        return JSON.parse(json);
    } catch (error) {
        console.warn('[Slack] Failed to decode context payload:', error.message);
        return {};
    }
}

async function replaceMessageWithProcessing(channel, ts, realm, eventTitle) {
    const processingBlocks = [
        {
            type: 'header',
            text: {
                type: 'plain_text',
                text: `Processing ${realm} request...`,
                emoji: true,
            },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `⏳ Processing ${realm} request for *${eventTitle}*\n\nPlease wait while we handle your request...`,
            },
        },
    ];

    try {
        await sendHttpRequest(
            SLACK_CHAT_UPDATE_URL,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            },
            JSON.stringify({
                channel,
                ts,
                text: `Processing ${realm} request...`,
                blocks: processingBlocks,
            })
        );
    } catch (error) {
        console.warn('[Slack] Failed to update message with processing status:', error.message);
    }
}

async function replaceMessageWithIgnored(channel, ts, realm, eventTitle) {
    const ignoredBlocks = [
        {
            type: 'header',
            text: {
                type: 'plain_text',
                text: `Ignored ${realm} request`,
                emoji: true,
            },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `🚫 Ignored ${realm} request for *${eventTitle}*`,
            },
        },
    ];

    try {
        await sendHttpRequest(
            SLACK_CHAT_UPDATE_URL,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            },
            JSON.stringify({
                channel,
                ts,
                text: `Ignored ${realm} request for ${eventTitle}`,
                blocks: ignoredBlocks,
            })
        );
    } catch (error) {
        console.warn('[Slack] Failed to update message with ignored status:', error.message);
    }
}

async function handleSlackBlockActions(parsedPayload) {
    const action = parsedPayload.actions?.[0];
    if (!action) {
        return { statusCode: 200, body: '' };
    }

    const baseValue = decodeActionValue(action.value);
    const context = decodeContextPayload(baseValue.payload);
    const realm = context.realm ?? baseValue.realm ?? 'scouts';
    const normalizedAction = context.action ?? (baseValue.decision === 'approve'
        ? 'APPROVE'
        : baseValue.decision === 'reject'
            ? 'REJECT'
            : null);

    const originalSubject = context.subject ?? {};
    const eventData = cloneEvent(ensureObjectSubject(originalSubject));
    eventData.image = ensureImageContainer(eventData.image);
    applySanitizedUidToEvent(eventData);

    const channel = parsedPayload.container?.channel_id ?? parsedPayload.message?.channel ?? null;
    const ts = parsedPayload.message?.ts ?? parsedPayload.container?.message_ts ?? null;
    const eventTitle = eventData.title ?? eventData.summary ?? eventData.name ?? 'Scouts event';

    if (baseValue.decision === 'edit' || action.action_id === 'scouts_request_edit' || 
        baseValue.decision === 'approve' || action.action_id === 'scouts_request_approve') {
        const metadataForEdit = {
            realm,
            identifiers: deriveApprovalIdentifiers(eventData),
            channel,
            ts,
            previewText: null,
        };
        // Open modal asynchronously but don't block response
        openEditModal(parsedPayload.trigger_id, eventData, realm, metadataForEdit).catch(error => {
            console.error('[Slack] Failed to open edit modal:', error.message);
        });
        return { statusCode: 200, body: '' };
    }

    if (!normalizedAction) {
        console.warn('[Slack] Missing normalized action for decision');
        return { statusCode: 200, body: '' };
    }

    const queuePayload = {
        realm: context.realm ?? realm,
        subject: eventData,
        action: normalizedAction,
    };

    // Handle async operations without blocking response
    (async () => {
        try {
            // Send to SQS for processing
            await sendToSQS(queuePayload);

            // For non-tagline realms (legacy AI included), update approval message after processing
            if (realm !== 'tagline' && realm !== 'AI') {
                if (baseValue.decision === 'approve') {
                    const messageText = `✅ ${realm} approved for ${eventTitle}`;
                    await updateApprovalMessageAfterDecision(eventData, realm, messageText, 'Approved', 'APPROVED');
                }
            }
        } catch (error) {
            console.error('[Slack] Error in async processing:', error.message);
        }
    })();
    
    return { statusCode: 200, body: '' };
}

async function handleSlackViewSubmission(parsedPayload) {
    let privateMeta = {};
    try {
        privateMeta = parsedPayload.view?.private_metadata
            ? JSON.parse(parsedPayload.view.private_metadata)
            : {};
    } catch (error) {
        console.warn('[Slack] Failed to parse modal metadata:', error.message);
    }

    const realm = privateMeta.realm ?? 'scouts';
    let baseEvent = {};
    if (typeof privateMeta.event === 'string') {
        try {
            baseEvent = JSON.parse(Buffer.from(privateMeta.event, 'base64').toString('utf8'));
        } catch (error) {
            console.warn('[Slack] Failed to decode modal event data:', error.message);
        }
    }

    let metadata = null;
    if (Array.isArray(privateMeta.identifiers) && privateMeta.identifiers.length > 0) {
        metadata = {
            realm,
            identifiers: privateMeta.identifiers,
            channel: privateMeta.channel ?? null,
            ts: privateMeta.ts ?? null,
            previewText: privateMeta.previewText ?? null,
        };
    }

    try {
        const loaded = await loadApprovalMessageMetadata(baseEvent, realm);
        if (loaded) {
            metadata = {
                ...loaded,
                identifiers: loaded.identifiers ?? metadata?.identifiers ?? deriveApprovalIdentifiers(baseEvent),
                previewText: loaded.previewText ?? metadata?.previewText ?? null,
            };
        }
    } catch (error) {
        console.warn('[Slack] Unable to reload approval metadata:', error.message);
    }

    if (!metadata) {
        metadata = {
            realm,
            identifiers: deriveApprovalIdentifiers(baseEvent),
            channel: privateMeta.channel ?? null,
            ts: privateMeta.ts ?? null,
            previewText: privateMeta.previewText ?? null,
        };
    }

    const values = parsedPayload.view?.state?.values ?? {};
    const titleValue = normaliseInput(values.title_block?.title_input?.value);
    const taglineValue = normaliseInput(values.ai_block?.ai_input?.value);
    const promptValue = normaliseInput(values.image_prompt_block?.image_prompt_input?.value);
    const urlValue = normaliseInput(values.image_url_block?.image_url_input?.value);

    const updatedEvent = cloneEvent(metadata.event ?? baseEvent);
    updatedEvent.image = ensureImageContainer(updatedEvent.image);
    if (titleValue !== null) {
        updatedEvent.title = titleValue;
    }
    // Allow clearing/nulling tagline field
    if (values.ai_block?.ai_input !== undefined) {
        setTagline(updatedEvent, taglineValue);
    }
    // Allow clearing/nulling image prompt field
    if (values.image_prompt_block?.image_prompt_input !== undefined) {
        updatedEvent.image.theme = promptValue;
        if ('prompt' in updatedEvent.image) delete updatedEvent.image.prompt;
    }
    // Allow clearing/nulling image URL field
    if (values.image_url_block?.image_url_input !== undefined) {
        updatedEvent.image.url = urlValue;
    }
    applySanitizedUidToEvent(updatedEvent);

    const combinedIdentifiers = Array.from(
        new Set([
            ...(metadata.identifiers ?? []),
            ...deriveApprovalIdentifiers(updatedEvent),
        ])
    );

    try {
        await refreshApprovalMessage(metadata, updatedEvent, realm, {
            previewText: metadata.previewText ?? privateMeta.previewText ?? null,
        });
        await persistApprovalMetadata(metadata, {
            event: updatedEvent,
            identifiers: combinedIdentifiers,
            previewText: metadata.previewText ?? privateMeta.previewText ?? null,
            status: metadata.status ?? 'PENDING',
        });
    } catch (error) {
        console.error('[Slack] Failed to apply modal updates:', error.message);
    }

    return {
        statusCode: 200,
        body: JSON.stringify({ response_action: 'clear' }),
    };
}

async function handleSlackInteraction(event) {
    const headers = event.headers || {};
    const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body || '', 'base64').toString('utf8')
        : event.body || '';

    // Skip signature verification if request is forwarded from slack-handler
    const forwardedFromSlackHandler = getHeader(headers, 'X-Forwarded-From') === 'slack-handler';
    if (!forwardedFromSlackHandler && !verifySlackSignature(headers, rawBody)) {
        console.warn('[Slack] Signature verification failed');
        return { statusCode: 403, body: JSON.stringify({ error: 'Invalid Slack signature' }) };
    }

    let parsedPayload;
    try {
        parsedPayload = parseSlackPayload(rawBody);
    } catch (error) {
        console.error('[Slack] Invalid payload:', error.message);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid Slack payload' }) };
    }

    try {
        if (parsedPayload.type === 'block_actions') {
            await handleSlackBlockActions(parsedPayload);
            return { statusCode: 200, body: '' };
        }
        if (parsedPayload.type === 'view_submission') {
            return await handleSlackViewSubmission(parsedPayload);
        }
        return { statusCode: 200, body: '' };
    } catch (error) {
        console.error('[Slack] Interaction handler error:', error.message);
        return { statusCode: 200, body: '' };
    }
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

    const hexValue = normalizeNullableText(compactSubject.hexId ?? compactSubject.hex)?.toLowerCase();
    if (!hexValue) {
        throw new Error('Persist request missing hex identifier');
    }

    const patch = {};

    if (Object.prototype.hasOwnProperty.call(compactSubject, 'tagline')) {
        patch.metadata = patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : {};
        patch.metadata.tagline = normalizeNullableText(compactSubject.tagline);
    }

    if (
        Object.prototype.hasOwnProperty.call(compactSubject, 'imageTheme')
        || Object.prototype.hasOwnProperty.call(compactSubject, 'imagePrompt')
    ) {
        patch.metadata = patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : {};
        patch.metadata.image = patch.metadata.image && typeof patch.metadata.image === 'object'
            ? patch.metadata.image
            : {};
        patch.metadata.image.theme = normalizeNullableText(compactSubject.imageTheme ?? compactSubject.imagePrompt);
    }
    if (Object.prototype.hasOwnProperty.call(compactSubject, 'imageUrl')) {
        patch.metadata = patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : {};
        patch.metadata.image = patch.metadata.image && typeof patch.metadata.image === 'object'
            ? patch.metadata.image
            : {};
        patch.metadata.image.url = normalizeNullableText(compactSubject.imageUrl);
    }

    const isHidden = normalizeOptionalBoolean(compactSubject.isHidden);
    if (isHidden !== null) {
        patch.metadata = patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : {};
        patch.metadata.status = patch.metadata.status && typeof patch.metadata.status === 'object'
            ? patch.metadata.status
            : {};
        patch.metadata.status.isHidden = isHidden;
    }

    const isApproved = normalizeOptionalBoolean(compactSubject.isApproved);
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
        
        // Determine what field needs populating
        let realm = null;
        let subject = hexValue;
        let sqsAction = null;
        
        if (!getTagline(hexData)) {
            realm = 'tagline';
            subject = hexValue;
            sqsAction = hexData.title;
        } else if (!hexData.image?.theme) {
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

async function sendToSlack(subject, action, realm) {
    // Only support enrichment realms in this lambda
    const allowed = new Set(['tagline', 'AI', 'imageTheme', 'imagePrompt', 'image']);
    if (!allowed.has(realm)) {
        console.error(`[Slack] Dropping notification for unsupported realm=${realm}.`);
        return;
    }

    const subjectObject = ensureObjectSubject(subject);
    applySanitizedUidToSubject(subjectObject);
    const hexValue = typeof subjectObject.hex === 'string' ? subjectObject.hex.trim() : null;
    const title = subjectObject.title ?? subjectObject.summary ?? subjectObject.name ?? 'unknown title';
    const identifierText = hexValue ? ` | Hex: ${hexValue}` : '';
    const messageText = `Realm: ${realm}${identifierText} | Title: ${title}`;

    const slackMessage = {
        channel: SLACK_CHANNEL,
        text: messageText
    };
    console.log("Payload sent to Slack:", JSON.stringify(slackMessage, null, 2));
    const options = {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            'Content-Type': 'application/json'
        }
    };
    try {
        const response = await sendHttpRequest(SLACK_WEBHOOK_URL, options, JSON.stringify(slackMessage));
        if (!response.ok) throw new Error(`Slack API error: ${JSON.stringify(response)}`);
        console.log("Message sent to Slack successfully");
    } catch (error) {
        console.error("Slack API request failed:", error.message);
        throw error;
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

        if (typeof subject.hexId === 'string') {
            const trimmedHexId = subject.hexId.trim();
            if (trimmedHexId) {
                return trimmedHexId;
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

    // Only allow a small set of realms through (include 'persist' so this lambda
    // can publish persist messages created during approval flows)
    const allowedRealms = new Set(['tagline', 'AI', 'imageTheme', 'imagePrompt', 'image', 'persist']);
    if (!allowedRealms.has(realm)) {
        throw new Error(`Realm ${realm} not supported by this lambda`);
    }

    const requiresHexOnly =
        typeof realm === 'string'
        && (realm === 'tagline' || realm === 'AI')
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

    return payload;
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
        const observedHexIds = [];
        const observedLinks = [];
        const observedRequests = [];
        for (const record of event.Records) {
            if (record.eventSource === 'aws:sqs') {
                try {
                    const messageBody = JSON.parse(record.body);
                    console.log('Processing SQS message:', JSON.stringify(messageBody));
                    const hints = collectRequestHints(record, messageBody);
                    observedRequestIds.push(...hints.requestIds);
                    observedHexIds.push(...hints.hexIds);
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

                    if (rawRealm === 'slack') {
                        console.log('[SlackRelay] Handling Slack-origin message');

                        const eventSubject = ensureObjectSubject(rawSubject);
                        const hexValue = typeof eventSubject.hex === 'string' ? eventSubject.hex.trim() : '';
                        if (!hexValue) {
                            console.error('[SlackRelay] Missing hex identifier in Slack payload');
                            continue;
                        }

                        const normalizedImage = ensureImageContainer(eventSubject.image);
                        const hasFullApprovalPayload = hasCompleteApprovalData({ ...eventSubject, image: normalizedImage });

                        if (!hasFullApprovalPayload) {
                            const requeuePayload = {
                                realm: 'scoutsRequest',
                                action: 'new',
                                subject: {
                                    ...eventSubject,
                                    image: normalizedImage,
                                },
                            };

                            try {
                                console.log('[SlackRelay] Incomplete approval payload - requeueing for enrichment:', JSON.stringify(requeuePayload));
                                await sendToSQS(withRequestContext(requeuePayload, requestContext));
                            } catch (error) {
                                console.error('[SlackRelay] Failed to requeue incomplete approval payload:', error.message);
                            }
                            continue;
                        }

                        const normalizedAction = rawAction.toLowerCase();
                        const isHiddenAction = normalizedAction === 'hidden' || normalizedAction === 'hide';
                        const persistAction = isHiddenAction ? 'hidden' : 'persist';
                        const persistSubject = isHiddenAction
                            ? {
                                ...eventSubject,
                                status: eventSubject.status ?? 'hidden',
                            }
                            : eventSubject;

                        const persistPayload = {
                            realm: 'persist',
                            action: persistAction,
                            subject: persistSubject,
                        };

                        const slackMetadata = (messageBody.slackMetadata && typeof messageBody.slackMetadata === 'object')
                            ? { ...messageBody.slackMetadata }
                            : null;
                        const fallbackResponseUrl = messageBody.responseUrl || messageBody.response_url || null;
                        const responseUrl = slackMetadata?.responseUrl ?? slackMetadata?.response_url ?? fallbackResponseUrl ?? null;
                        if (slackMetadata || responseUrl) {
                            persistPayload.slackMetadata = {
                                ...(slackMetadata || {}),
                                ...(responseUrl ? { responseUrl } : {}),
                            };
                        }

                        try {
                            const finalPersistPayload = withRequestContext(persistPayload, requestContext);
                            console.log('[SlackRelay] Forwarding to scoutsProcessing queue:', JSON.stringify(finalPersistPayload));
                            await sendToSQS(finalPersistPayload);
                            console.log('[SlackRelay] Slack payload forwarded successfully');
                        } catch (error) {
                            console.error('[SlackRelay] Failed to forward Slack payload:', error.message);
                        }

                        continue;
                    }

                    // Process scoutsRequest messages
                    if (rawRealm === 'scoutsRequest' && (rawAction === 'retry' || rawAction === 'new' || rawAction === 'repair')) {
                        console.log(`[scoutsRequest] Processing ${rawAction} action for:`, rawSubject.title || 'unknown');
                        
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
                        } else if (!rawSubject.image?.theme) {
                            // Need image prompt generation
                            targetRealm = 'imageTheme';
                            targetAction = 'request';
                            console.log(`[scoutsRequest] Image prompt needed for hex: ${hexValue}`);
                        } else if (!rawSubject.image?.url) {
                            // Need AI-generated event image
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
                        // Only allow tagline (legacy AI), imageTheme, image and persist realms through from SQS
                        const allowed = new Set(['tagline', 'AI', 'imageTheme', 'imagePrompt', 'image', 'persist']);
                        if (!allowed.has(rawRealm)) {
                            console.error(`[SQS] Dropping unsupported realm=${rawRealm} action=${rawAction} subject=${(rawSubject && rawSubject.title) || 'unknown'}`);
                            // drop the message (don't throw) so SQS won't retry
                            continue;
                        }

                        // Forward allowed realms to the scoutsProcessing queue.
                        // Do NOT emit relay Slack messages for scouts-origin realms.
                        // Slack-origin messages are handled in the dedicated rawRealm === 'slack' branch above.
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

        await persistQueuedRequestsRuntimeSnapshot(event.Records, observedRequestIds, observedHexIds, observedLinks, observedRequests);
        
        return withCors({ statusCode: 200, body: 'SQS messages processed' });
    }
    
    try {
        const headers = event.headers || {};
        const contentTypeHeader = getHeader(headers, 'Content-Type') || '';
        const slackSignature = getHeader(headers, 'X-Slack-Signature');

        // Handle requests forwarded from slack-handler
        const forwardedFromSlackHandler = getHeader(headers, 'X-Forwarded-From') === 'slack-handler';
        if (forwardedFromSlackHandler && typeof contentTypeHeader === 'string' && contentTypeHeader.includes('application/x-www-form-urlencoded')) {
            return await handleSlackInteraction(event);
        }

        // Slack interactions are now handled by the slack-handler lambda
        if (
            (slackSignature || (typeof contentTypeHeader === 'string' && contentTypeHeader.includes('application/x-www-form-urlencoded')))
            && !forwardedFromSlackHandler
        ) {
            return withCors({ statusCode: 400, body: JSON.stringify({ error: 'Slack interactions should use slack-handler lambda' }) });
        }

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
        if (REQUIRED_API_KEY && requestApiKey !== REQUIRED_API_KEY && !forwardedFromSlackHandler && !isSQSTriggered) {
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


        const allowed = new Set(['tagline', 'AI', 'imageTheme', 'imagePrompt', 'image', 'persist']);
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
