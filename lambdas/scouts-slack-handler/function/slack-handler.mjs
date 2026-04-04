import https from 'https';
import crypto from 'crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getRequiredSecret } from '/opt/nodejs/ssm-secrets.mjs';

const SLACK_VIEWS_OPEN_URL = process.env.SLACK_VIEWS_OPEN_URL || 'https://slack.com/api/views.open';
const SCOUTS_REQUEST_QUEUE_URL = process.env.SCOUTS_REQUEST_QUEUE_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests';
const NFC_QUEUE_URL = process.env.NFC_QUEUE_URL || 'https://sqs.eu-west-2.amazonaws.com/553490163883/scoutsRequests';
const sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'eu-west-2' });
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'eu-west-2' });

const TARGET_BUCKET = process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const SCOUTS_CONFIG_KEY = process.env.SCOUTS_CONFIG_KEY || 'scouts.conf';

// Minimal loader to obtain feature flags from scouts.conf stored in S3
async function loadScoutsConfigForSlack() {
    try {
        const res = await s3Client.send(new GetObjectCommand({ Bucket: TARGET_BUCKET, Key: SCOUTS_CONFIG_KEY }));
        const stream = res.Body;
        const chunks = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(body);
        // The flag sought by slack-handler is `scoutsDecision` (top-level or under `scouts`)
        if (parsed && typeof parsed === 'object') {
            if (parsed.scoutsDecision !== undefined) {
                return { scoutsDecision: parsed.scoutsDecision === true || String(parsed.scoutsDecision).trim().toLowerCase() === 'true' };
            }
            if (parsed.scouts && typeof parsed.scouts === 'object' && parsed.scouts.scoutsDecision !== undefined) {
                return { scoutsDecision: parsed.scouts.scoutsDecision === true || String(parsed.scouts.scoutsDecision).trim().toLowerCase() === 'true' };
            }
        }
        return { scoutsDecision: false };
    } catch (error) {
        console.warn('[Config] Failed to load scouts config for slack-handler:', error?.message || error);
        return { scoutsDecision: false };
    }
}

function getHeader(headers, name) {
    if (!headers) return undefined;
    if (headers[name] !== undefined) return headers[name];
    const lower = name.toLowerCase();
    if (headers[lower] !== undefined) return headers[lower];
    const upper = name.toUpperCase();
    if (headers[upper] !== undefined) return headers[upper];
    return undefined;
}

async function verifySlackSignature(headers, rawBody) {
    const slackSigningSecret = await getRequiredSecret('SLACK_SIGNING_SECRET_PARAMETER');
    const timestamp = getHeader(headers, 'X-Slack-Request-Timestamp');
    const slackSignature = getHeader(headers, 'X-Slack-Signature');
    if (!timestamp || !slackSignature) return false;
    const baseString = `v0:${timestamp}:${rawBody}`;
    const computedSignature = `v0=${crypto.createHmac('sha256', slackSigningSecret).update(baseString).digest('hex')}`;
    const computedBuffer = Buffer.from(computedSignature, 'utf8');
    const receivedBuffer = Buffer.from(slackSignature, 'utf8');
    if (computedBuffer.length !== receivedBuffer.length) return false;
    return crypto.timingSafeEqual(computedBuffer, receivedBuffer);
}

function parseSlackPayload(rawBody) {
    if (!rawBody) throw new Error('Slack payload missing body');
    const params = new URLSearchParams(rawBody);
    const payload = params.get('payload');
    if (!payload) throw new Error('Slack payload missing payload parameter');
    return JSON.parse(payload);
}

function jsonResponse(statusCode, payload) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    };
}

function keySuffix(value) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) return '';
    return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}

function parseRawQueryString(rawQueryString) {
    if (!rawQueryString || typeof rawQueryString !== 'string') {
        return {};
    }
    const params = new URLSearchParams(rawQueryString);
    const output = {};
    for (const [key, value] of params.entries()) {
        if (output[key] === undefined) {
            output[key] = value;
        }
    }
    return output;
}

function getQueryValue(event, key) {
    const query = event?.queryStringParameters || {};
    if (query[key] !== undefined) {
        return query[key];
    }
    const lowerKey = key.toLowerCase();
    const upperKey = key.toUpperCase();
    if (query[lowerKey] !== undefined) {
        return query[lowerKey];
    }
    if (query[upperKey] !== undefined) {
        return query[upperKey];
    }
    const rawQuery = parseRawQueryString(event?.rawQueryString);
    if (rawQuery[key] !== undefined) {
        return rawQuery[key];
    }
    if (rawQuery[lowerKey] !== undefined) {
        return rawQuery[lowerKey];
    }
    if (rawQuery[upperKey] !== undefined) {
        return rawQuery[upperKey];
    }
    return undefined;
}

