import crypto from 'crypto';
import { getRequiredSecret } from '/opt/nodejs/ssm-secrets.mjs';
import { coordinateEventApproval } from '/opt/nodejs/approval-coordinator.mjs';
import { buildEventReviewSnapshot } from '/opt/nodejs/event-review.mjs';
import { lambdaHandler as downstreamHandler } from './slack-handler.mjs';

const SLACK_REQUEST_TTL_SECONDS = 60 * 5;
const WORKER_PROOF_TTL_SECONDS = 60;
const WORKER_PROOF_VERSION = 'v1';

function getHeader(headers, name) {
    if (!headers) return undefined;
    if (headers[name] !== undefined) return headers[name];
    const lower = name.toLowerCase();
    if (headers[lower] !== undefined) return headers[lower];
    const upper = name.toUpperCase();
    if (headers[upper] !== undefined) return headers[upper];
    return undefined;
}

function getRawBody(event) {
    const body = event?.body || '';
    return event?.isBase64Encoded
        ? Buffer.from(body, 'base64').toString('utf8')
        : body;
}

function looksLikeSlackRequest(event) {
    const headers = event?.headers || {};
    const signature = getHeader(headers, 'X-Slack-Signature');
    const contentType = String(getHeader(headers, 'Content-Type') || '').toLowerCase();
    return Boolean(signature) || contentType.includes('application/x-www-form-urlencoded');
}

function isFreshTimestamp(value, ttlSeconds) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp)) return false;
    return Math.abs(Math.floor(Date.now() / 1000) - timestamp) <= ttlSeconds;
}

function timingSafeEqual(left, right) {
    const leftBuffer = Buffer.from(left || '', 'utf8');
    const rightBuffer = Buffer.from(right || '', 'utf8');
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function verifyWorkerProof(event, rawBody) {
    const headers = event?.headers || {};
    const workerTimestamp = getHeader(headers, 'X-Scouts-Worker-Timestamp');
    const workerSignature = getHeader(headers, 'X-Scouts-Worker-Signature');
    const slackTimestamp = getHeader(headers, 'X-Slack-Request-Timestamp') || '';
    const slackSignature = getHeader(headers, 'X-Slack-Signature') || '';

    if (!workerTimestamp || !workerSignature) return false;
    if (!isFreshTimestamp(workerTimestamp, WORKER_PROOF_TTL_SECONDS)) return false;
    if (!isFreshTimestamp(slackTimestamp, SLACK_REQUEST_TTL_SECONDS)) return false;

    const signingSecret = await getRequiredSecret('SLACK_SIGNING_SECRET_PARAMETER');
    const proofPayload = `${WORKER_PROOF_VERSION}:${workerTimestamp}:${slackTimestamp}:${slackSignature}:${rawBody}`;
    const computed = `${WORKER_PROOF_VERSION}=${crypto
        .createHmac('sha256', signingSecret)
        .update(proofPayload)
        .digest('hex')}`;

    return timingSafeEqual(computed, workerSignature);
}

async function verifySlackSignature(event, rawBody) {
    const headers = event?.headers || {};
    const timestamp = getHeader(headers, 'X-Slack-Request-Timestamp');
    const received = getHeader(headers, 'X-Slack-Signature');
    if (!timestamp || !received || !isFreshTimestamp(timestamp, SLACK_REQUEST_TTL_SECONDS)) return false;
    const signingSecret = await getRequiredSecret('SLACK_SIGNING_SECRET_PARAMETER');
    const computed = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
    return timingSafeEqual(computed, received);
}

function forbidden(message) {
    return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: message }),
    };
}

function parseSlackPayload(rawBody) {
    const params = new URLSearchParams(rawBody || '');
    const payload = params.get('payload');
    return payload ? JSON.parse(payload) : null;
}

function parseActionValue(rawValue) {
    if (!rawValue) return { event: {}, meta: {} };
    try {
        const parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
        if (parsed?.event && typeof parsed.event === 'object') return { event: parsed.event, meta: parsed };
        return parsed && typeof parsed === 'object' ? { event: parsed, meta: {} } : { event: {}, meta: {} };
    } catch {
        return { event: {}, meta: {} };
    }
}

