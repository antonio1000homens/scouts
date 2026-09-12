import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getRequiredSecret } from '/opt/nodejs/ssm-secrets.mjs';
import { buildEventReviewSnapshot } from '/opt/nodejs/event-review.mjs';

const AWS_REGION = process.env.AWS_REGION || 'eu-west-2';
const TARGET_BUCKET = String(process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883').trim();
const APPROVAL_METADATA_PREFIX = String(process.env.APPROVAL_METADATA_PREFIX || 'approvals').trim() || 'approvals';
const SLACK_CHAT_UPDATE_URL = String(process.env.SLACK_CHAT_UPDATE_URL || 'https://slack.com/api/chat.update').trim();
const S3_WEBSITE_BASE_URL = String(
  process.env.S3_WEBSITE_BASE_URL || `https://${TARGET_BUCKET}.s3.${AWS_REGION}.amazonaws.com`,
).replace(/\/$/, '');
const s3 = new S3Client({ region: AWS_REGION });

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function parseRecord(record) {
  if (!record || record.eventSource !== 'aws:sqs') return null;
  try { return typeof record.body === 'string' ? JSON.parse(record.body) : record.body; } catch { return null; }
}

function hexOf(message) {
  const direct = text(message?.requestHex || message?.hex).toLowerCase();
  if (direct && /^[0-9a-f]+$/i.test(direct)) return direct;
  const subject = message?.subject;
  if (typeof subject === 'string') {
    const candidate = subject.trim().toLowerCase();
    return candidate && /^[0-9a-f]+$/i.test(candidate) ? candidate : '';
  }
  if (subject && typeof subject === 'object') {
    const candidate = text(subject?.metadata?.hex || subject?.hex).toLowerCase();
    return candidate && /^[0-9a-f]+$/i.test(candidate) ? candidate : '';
  }
  return '';
}

function canProduceLegacyReview(message) {
  const realm = text(message?.realm);
  return ['tagline', 'imageTheme', 'image'].includes(realm);
}

function metadataKey(hex) {
  return `${APPROVAL_METADATA_PREFIX}/${hex}/approval.json`;
}

async function loadPendingMetadata(hex) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: TARGET_BUCKET, Key: metadataKey(hex) }));
    const metadata = JSON.parse(await response.Body.transformToString());
    return text(metadata?.status).toUpperCase() === 'PENDING' ? metadata : null;
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.name === 'NotFound' || Number(error?.$metadata?.httpStatusCode) === 404) return null;
    throw error;
  }
}

function publicImageUrl(value) {
  const imageUrl = text(value);
  if (!imageUrl) return null;
  if (/^https?:\/\//i.test(imageUrl)) return imageUrl;
  return `${S3_WEBSITE_BASE_URL}/${imageUrl.replace(/^\/+/, '')}`;
}

function approvalActionValue(review) {
  const value = JSON.stringify({
    event: { hex: review.hex },
    action: 'approve_shown_changes',
    reviewRevision: review.revision,
    reviewReference: true,
  });
  if (value.length > 2000) {
    throw new Error('Legacy approval action value exceeds Slack 2000-character limit');
  }
  return value;
}

function canonicalReviewBlocks(event) {
  const review = buildEventReviewSnapshot(event);
  const title = review.title || 'Scouts event';
  const imageUrl = publicImageUrl(review.imageUrl);
  const fields = [
    `• Tagline: ${review.tagline || 'Not set'}`,
    `• Image theme: ${review.imageTheme || 'Not set'}`,
    `• Image: ${review.imageUrl ? 'Present' : 'Not set'}`,
    `• Visibility: ${review.isHidden ? 'Hidden' : 'Visible'}`,
  ].join('\n');
  return {
    text: `Review shown changes: ${title}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Review shown changes', emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${title}*\n${fields}` },
      },
      ...(imageUrl ? [{ type: 'image', image_url: imageUrl, alt_text: `Image for ${title}` }] : []),
      {
        type: 'actions',
        block_id: 'scouts_request_actions',
        elements: [
          {
            type: 'button',
            action_id: 'scouts_request_approve',
            text: { type: 'plain_text', text: 'Approve shown changes', emoji: true },
            style: 'primary',
            value: approvalActionValue(review),
          },
        ],
      },
    ],
  };
}

async function updateSlackCard(metadata) {
  const channel = text(metadata?.channel);
  const ts = text(metadata?.ts);
  const event = metadata?.event && typeof metadata.event === 'object' ? metadata.event : null;
  if (!channel || !ts || !event) return false;

  const payload = canonicalReviewBlocks(event);
  const token = await getRequiredSecret('SLACK_BOT_TOKEN_PARAMETER');
  const response = await fetch(SLACK_CHAT_UPDATE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, ts, ...payload }),
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || body?.ok !== true) {
    throw new Error(`Slack legacy review normalization failed: ${body?.error || `HTTP ${response.status}`}`);
  }
  return true;
}

export async function normalizeLegacyApprovalCards(records = []) {
  const hexes = new Set();
  for (const record of records) {
    const message = parseRecord(record);
    if (!message || !canProduceLegacyReview(message)) continue;
    const hex = hexOf(message);
    if (hex) hexes.add(hex);
  }

  for (const hex of hexes) {
    try {
      const metadata = await loadPendingMetadata(hex);
      if (!metadata) continue;
      await updateSlackCard(metadata);
      console.log('[Issue91] Normalized reachable legacy Slack review card', { hex });
    } catch (error) {
      console.warn('[Issue91] Legacy Slack review normalization failed', { hex, error: error?.message || String(error) });
    }
  }
}