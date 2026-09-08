import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const TARGET_BUCKET = process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const CONFIG_KEY = process.env.SCOUTS_SCHEDULED_REFRESH_CONFIG_KEY || 'runtime/scheduledRefresh.json';
const SCHEDULE_EXPRESSION = process.env.SCOUTS_SCHEDULE_EXPRESSION || 'rate(30 minutes)';
const MAX_QUEUE_PUBLISHES = Math.max(0, Number.parseInt(process.env.SCOUTS_SCHEDULED_REFRESH_MAX_EVENTS || '0', 10) || 0);
const DEFAULT_ENABLED = !['false', '0', 'no', 'off'].includes(
  String(process.env.SCOUTS_SCHEDULED_REFRESH_DEFAULT_ENABLED || 'true').trim().toLowerCase(),
);

const s3 = new S3Client({ region: REGION });

function isMissingKey(error) {
  return error?.name === 'NoSuchKey'
    || error?.name === 'NotFound'
    || error?.Code === 'NoSuchKey'
    || Number(error?.$metadata?.httpStatusCode) === 404;
}

function normaliseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  const token = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(token)) return true;
  if (['false', '0', 'no', 'off'].includes(token)) return false;
  return fallback;
}

function defaultSettings() {
  return {
    enabled: DEFAULT_ENABLED,
    scheduleExpression: SCHEDULE_EXPRESSION,
    maxQueuePublishesPerRun: MAX_QUEUE_PUBLISHES,
    configSource: 'default',
    updatedAt: null,
    updatedBy: null,
  };
}

export async function getScheduledRefreshSettings() {
  let stored = null;
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: TARGET_BUCKET, Key: CONFIG_KEY }));
    const raw = await response.Body.transformToString();
    stored = JSON.parse(raw);
  } catch (error) {
    if (!isMissingKey(error)) throw error;
  }

  const defaults = defaultSettings();
  if (!stored || typeof stored !== 'object') return defaults;

  return {
    enabled: normaliseBoolean(stored.enabled, defaults.enabled),
    scheduleExpression: SCHEDULE_EXPRESSION,
    maxQueuePublishesPerRun: MAX_QUEUE_PUBLISHES,
    configSource: 's3',
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null,
  };
}

export async function setScheduledRefreshEnabled(enabled, updatedBy = 'admin') {
  const next = {
    enabled: Boolean(enabled),
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy || 'admin').trim() || 'admin',
  };

  await s3.send(new PutObjectCommand({
    Bucket: TARGET_BUCKET,
    Key: CONFIG_KEY,
    Body: JSON.stringify(next, null, 2),
    ContentType: 'application/json',
    CacheControl: 'no-store',
  }));

  return {
    ...defaultSettings(),
    ...next,
    configSource: 's3',
  };
}

export function isScheduledRefreshInvocation(event) {
  return event?._scheduledRefresh === true
    || String(event?._scheduledRefresh || '').trim().toLowerCase() === 'true';
}