function getRequestApiKey(event, headers) {
    const headerApiKey =
        getHeader(headers, 'x-api-key')
        ?? getHeader(headers, 'x_api_key')
        ?? getHeader(headers, 'api-key');
    const queryApiKey =
        getQueryValue(event, 'apiKey')
        ?? getQueryValue(event, 'api_key')
        ?? getQueryValue(event, 'x-api-key');
    const selected = (headerApiKey ?? queryApiKey ?? '').toString().trim();
    if (!selected) {
        return { value: '', source: 'none' };
    }
    return {
        value: selected,
        source: headerApiKey ? 'header' : 'query',
    };
}

function isAdminRequest(headers) {
    const contentType = (getHeader(headers, 'Content-Type') || '').toLowerCase();
    const slackSignature = getHeader(headers, 'X-Slack-Signature');
    const looksLikeSlackForm = contentType.includes('application/x-www-form-urlencoded');
    return !slackSignature && !looksLikeSlackForm;
}

function parseAdminBody(rawBody) {
    if (!rawBody || typeof rawBody !== 'string') {
        throw new Error('Missing JSON body');
    }
    try {
        return JSON.parse(rawBody);
    } catch (error) {
        throw new Error(`Invalid JSON body: ${error.message}`);
    }
}

const ADMIN_ALLOWED_REALMS = new Set(['AI', 'persist', 'slack', 'scoutsRequest']);

function normalizeAdminPayload(rawPayload) {
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
        throw new Error('Payload must be a JSON object');
    }

    const realm = typeof rawPayload.realm === 'string' ? rawPayload.realm.trim() : '';
    const action = typeof rawPayload.action === 'string' ? rawPayload.action.trim() : '';
    const subject = rawPayload.subject;

    if (!realm || !action || subject === undefined || subject === null) {
        throw new Error('Missing required fields: realm, action, subject');
    }

    if (!ADMIN_ALLOWED_REALMS.has(realm)) {
        throw new Error(`Unsupported realm: ${realm}`);
    }

    return {
        ...rawPayload,
        realm,
        action,
        subject,
    };
}

async function handleAdminRequest(event, headers, rawBody) {
    const method = event?.requestContext?.http?.method || event?.httpMethod || 'POST';
    if (method !== 'POST') {
        return jsonResponse(405, { error: 'Method not allowed. Use POST.' });
    }

    const requiredApiKey = (await getRequiredSecret('REQUIRED_API_KEY_PARAMETER')).trim();
    if (!requiredApiKey) {
        return jsonResponse(500, { error: 'REQUIRED_API_KEY is not configured for admin requests.' });
    }

    const requestApiKey = getRequestApiKey(event, headers);
    if (requestApiKey.value !== requiredApiKey) {
        console.warn('[Auth] Invalid admin API key', {
            source: requestApiKey.source,
            requestApiKeyPresent: Boolean(requestApiKey.value),
            requestApiKeyLength: requestApiKey.value.length,
            requestApiKeyLast4: keySuffix(requestApiKey.value),
            requiredApiKeyLength: requiredApiKey.length,
            requiredApiKeyLast4: keySuffix(requiredApiKey),
        });
        return jsonResponse(403, { error: 'Forbidden: Invalid API Key' });
    }

    let payload;
    try {
        payload = normalizeAdminPayload(parseAdminBody(rawBody));
    } catch (error) {
        return jsonResponse(400, { error: error.message });
    }

    try {
        const queueResult = await sendToScoutsRequestQueue(payload);
        return jsonResponse(200, {
            ok: true,
            message: 'Payload queued in scoutsRequests',
            realm: payload.realm,
            action: payload.action,
            messageId: queueResult?.messageId || null,
        });
    } catch (error) {
        return jsonResponse(500, { error: `Failed to queue payload: ${error.message}` });
    }
}

async function sendToScoutsRequestQueue(payload) {
    console.log('[SQS] Attempting to send message to queue:', SCOUTS_REQUEST_QUEUE_URL);
    console.log('[SQS] Payload:', JSON.stringify(payload, null, 2));
    
    try {
        const command = new SendMessageCommand({
            QueueUrl: SCOUTS_REQUEST_QUEUE_URL,
            MessageBody: JSON.stringify(payload)
        });
        
        console.log('[SQS] Sending command to SQS...');
        const result = await sqsClient.send(command);
        console.log('[SQS] SUCCESS - Message sent to scoutsRequests queue:', result.MessageId);
        return { statusCode: 200, messageId: result.MessageId };
    } catch (error) {
        console.error('[SQS] ERROR - Failed to send message to scoutsRequests queue:', error.message);
        console.error('[SQS] ERROR - Full error:', error);
        throw error;
    }
}