function decodePrivateEvent(value) {
    if (!value || typeof value !== 'string') return {};
    try {
        return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    } catch {
        return {};
    }
}

function clone(value) {
    return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : {};
}

function applyModalValues(event, payload) {
    const edited = clone(event);
    const values = payload?.view?.state?.values || {};
    const read = (blockId, actionId) => {
        const value = values?.[blockId]?.[actionId]?.value;
        if (value === undefined) return undefined;
        const trimmed = String(value).trim();
        return trimmed || null;
    };
    const tagline = read('ai_block', 'ai_input');
    const imageTheme = read('image_prompt_block', 'image_prompt_input');
    const imageUrl = read('image_url_block', 'image_url_input');
    const clears = new Set((values?.clear_input_block?.clear_selection?.selected_options || []).map((item) => item.value));

    edited.metadata = edited.metadata && typeof edited.metadata === 'object' ? edited.metadata : {};
    edited.metadata.image = edited.metadata.image && typeof edited.metadata.image === 'object'
        ? edited.metadata.image
        : (edited.image && typeof edited.image === 'object' ? { ...edited.image } : {});
    if (tagline !== undefined) edited.metadata.tagline = tagline;
    if (imageTheme !== undefined) edited.metadata.image.theme = imageTheme;
    if (imageUrl !== undefined) edited.metadata.image.url = imageUrl;
    if (clears.has('tagline')) edited.metadata.tagline = null;
    if (clears.has('image.theme')) edited.metadata.image.theme = null;
    if (clears.has('image.url')) edited.metadata.image.url = null;
    return edited;
}

async function replaceSlackMessage(responseUrl, text, blocks = null) {
    if (!responseUrl) return;
    const response = await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replace_original: true, text, ...(blocks ? { blocks } : {}) }),
    });
    if (!response.ok) throw new Error(`Slack response URL returned HTTP ${response.status}`);
}

function reviewBlocks(review, { stale = false, rootRequestId = null, generatedReview = false } = {}) {
    const title = review?.title || 'Scouts event';
    const imageUrl = review?.imageUrl || null;
    const actionValue = JSON.stringify({
        event: review,
        ...(rootRequestId ? { rootRequestId } : {}),
        reviewRevision: review?.revision || null,
        action: generatedReview ? 'approve_generated_image' : 'approve_shown_changes',
    });
    const fields = [
        `• Tagline: ${review?.tagline || 'Not set'}`,
        `• Image theme: ${review?.imageTheme || 'Not set'}`,
        `• Image: ${imageUrl ? 'Present' : 'Not set'}`,
        `• Visibility: ${review?.isHidden ? 'Hidden' : 'Visible'}`,
    ].join('\n');
    const header = stale
        ? (generatedReview ? 'Generated image review changed — refreshed' : 'Review changed — refreshed')
        : (generatedReview ? 'Generated image — final review required' : 'Review shown changes');
    return [
        {
            type: 'header',
            text: { type: 'plain_text', text: header, emoji: true },
        },
        { type: 'section', text: { type: 'mrkdwn', text: `*${title}*\n${fields}` } },
        ...(imageUrl && /^https?:\/\//i.test(imageUrl)
            ? [{ type: 'image', image_url: imageUrl, alt_text: `Image for ${title}` }]
            : []),
        {
            type: 'actions',
            elements: [{
                type: 'button',
                action_id: 'scouts_request_approve',
                text: { type: 'plain_text', text: generatedReview ? 'Approve generated image' : 'Approve shown changes', emoji: true },
                style: 'primary',
                value: actionValue,
            }],
        },
    ];
}

