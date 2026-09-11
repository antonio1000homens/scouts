import crypto from 'crypto';
import { getRequiredSecret } from '/opt/nodejs/ssm-secrets.mjs';
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

function forbidden(message) {
    return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: message }),
    };
}

export async function lambdaHandler(event, context) {
    if (looksLikeSlackRequest(event)) {
        const rawBody = getRawBody(event);
        if (!await verifyWorkerProof(event, rawBody)) {
            console.warn('[Slack ingress] Rejected request without valid Cloudflare worker proof');
            return forbidden('Forbidden: invalid Slack ingress proof');
        }
    }

    return downstreamHandler(event, context);
}