async function sendToNfcQueue(payload) {
    console.log('[SQS] Attempting to send message to NFC queue:', NFC_QUEUE_URL);
    console.log('[SQS] Payload:', JSON.stringify(payload, null, 2));
    
    try {
        const command = new SendMessageCommand({
            QueueUrl: NFC_QUEUE_URL,
            MessageBody: JSON.stringify(payload)
        });
        
        console.log('[SQS] Sending command to SQS...');
        const result = await sqsClient.send(command);
        console.log('[SQS] SUCCESS - Message sent to NFC queue:', result.MessageId);
        return { statusCode: 200, messageId: result.MessageId };
    } catch (error) {
        console.error('[SQS] ERROR - Failed to send message to NFC queue:', error.message);
        console.error('[SQS] ERROR - Full error:', error);
        throw error;
    }
}

async function sendSlackResponse(responseUrl, text, blocks = null) {
    const payload = {
        replace_original: true,
        text: text
    };
    if (blocks) payload.blocks = blocks;
    
    console.log('[Slack] Sending response to:', responseUrl);
    console.log('[Slack] Response payload:', JSON.stringify(payload, null, 2));
    
    return new Promise((resolve, reject) => {
        const url = new URL(responseUrl);
        const options = {
            method: 'POST',
            hostname: url.hostname,
            path: url.pathname + url.search,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => responseData += chunk);
            res.on('end', () => {
                console.log('[Slack] Response status:', res.statusCode);
                console.log('[Slack] Response data:', responseData);
                resolve({ statusCode: res.statusCode, body: responseData });
            });
        });

        req.on('error', (error) => {
            console.error('[Slack] Request error:', error);
            reject(error);
        });
        req.write(JSON.stringify(payload));
        req.end();
    });
}

function ensureImageContainer(image) {
    if (!image || typeof image !== 'object') {
        return { theme: null, prompt: null, url: null };
    }
    return {
        theme: typeof image.theme === 'string' ? image.theme : null,
        prompt: typeof image.prompt === 'string' ? image.prompt : null,
        url: typeof image.url === 'string' ? image.url : null,
    };
}

function ensureMetadataObject(event) {
    if (!event || typeof event !== 'object') return {};
    if (!event.metadata || typeof event.metadata !== 'object') {
        event.metadata = {};
    }
    return event.metadata;
}