async function handleApprovalResult(result, {
    responseUrl,
    title,
    rootRequestId = null,
    generatedReview = false,
} = {}) {
    if (result.ok) {
        const text = result.requiresGeneratedImage
            ? `✅ Approved shown metadata for ${title}. Generating image — final review required.`
            : `✅ ${result.message || `Approved shown changes for ${title}.`}`;
        await replaceSlackMessage(responseUrl, text, [
            { type: 'section', text: { type: 'mrkdwn', text } },
            { type: 'context', elements: [{ type: 'mrkdwn', text: `Workflow: \`${result.rootRequestId}\`` }] },
        ]).catch((error) => console.warn('[SlackApproval] Unable to replace accepted review message', error?.message || error));
        return;
    }
    if (result.statusCode === 409 && result.currentReview) {
        await replaceSlackMessage(
            responseUrl,
            `Review changed for ${result.currentReview.title || title}. Please review the refreshed values.`,
            reviewBlocks(result.currentReview, { stale: true, rootRequestId, generatedReview }),
        ).catch((error) => console.warn('[SlackApproval] Unable to refresh stale review message', error?.message || error));
        return;
    }
    await replaceSlackMessage(responseUrl, `Unable to approve ${title}: ${result.error || 'approval failed'}`)
        .catch((error) => console.warn('[SlackApproval] Unable to publish approval error', error?.message || error));
}

async function interceptApprovalInteraction(parsedPayload) {
    if (parsedPayload?.type === 'block_actions') {
        const action = parsedPayload.actions?.[0];
        if (action?.action_id !== 'scouts_request_approve') return null;
        const { event, meta } = parseActionValue(action.value);
        const snapshot = buildEventReviewSnapshot(event);
        const rootRequestId = meta?.rootRequestId || meta?.operationId || null;
        const generatedReview = meta?.action === 'approve_generated_image';
        const title = snapshot.title || 'Scouts event';
        const result = await coordinateEventApproval({
            reviewSnapshot: snapshot,
            baseRevision: meta?.baseRevision || meta?.reviewRevision || snapshot.revision,
            rootRequestId,
            source: 'slack-approval',
            childMetadata: {
                channel: parsedPayload.container?.channel_id || parsedPayload.channel?.id || null,
                ts: parsedPayload.container?.message_ts || parsedPayload.message?.ts || null,
                responseUrl: parsedPayload.response_url || null,
            },
        });
        await handleApprovalResult(result, {
            responseUrl: parsedPayload.response_url,
            title,
            rootRequestId,
            generatedReview,
        });
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
    }

    if (parsedPayload?.type === 'view_submission' && parsedPayload.view?.callback_id === 'scouts_edit_modal') {
        let metadata = {};
        try { metadata = JSON.parse(parsedPayload.view.private_metadata || '{}'); } catch {}
        const original = decodePrivateEvent(metadata.event);
        const baseSnapshot = buildEventReviewSnapshot(original);
        const editedSnapshot = buildEventReviewSnapshot(applyModalValues(original, parsedPayload));
        const rootRequestId = metadata.rootRequestId || metadata.operationId || null;
        const result = await coordinateEventApproval({
            reviewSnapshot: editedSnapshot,
            baseRevision: baseSnapshot.revision,
            rootRequestId,
            source: 'slack-approval-modal',
            childMetadata: {
                channel: metadata.channel || null,
                ts: metadata.ts || null,
                responseUrl: metadata.responseUrl || null,
            },
        });
        await handleApprovalResult(result, {
            responseUrl: metadata.responseUrl,
            title: editedSnapshot.title || baseSnapshot.title || 'Scouts event',
            rootRequestId,
            generatedReview: metadata.action === 'approve_generated_image',
        });
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response_action: 'clear' }),
        };
    }
    return null;
}

export async function lambdaHandler(event, context) {
    if (!looksLikeSlackRequest(event)) {
        return downstreamHandler(event, context);
    }

    const rawBody = getRawBody(event);
    if (!await verifyWorkerProof(event, rawBody)) {
        console.warn('[Slack ingress] Rejected request without valid Cloudflare worker proof');
        return forbidden('Forbidden: invalid Slack ingress proof');
    }
    if (!await verifySlackSignature(event, rawBody)) {
        console.warn('[Slack ingress] Rejected approval-capable request with invalid Slack signature');
        return forbidden('Forbidden: invalid Slack signature');
    }

    let parsedPayload = null;
    try { parsedPayload = parseSlackPayload(rawBody); } catch {}
    if (parsedPayload) {
        try {
            const intercepted = await interceptApprovalInteraction(parsedPayload);
            if (intercepted) return intercepted;
        } catch (error) {
            console.error('[SlackApproval] Approval interception failed', error?.message || error);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ok: false, error: 'Approval workflow unavailable' }),
            };
        }
    }

    return downstreamHandler(event, context);
}