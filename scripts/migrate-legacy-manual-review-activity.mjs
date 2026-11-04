#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildReviewManifest, validateReviewManifestPath, writeReviewManifest } from './legacy-review-manifest.mjs';

const ACCOUNT_ID = '553490163883';
const REGION = 'eu-west-2';
const STATE_TABLE = 'scouts-enrichment-state';
const ACTIVITY_TABLE = 'scouts-request-activity';
const DATA_BUCKET = 'scouts-2ndtolworth-prod-553490163883';
const STAGES = new Set(['tagline', 'imageTheme', 'image']);
const PAGE_SIZE = 2;
const PAGE_DELAY_MS = 1000;
const profileIndex = process.argv.indexOf('--profile');
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : process.env.AWS_PROFILE;
const maxScanIndex = process.argv.indexOf('--max-scan-items');
const rawMaxScanItems = Number(maxScanIndex >= 0 ? process.argv[maxScanIndex + 1] : 500);
if (!Number.isInteger(rawMaxScanItems) || rawMaxScanItems < 1) {
  throw new Error('--max-scan-items must be a positive integer');
}
const maxScanItems = Math.min(10000, rawMaxScanItems);
const apply = process.argv.includes('--apply');
const manifestIndex = process.argv.indexOf('--review-manifest');
const reviewManifestPath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : '';
const ackIndex = process.argv.indexOf('--ack-account');
const acknowledgedAccount = ackIndex >= 0 ? process.argv[ackIndex + 1] : '';
const env = { ...process.env, AWS_PROFILE: profile, AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION };

if (process.argv.includes('--help')) {
  process.stdout.write([
    'Dry run: node scripts/migrate-legacy-manual-review-activity.mjs [--profile <profile>] [--max-scan-items <count>] [--review-manifest <path-outside-repo>]',
    `Apply:    node scripts/migrate-legacy-manual-review-activity.mjs --profile <profile> --max-scan-items <count> --apply --ack-account ${ACCOUNT_ID}`,
    'Apply mode requires a complete scan. Rows with missing or invalid canonical events are imported as non-retryable needs_attention records.',
  ].join('\n') + '\n');
  process.exit(0);
}

if (!profile) throw new Error('Set AWS_PROFILE or pass --profile for the intended AWS account');
if (apply && acknowledgedAccount !== ACCOUNT_ID) {
  throw new Error(`Refusing writes: apply mode also requires --ack-account ${ACCOUNT_ID}`);
}
if (manifestIndex >= 0 && (!reviewManifestPath || reviewManifestPath.startsWith('--'))) {
  throw new Error('--review-manifest requires a path outside the repository');
}
if (reviewManifestPath && apply) {
  throw new Error('--review-manifest is dry-run only; remove --apply');
}
if (reviewManifestPath) validateReviewManifestPath(reviewManifestPath);

function awsRaw(args, { maxBuffer = 1024 * 1024 } = {}) {
  try {
    return execFileSync('aws', [...args, '--region', REGION, '--no-cli-pager'], {
      env,
      encoding: 'utf8',
      maxBuffer,
    });
  } catch (error) {
    const safeError = new Error('AWS CLI operation failed');
    safeError.awsStderr = String(error?.stderr || '');
    throw safeError;
  }
}