function getTagline(event) {
    if (!event || typeof event !== 'object') return null;
    const source = event.metadata?.tagline;
    if (typeof source !== 'string') return null;
    const trimmed = source.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normaliseTaglineFields(event) {
    if (!event || typeof event !== 'object') return;
    const tagline = getTagline(event);
    event.tagline = tagline;
    if ('AI' in event) delete event.AI;
}

function ensureEditableMetadata(event) {
    if (!event || typeof event !== 'object') return event;
    const metadata = ensureMetadataObject(event);
    metadata.hex = typeof metadata.hex === 'string' && metadata.hex.trim()
        ? metadata.hex.trim().toLowerCase()
        : (typeof event.hex === 'string' && event.hex.trim() ? event.hex.trim().toLowerCase() : null);
    if (metadata.hex) {
        event.hex = metadata.hex;
    } else if ('hex' in event) {
        delete event.hex;
    }

    metadata.tagline = getTagline(event);
    metadata.image = ensureImageContainer(metadata.image ?? event.image);
    metadata.status = metadata.status && typeof metadata.status === 'object'
        ? {
            isApproved: metadata.status.isApproved === true,
            isHidden: metadata.status.isHidden === true,
        }
        : { isApproved: false, isHidden: false };

    event.image = { ...metadata.image };
    normaliseTaglineFields(event);
    return event;
}

function extractInputValues(parsedPayload) {
    const state =
        (parsedPayload?.state && parsedPayload.state.values) ||
        (parsedPayload?.view && parsedPayload.view.state?.values) ||
        {};
    const readField = (candidates) => {
        for (const { blockId, actionId } of candidates) {
            const raw = state[blockId]?.[actionId]?.value;
            if (raw !== undefined) {
                const trimmed = String(raw).trim();
                return trimmed.length > 0 ? trimmed : null;
            }
        }
        return undefined;
    };

    return {
        tagline: readField([
            { blockId: 'ai_tagline_input', actionId: 'ai_tagline_value' },
            { blockId: 'ai_block', actionId: 'ai_input' },
            { blockId: 'tagline_input', actionId: 'tagline_value' },
        ]),
        imageTheme: readField([
            { blockId: 'image_prompt_input', actionId: 'image_prompt_value' },
            { blockId: 'image_prompt_block', actionId: 'image_prompt_input' },
        ]),
        imageUrl: readField([
            { blockId: 'image_url_input', actionId: 'image_url_value' },
            { blockId: 'image_url_block', actionId: 'image_url_input' },
        ]),
    };
}

function cloneEvent(event) {
    if (!event || typeof event !== 'object') {
        return {};
    }
    try {
        return JSON.parse(JSON.stringify(event));
    } catch (error) {
        console.warn('[Slack] Failed to clone event payload:', error.message);
        return { ...event };
    }
}

function parseActionValue(rawValue) {
    if (rawValue === undefined || rawValue === null) {
        return { event: {}, meta: {} };
    }

    let parsed = rawValue;
    if (typeof rawValue === 'string') {
        try {
            parsed = JSON.parse(rawValue);
        } catch (error) {
            console.warn('[Slack] Failed to parse action value as JSON:', error.message);
            return { event: {}, meta: {} };
        }
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (parsed.event && typeof parsed.event === 'object') {
            const eventClone = cloneEvent(parsed.event);
            delete eventClone._action;
            return { event: eventClone, meta: parsed };
        }
        const eventClone = cloneEvent(parsed);
        delete eventClone._action;
        return { event: eventClone, meta: {} };
    }

    return { event: {}, meta: {} };
}

function ensureEditableEvent(event) {
    const cloned = cloneEvent(event);
    ensureEditableMetadata(cloned);
    return cloned;
}

function applyInputValuesToEvent(event, inputValues = {}) {
    if (!event || typeof event !== 'object' || !inputValues) {
        return;
    }

    const { tagline, imageTheme, imageUrl } = inputValues;

    if (tagline !== undefined) {
        const metadata = ensureMetadataObject(event);
        metadata.tagline = tagline;
        event.tagline = tagline;
        if ('AI' in event) delete event.AI;
    }

    if (imageTheme !== undefined || imageUrl !== undefined) {
        const metadata = ensureMetadataObject(event);
        const currentImage = ensureImageContainer(metadata.image ?? event.image);
        if (imageTheme !== undefined) {
            currentImage.theme = imageTheme;
            if ('prompt' in currentImage) delete currentImage.prompt;
        }
        if (imageUrl !== undefined) {
            currentImage.url = imageUrl;
        }
        metadata.image = currentImage;
        event.image = currentImage;
    }
}

function updateEventField(event, field, value) {
    if (!event || typeof event !== 'object') {
        return;
    }

    switch (field) {
        case 'AI':
        case 'tagline':
            ensureMetadataObject(event).tagline = value;
            event.tagline = value;
            if ('AI' in event) delete event.AI;
            break;
        case 'image.theme': {
            const metadata = ensureMetadataObject(event);
            const currentImage = ensureImageContainer(metadata.image ?? event.image);
            currentImage.theme = value;
            if ('prompt' in currentImage) delete currentImage.prompt;
            metadata.image = currentImage;
            event.image = currentImage;
            break;
        }
        case 'image.url': {
            const metadata = ensureMetadataObject(event);
            const currentImage = ensureImageContainer(metadata.image ?? event.image);
            currentImage.url = value;
            metadata.image = currentImage;
            event.image = currentImage;
            break;
        }
        default:
            console.warn('[Slack] Unsupported field for update:', field);
    }
}

function encodePrivateEvent(event) {
    try {
        return Buffer.from(JSON.stringify(event ?? {})).toString('base64');
    } catch (error) {
        console.warn('[Slack] Failed to encode event payload:', error.message);
        return Buffer.from('{}').toString('base64');
    }
}

function decodePrivateEvent(encoded) {
    if (typeof encoded !== 'string' || !encoded) {
        return {};
    }
    try {
        const json = Buffer.from(encoded, 'base64').toString('utf8');
        return JSON.parse(json);
    } catch (error) {
        console.warn('[Slack] Failed to decode modal event:', error.message);
        return {};
    }
}

function buildEditModalView({
    realm,
    eventData,
    channel,
    ts,
    responseUrl = null,
    previewText = null,
    approveAction = 'persist',
}) {
    const event = { ...(eventData ?? {}) };
    ensureEditableMetadata(event);
    const image = ensureImageContainer(event.image);
    const title = event.title ?? event.summary ?? event.name ?? 'Scouts event';
    const privateMetadata = JSON.stringify({
        realm,
        channel: channel ?? null,
        ts: ts ?? null,
        responseUrl: responseUrl ?? null,
        event: encodePrivateEvent({ ...event, image }),
        previewText: previewText ?? null,
        approveAction: approveAction ?? 'persist',
    });

    return {
        type: 'modal',
        callback_id: 'scouts_edit_modal',
        private_metadata: privateMetadata,
        title: { type: 'plain_text', text: 'Edit Approval', emoji: true },
        submit: { type: 'plain_text', text: 'Approve changes', emoji: true },
        close: { type: 'plain_text', text: 'Cancel & Reject', emoji: true },
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*${title}*`,
                },
            },
            ...(event.hex
                ? [
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: `HEX: \`${event.hex}\``,
                            },
                        ],
                    },
                ]
                : []),
            previewText
                ? {
                    type: 'context',
                    elements: [
                        {
                            type: 'mrkdwn',
                            text: previewText,
                        },
                    ],
                }
                : null,
            {
                type: 'input',
                block_id: 'ai_block',
                optional: true,
                label: {
                    type: 'plain_text',
                    text: 'Tagline',
                    emoji: true,
                },
                element: {
                    type: 'plain_text_input',
                    action_id: 'ai_input',
                    initial_value: getTagline(event) ?? '',
                    placeholder: {
                        type: 'plain_text',
                        text: 'Enter a short, engaging tagline',
                        emoji: true,
                    },
                },
            },
            {
                type: 'input',
                block_id: 'image_prompt_block',
                optional: true,
                label: {
                    type: 'plain_text',
                    text: 'Image Theme',
                    emoji: true,
                },
                element: {
                    type: 'plain_text_input',
                    action_id: 'image_prompt_input',
                    initial_value: image.theme ?? '',
                    placeholder: {
                        type: 'plain_text',
                        text: 'Describe the unique event scene/theme',
                        emoji: true,
                    },
                },
            },
            {
                type: 'input',
                block_id: 'image_url_block',
                optional: true,
                label: {
                    type: 'plain_text',
                    text: 'Image URL',
                    emoji: true,
                },
                element: {
                    type: 'plain_text_input',
                    action_id: 'image_url_input',
                    initial_value: image.url ?? '',
                    placeholder: {
                        type: 'plain_text',
                        text: 'https://example.com/image.jpg',
                        emoji: true,
                    },
                },
            },
            {
                type: 'input',
                block_id: 'clear_input_block',
                optional: true,
                label: {
                    type: 'plain_text',
                    text: 'Clear existing values',
                    emoji: true,
                },
                element: {
                    type: 'checkboxes',
                    action_id: 'clear_selection',
                    options: [
                        {
                            text: { type: 'plain_text', text: 'Clear tagline', emoji: true },
                            value: 'tagline',
                        },
                        {
                            text: { type: 'plain_text', text: 'Clear image theme', emoji: true },
                            value: 'image.theme',
                        },
                        {
                            text: { type: 'plain_text', text: 'Clear image URL', emoji: true },
                            value: 'image.url',
                        },
                    ],
                },
            },
        ].filter(Boolean),
    };
}