function awsJson(args, { allowEmpty = false } = {}) {
  const output = awsRaw([...args, '--output', 'json']);
  // AWS CLI emits no bytes for an empty DynamoDB GetItem response in some
  // CLI versions. That is a valid “not found” result for this preflight.
  if (allowEmpty && !output.trim()) return {};
  return JSON.parse(output);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readString(item, name) {
  return typeof item?.[name]?.S === 'string' ? item[name].S : '';
}

function normaliseHex(value) {
  const hex = String(value || '').trim().toLowerCase();
  return hex.length > 0 && hex.length <= 512 && hex.length % 2 === 0 && /^[0-9a-f]+$/.test(hex)
    ? hex
    : '';
}

function activityIdFor(hex, stage) {
  const digest = createHash('sha256').update(`${hex}|${stage}`).digest('hex');
  return `legacy-manual-review#${digest}`;
}

function missingObject(error) {
  return /\b404\b|NoSuchKey|Not Found/i.test(String(error?.awsStderr || error?.stderr || error?.message || error));
}

function loadCanonicalEvent(hex) {
  let raw;
  try {
    raw = execFileSync('aws', [
      's3', 'cp', `s3://${DATA_BUCKET}/events/${hex}.json`, '-', '--only-show-errors',
      '--region', REGION, '--no-cli-pager',
    ], { env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (missingObject(error)) return { status: 'missing', event: null };
    throw new Error('Unable to read a canonical event during migration preflight');
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return { status: 'invalid', event: null };
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { status: 'invalid', event: null };
  const storedHex = String(event?.metadata?.hex || event?.hex || '').trim().toLowerCase();
  if (storedHex && storedHex !== hex) return { status: 'invalid', event: null };
  const title = String(event.title || event.summary || '').trim();
  if (!title) return { status: 'invalid', event: null };
  return { status: 'present', event: { title } };
}

function migrationItem(candidate, canonicalStatus, title, now) {
  const { hex, stage, oldUpdatedAt, lastErrorType } = candidate;
  const id = activityIdFor(hex, stage);
  const retryable = canonicalStatus === 'present';
  const state = retryable ? 'manual_review' : 'needs_attention';
  const activityStage = retryable ? stage : 'legacy_orphaned_event';
  const failureType = retryable
    ? `LEGACY_${String(lastErrorType || 'MANUAL_REVIEW').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 48)}`
    : canonicalStatus === 'missing' ? 'LEGACY_CANONICAL_EVENT_MISSING' : 'LEGACY_CANONICAL_EVENT_INVALID';
  const failureMessage = retryable
    ? 'Imported from durable manual-review state. Review the canonical event before retrying.'
    : canonicalStatus === 'missing'
      ? 'Canonical event is missing; recovery is unavailable and no retry was queued.'
      : 'Canonical event is invalid or does not match this HEX; recovery is unavailable and no retry was queued.';
  const timelineAt = Number.isFinite(Date.parse(oldUpdatedAt)) ? new Date(oldUpdatedAt).toISOString() : now;
  const timeline = [{ state, stage: activityStage, at: timelineAt, source: 'legacy-enrichment-state' }];
  if (timelineAt !== now) timeline.push({ state, stage: activityStage, at: now, source: 'legacy-manual-review-import' });

  const item = {
    requestId: { S: id },
    rootRequestId: { S: id },
    feed: { S: 'activity' },
    hex: { S: hex },
    state: { S: state },
    stage: { S: activityStage },
    action: { S: 'legacy-manual-review-import' },
    createdAt: { S: timelineAt },
    updatedAt: { S: now },
    priority: { N: '100' },
    terminal: { S: 'true' },
    failureType: { S: failureType },
    failureMessage: { S: failureMessage },
    timeline: { L: timeline.map((entry) => ({ S: JSON.stringify(entry) })) },
    migrationSource: { S: STATE_TABLE },
  };
  if (title) item.title = { S: title };
  // Deliberately omit expiresAt so both retryable and orphaned reviews remain
  // visible until an explicit recovery or archival decision.
  return { id, hex, stage, state, retryable, sourceUpdatedAt: oldUpdatedAt, item };
}

const identity = awsJson(['sts', 'get-caller-identity']);
if (identity.Account !== ACCOUNT_ID) {
  throw new Error(`Refusing migration: profile ${profile} resolved to account ${identity.Account}, expected ${ACCOUNT_ID}`);
}

const scanned = [];
let evaluated = 0;
let consumedCapacityUnits = 0;
let exclusiveStartKey;
while (evaluated < maxScanItems) {
  const pageLimit = Math.min(PAGE_SIZE, maxScanItems - evaluated);
  const args = [
    'dynamodb', 'scan', '--table-name', STATE_TABLE,
    '--filter-expression', '#state = :manual',
    '--projection-expression', '#hex,#stage,#state,#updatedAt,#lastErrorType',
    '--expression-attribute-names', '{"#hex":"hex","#stage":"stage","#state":"state","#updatedAt":"updatedAt","#lastErrorType":"lastErrorType"}',
    '--expression-attribute-values', '{":manual":{"S":"manual_review"}}',
    '--consistent-read', '--limit', String(pageLimit), '--return-consumed-capacity', 'TOTAL',
  ];
  if (exclusiveStartKey) args.push('--exclusive-start-key', JSON.stringify(exclusiveStartKey));
  const page = awsJson(args);
  scanned.push(...(page.Items || []));
  evaluated += Number(page.ScannedCount || page.Count || 0);
  consumedCapacityUnits += Number(page.ConsumedCapacity?.CapacityUnits || 0);
  exclusiveStartKey = page.LastEvaluatedKey;
  if (!exclusiveStartKey) break;
  sleep(PAGE_DELAY_MS);
}

const scanComplete = !exclusiveStartKey;
if (apply && !scanComplete) {
  throw new Error(`Refusing partial migration: scan reached max-scan-items=${maxScanItems} before completion`);
}

const candidates = scanned.map((item) => {
  const hex = normaliseHex(readString(item, 'hex'));
  const stage = readString(item, 'stage');
  if (!hex || !STAGES.has(stage) || readString(item, 'state') !== 'manual_review') {
    throw new Error('Refusing migration: found a manual-review row with invalid HEX, state, or stage');
  }
  const oldUpdatedAt = readString(item, 'updatedAt');
  if (!Number.isFinite(Date.parse(oldUpdatedAt))) {
    throw new Error('Refusing migration: found a manual-review row without a valid updatedAt value');
  }
  return {
    hex,
    stage,
    oldUpdatedAt,
    lastErrorType: readString(item, 'lastErrorType'),
  };
});

// Preflight every canonical object and existing destination before any writes.
// Any non-404 S3 failure aborts here, so apply mode cannot leave a partial
// import because of an incomplete source classification.
const now = new Date().toISOString();
const plans = [];
for (const candidate of candidates) {
  const canonical = loadCanonicalEvent(candidate.hex);
  const planned = migrationItem(candidate, canonical.status, canonical.event?.title || '', now);
  const existing = awsJson([
    'dynamodb', 'get-item', '--table-name', ACTIVITY_TABLE,
    '--key', JSON.stringify({ requestId: { S: planned.id } }),
    '--consistent-read', '--projection-expression', 'requestId',
  ], { allowEmpty: true }).Item;
  plans.push({ ...planned, alreadyExists: Boolean(existing) });
}

const summary = {
  account: identity.Account,
  region: REGION,
  profile,
  mode: apply ? 'apply' : 'dry-run',
  sourceTable: STATE_TABLE,
  activityTable: ACTIVITY_TABLE,
  dataBucket: DATA_BUCKET,
  scan: { evaluated, matchingManualReviews: candidates.length, scanComplete, consumedCapacityUnits },
  classifications: { retryableEventBacked: 0, orphanedMissingEvent: 0, invalidCanonicalEvent: 0 },
  stages: {},
  wouldCreate: 0,
  alreadyExists: 0,
  created: 0,
  conditionalConflicts: 0,
};

let reviewManifestOutput;
if (reviewManifestPath) {
  const manifest = buildReviewManifest({
    account: identity.Account,
    region: REGION,
    generatedAt: now,
    plans,
  });
  reviewManifestOutput = writeReviewManifest(reviewManifestPath, manifest);
}

for (const plan of plans) {
  summary.stages[plan.stage] = (summary.stages[plan.stage] || 0) + 1;
  if (plan.retryable) summary.classifications.retryableEventBacked += 1;
  else if (plan.state === 'needs_attention' && plan.item.failureType.S.endsWith('_MISSING')) summary.classifications.orphanedMissingEvent += 1;
  else summary.classifications.invalidCanonicalEvent += 1;
  if (plan.alreadyExists) {
    summary.alreadyExists += 1;
    continue;
  }
  summary.wouldCreate += 1;
  if (!apply) continue;

  try {
    awsRaw([
      'dynamodb', 'transact-write-items', '--transact-items', JSON.stringify([
        {
          ConditionCheck: {
            TableName: STATE_TABLE,
            Key: { hex: { S: plan.hex }, stage: { S: plan.stage } },
            ConditionExpression: '#state = :manual AND #updatedAt = :updatedAt',
            ExpressionAttributeNames: { '#state': 'state', '#updatedAt': 'updatedAt' },
            ExpressionAttributeValues: {
              ':manual': { S: 'manual_review' },
              ':updatedAt': { S: plan.sourceUpdatedAt },
            },
          },
        },
        {
          Put: {
            TableName: ACTIVITY_TABLE,
            Item: plan.item,
            ConditionExpression: 'attribute_not_exists(requestId)',
          },
        },
      ]),
    ]);
    summary.created += 1;
    sleep(100);
  } catch (error) {
    if (/TransactionCanceledException|ConditionalCheckFailedException/.test(String(error?.awsStderr || error?.message || error))) {
      summary.conditionalConflicts += 1;
      continue;
    }
    throw new Error('Migration write failed; rerun the idempotent command after reviewing created/conditional-conflict counts');
  }
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (reviewManifestOutput) process.stderr.write(`Private review manifest written: ${reviewManifestOutput}\n`);