function isSlackEditEnabled() {
    const flag = process.env.slack_edit;
    if (flag === undefined || flag === null) {
        return false;
    }
    return String(flag).trim().toLowerCase() === 'on';
}

async function openSlackModal(triggerId, view) {
    if (!triggerId) {
        throw new Error('Missing trigger_id for Slack modal open');
    }
    if (!isSlackEditEnabled()) {
        console.log('[Slack] slack_edit flag is not "on"; skipping modal open');
        return { ok: true, skipped: true };
    }
    const slackBotToken = await getRequiredSecret('SLACK_BOT_TOKEN_PARAMETER');
    if (!slackBotToken) {
        console.warn('[Slack] SLACK_BOT_TOKEN not configured; skipping modal open');
        return { ok: false, skipped: true };
    }

    const payload = JSON.stringify({ trigger_id: triggerId, view });

    return new Promise((resolve, reject) => {
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${slackBotToken}`,
            },
        };

        const req = https.request(SLACK_VIEWS_OPEN_URL, options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => (responseData += chunk));
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(responseData || '{}');
                    if (!parsed.ok) {
                        console.error('[Slack] Failed to open modal:', parsed);
                        reject(new Error(parsed.error || 'Failed to open Slack modal'));
                    } else {
                        resolve(parsed);
                    }
                } catch (error) {
                    reject(new Error(`Failed to parse Slack modal response: ${error.message}`));
                }
            });
        });

        req.on('error', (error) => {
            console.error('[Slack] Modal request error:', error.message);
            reject(error);
        });
        req.write(payload);
        req.end();
    });
}

async function handleEditModalSubmission(parsedPayload) {
    const metadata = (() => {
        try {
            return parsedPayload.view?.private_metadata
                ? JSON.parse(parsedPayload.view.private_metadata)
                : {};
        } catch (error) {
            console.warn('[Slack] Failed to parse modal metadata:', error.message);
            return {};
        }
    })();

    const baseEvent = ensureEditableEvent(decodePrivateEvent(metadata.event));
    const values = parsedPayload.view?.state?.values ?? {};
    const clearSelections = new Set(
        (values.clear_input_block?.clear_selection?.selected_options ?? []).map((option) => option.value)
    );

    const inputValues = extractInputValues(parsedPayload);
    applyInputValuesToEvent(baseEvent, inputValues);

    for (const field of clearSelections) {
        updateEventField(baseEvent, field, null);
    }

    const realm = 'slack';
    const action = 'persist';
    const responseUrl = metadata.responseUrl ?? null;
    const channel = metadata.channel ?? null;
    const ts = metadata.ts ?? null;

    const payload = {
        realm,
        action,
        subject: baseEvent,
    };
    normaliseTaglineFields(payload.subject);
    ensureEditableMetadata(payload.subject);

    if (channel || ts || responseUrl || metadata.previewText) {
        payload.slackMetadata = {
            channel,
            ts,
            responseUrl,
            previewText: metadata.previewText ?? null,
        };
    }

    console.log('[Slack] Submitting modal edits to SQS:', {
        realm,
        action,
        hasResponseUrl: Boolean(responseUrl),
        channel,
        ts,
    });

    try {
        await sendToScoutsRequestQueue(payload);
    } catch (error) {
        console.error('[Slack] Error sending persist request:', error.message);
    }

    return { response_action: 'clear' };
}

async function handleEditModalClosed(parsedPayload) {
    if (parsedPayload.is_cleared) {
        // Slack sends view_closed with is_cleared=true after submission; no reject needed.
        return;
    }

    console.log('[Slack] Edit modal closed without submission');
}

export async function lambdaHandler(event) {
    console.log('Slack handler invoked:', JSON.stringify(event));
    
    try {
        const headers = event.headers || {};
        const rawBody = event.isBase64Encoded
            ? Buffer.from(event.body || '', 'base64').toString('utf8')
            : event.body || '';

        console.log('[Debug] Raw body (first 500 chars):', rawBody.substring(0, 500));
        console.log('[Debug] Is base64 encoded:', event.isBase64Encoded);

        if (isAdminRequest(headers)) {
            return handleAdminRequest(event, headers, rawBody);
        }

        // Verify Slack signature
        if (!await verifySlackSignature(headers, rawBody)) {
            console.warn('[Slack] Signature verification failed');
            return { statusCode: 403, body: JSON.stringify({ error: 'Invalid Slack signature' }) };
        }

        // Parse Slack payload
        let parsedPayload;
        try {
            parsedPayload = parseSlackPayload(rawBody);
            console.log('[Debug] Parsed payload type:', parsedPayload.type);
            console.log('[Debug] Parsed payload keys:', Object.keys(parsedPayload).sort());
            console.log('[Debug] Response URL:', parsedPayload.response_url);
            console.log('[Debug] Full parsed payload:', JSON.stringify(parsedPayload, null, 2));
        } catch (error) {
            console.error('[Slack] Invalid payload:', error.message);
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid Slack payload' }) };
        }

        // Handle block actions directly
        if (parsedPayload.type === 'block_actions') {
            console.log('[Debug] Block actions payload detected');
            console.log('[Debug] Actions array:', JSON.stringify(parsedPayload.actions, null, 2));
            console.log('[Debug] Response URL from payload:', parsedPayload.response_url);
            console.log('[Debug] Container:', JSON.stringify(parsedPayload.container, null, 2));
            console.log('[Debug] Channel:', JSON.stringify(parsedPayload.channel, null, 2));
            
            const action = parsedPayload.actions?.[0];
            if (action) {
                console.log('[Debug] First action:', JSON.stringify(action, null, 2));
                
                // Extract action_id from the Slack action
                const actionId = action.action_id || '';
                console.log('[Debug] Action ID from Slack:', actionId);
                
                // Extract event data and metadata from the action payload
                const { event: parsedEvent, meta: actionMeta } = parseActionValue(action.value);
                const eventData = ensureEditableEvent(parsedEvent);
                ensureEditableMetadata(eventData);
                console.log('[Debug] Parsed event data keys:', Object.keys(eventData).sort());
                console.log('[Debug] Parsed event data (first 1000 chars):', JSON.stringify(eventData).substring(0, 1000));
                
                const eventTitle = eventData.title ?? eventData.uid ?? 'event';
                const responseUrl = parsedPayload.response_url;
                const channel = parsedPayload.container?.channel_id ?? parsedPayload.channel?.id ?? null;
                const ts = parsedPayload.container?.message_ts ?? parsedPayload.message?.ts ?? null;
                const triggerId = parsedPayload.trigger_id;
                const realm = 'slack';
                const previewText =
                    actionMeta?.previewText
                    ?? actionMeta?.persistContext?.previewText
                    ?? actionMeta?.approvalContext?.previewText
                    ?? parsedPayload.message?.text
                    ?? null;
                
                console.log('[Debug] Extracted values:');
                console.log('[Debug]   eventTitle:', eventTitle);
                console.log('[Debug]   actionId:', actionId);
                console.log('[Debug]   responseUrl:', responseUrl);
                console.log('[Debug]   channel:', channel);
                console.log('[Debug]   ts:', ts);
                console.log('[Debug]   realm:', realm);
                console.log('[Slack] Block action received:', { actionId, eventTitle });
                
                if (actionId === 'scouts_request_edit') {
                    console.log('[Slack] Opening edit modal for persist action');
                    const view = buildEditModalView({
                        realm,
                        eventData,
                        channel,
                        ts,
                        responseUrl,
                        previewText,
                        approveAction: actionMeta?.action ?? 'persist',
                    });
                    try {
                        await openSlackModal(triggerId, view);
                    } catch (error) {
                        console.error('[Slack] Failed to open edit modal:', error.message);
                        if (responseUrl) {
                            try {
                                await sendSlackResponse(
                                    responseUrl,
                                    `Unable to open edit modal for ${eventTitle}: ${error.message}`
                                );
                            } catch (responseError) {
                                console.error('[Slack] Failed to notify user about modal error:', responseError.message);
                            }
                        }
                    }
                    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
                }
                
                if (actionId === 'scouts_request_approve') {
                    console.log('[Slack] Handling approve action');

                    const persistPayload = {
                        realm,
                        action: 'persist',
                        subject: eventData,
                        slackMetadata: {
                            channel,
                            ts,
                            responseUrl,
                            previewText,
                        },
                    };
                    console.log('[Debug] Persist payload to send to SQS:', JSON.stringify(persistPayload, null, 2));
                    
                    try {
                        await sendToScoutsRequestQueue(persistPayload);
                        if (responseUrl) {
                            const processingBlocks = [
                                {
                                    type: 'header',
                                    text: { type: 'plain_text', text: 'Processing persist request...', emoji: true },
                                },
                                {
                                    type: 'section',
                                    text: {
                                        type: 'mrkdwn',
                                        text: `⏳ Persisting *${eventTitle}*\n\nPlease wait while we process your request...`,
                                    },
                                },
                            ];
                            try {
                                await sendSlackResponse(responseUrl, `Processing persist request for ${eventTitle}`, processingBlocks);
                            } catch (responseError) {
                                console.error('[Slack] Failed to replace message after persist enqueue:', responseError.message);
                            }
                        }
                    } catch (error) {
                        console.error('[Slack] Failed to send persist request to scoutsRequests queue:', error.message);
                    }
                    
                    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
                }
                
                if (actionId === 'scouts_request_hide') {
                    console.log('[Slack] Handling hide action');

                    const hidePayload = {
                        realm,
                        subject: {
                            ...eventData,
                            metadata: {
                                ...(eventData.metadata && typeof eventData.metadata === 'object' ? eventData.metadata : {}),
                                status: {
                                    ...((eventData.metadata && typeof eventData.metadata.status === 'object') ? eventData.metadata.status : {}),
                                    isHidden: true,
                                },
                            },
                        },
                        action: 'hidden',
                        slackMetadata: {
                            channel,
                            ts,
                            responseUrl,
                            previewText,
                        },
                    };
                    console.log('[Debug] Hide payload to send to SQS:', JSON.stringify(hidePayload, null, 2));
                    
                    try {
                        await sendToScoutsRequestQueue(hidePayload);
                        if (responseUrl) {
                            const processingBlocks = [
                                {
                                    type: 'header',
                                    text: { type: 'plain_text', text: 'Processing hide request...', emoji: true },
                                },
                                {
                                    type: 'section',
                                    text: {
                                        type: 'mrkdwn',
                                        text: `⏳ Hiding *${eventTitle}*\n\nPlease wait while we process your request...`,
                                    },
                                },
                            ];
                            try {
                                await sendSlackResponse(responseUrl, `Processing hide request for ${eventTitle}`, processingBlocks);
                            } catch (responseError) {
                                console.error('[Slack] Failed to replace message after hide enqueue:', responseError.message);
                            }
                        }
                    } catch (error) {
                        console.error('[Slack] Failed to send hide to scoutsRequests queue:', error.message);
                    }
                    
                    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
                }
                
                if (actionId === 'scouts_request_skip') {
                    console.log('[Slack] Handling skip action');
                    
                    if (responseUrl) {
                        try {
                            await sendSlackResponse(responseUrl, `Skipped ${eventTitle}, this will be checked again`);
                        } catch (responseError) {
                            console.error('[Slack] Failed to replace message for skip action:', responseError.message);
                        }
                    }
                    
                    return { statusCode: 200, body: JSON.stringify({ message: 'Request skipped' }) };
                }
                
                // NFC-specific actions
                if (actionId?.toLowerCase() === 'reject' && action.block_id === 'submit_decision_actions') {
                    console.log('[Slack] Handling NFC reject action');
                    let deviceId;
                    if (action.value) {
                        try {
                            const parsedValue = JSON.parse(action.value);
                            deviceId = parsedValue.deviceId;
                        } catch {
                            deviceId = action.value;
                        }
                    }
                    
                    if (responseUrl) {
                        await sendSlackResponse(responseUrl, `NFC ID ${deviceId} ignored`);
                    }
                    
                    return { statusCode: 200, body: JSON.stringify({ message: 'NFC ID ignored' }) };
                }
                
                if (actionId?.toLowerCase() === 'submitdevicename' && action.block_id === 'submit_decision_actions') {
                    console.log('[Slack] Handling NFC submit device name action');
                    let deviceId, deviceName;
                    
                    if (action.value) {
                        try {
                            const parsedValue = JSON.parse(action.value);
                            deviceId = parsedValue.deviceId;
                            deviceName = parsedValue.deviceName;
                        } catch {
                            deviceId = action.value;
                        }
                    }
                    
                    // Retrieve deviceName from state
                    deviceName = parsedPayload.state?.values?.device_name_input_section?.device_name?.value;
                    
                    if (deviceName && deviceName.length > 3) {
                        console.log(`[Slack] SubmitDeviceName action detected with device name: ${deviceName}`);
                        
                        if (responseUrl) {
                            await sendSlackResponse(responseUrl, `Processing ${deviceName} for ID ${deviceId}`);
                        }
                        
                        const nfcPayload = {
                            realm: 'nfc',
                            subject: parsedPayload,
                            action: 'modal'
                        };
                        
                        try {
                            await sendToNfcQueue(nfcPayload);
                        } catch (error) {
                            console.error('[Slack] Failed to send to NFC queue:', error.message);
                        }
                        
                        return { statusCode: 200, body: JSON.stringify({ message: 'Device name submitted' }) };
                    } else {
                        console.log(`[Slack] Device name '${deviceName}' is too short.`);
                        
                        if (responseUrl) {
                            await sendSlackResponse(responseUrl, `Device name requires at least three characters`);
                        }
                        
                        return { statusCode: 400, body: JSON.stringify({ message: 'Device name requires at least three characters' }) };
                    }
                }
                
                if (actionId?.toLowerCase() === 'replacebattery' && action.block_id === 'submit_decision_actions') {
                    console.log('[Slack] Handling NFC replace battery action');
                    let deviceName;
                    
                    if (action.value) {
                        try {
                            const parsedValue = JSON.parse(action.value);
                            deviceName = parsedValue.deviceName;
                        } catch {
                            // deviceName not available in value
                        }
                    }
                    
                    if (responseUrl) {
                        await sendSlackResponse(responseUrl, `Logging battery replacement for ${deviceName}`);
                    }
                    
                    return { statusCode: 200, body: JSON.stringify({ message: 'Battery replacement logged' }) };
                }
            }
        }

        if (parsedPayload.type === 'view_submission' && parsedPayload.view?.callback_id === 'scouts_edit_modal') {
            const responsePayload = await handleEditModalSubmission(parsedPayload);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(responsePayload ?? { response_action: 'clear' }),
            };
        }

        if (parsedPayload.type === 'view_closed' && parsedPayload.view?.callback_id === 'scouts_edit_modal') {
            await handleEditModalClosed(parsedPayload);
            return { statusCode: 200, body: '' };
        }

        // For all other cases, send immediate "processing..." response and asynchronously
        console.log('[Slack] Sending immediate processing response for non-action request');
        
        const processingResponse = {
            response_type: 'ephemeral',
            text: 'Processing...',
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: '⏳ Processing your request...'
                    }
                }
            ]
        };
        
        // Send to scoutsRequest queue asynchronously
        // For slack interactions, send to scoutsRequest queue with filtered subject
        const actions = parsedPayload.actions?.map(action => ({
            ...action,
            value: action.value ? JSON.parse(action.value) : action.value
        })) || [];
        
        const fallbackPayload = {
            realm: 'slack',
            subject: {
                actions: actions
            },
            action: parsedPayload.actions?.[0]?.action_id || 'interaction',
            channel: parsedPayload.channel,
            response_url: parsedPayload.response_url
        };
        try {
            await sendToScoutsRequestQueue(fallbackPayload);
        } catch (error) {
            console.error('[Slack] Failed to send fallback to scoutsRequests queue:', error.message);
        }
        
        return { statusCode: 200, body: JSON.stringify(processingResponse) };

    } catch (error) {
        console.error('[Slack] Handler error:', error.message);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
}
