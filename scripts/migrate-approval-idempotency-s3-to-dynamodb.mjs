#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lambdas/shared-layer/nodejs/package.json'));
const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} = require('@aws-sdk/client-dynamodb');
const {
  GetObjectCommand,
  paginateListObjectsV2,
  S3Client,
} = require('@aws-sdk/client-s3');

const EXPECTED_ACCOUNT = '553490163883';
const REGION = process.env.AWS_REGION || 'eu-west-2';
const BUCKET = process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const PREFIX = 'runtime/approval-idempotency/';
const TABLE = process.env.SCOUTS_REQUEST_ACTIVITY_TABLE_NAME || 'scouts-request-activity';
const APPLY = process.argv.includes('--apply');
const CONFIRMED_ACCOUNT = process.argv.includes(`--confirm-account=${EXPECTED_ACCOUNT}`)
  || process.argv.some((value, index) => value === '--confirm-account' && process.argv[index + 1] === EXPECTED_ACCOUNT);

const s3 = new S3Client({ region: REGION });
const dynamodb = new DynamoDBClient({ region: REGION });

function fail(message) {
  throw new Error(message);
}

function loadAwsCliCredentials() {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return;
  const profile = process.env.AWS_PROFILE || 'scouts';
  const credentials = JSON.parse(execFileSync('aws', [
    'configure', 'export-credentials', '--profile', profile, '--format', 'process',
  ], { encoding: 'utf8' }));
  process.env.AWS_ACCESS_KEY_ID = credentials.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = credentials.SecretAccessKey;
  if (credentials.SessionToken) process.env.AWS_SESSION_TOKEN = credentials.SessionToken;
  else delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
}

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function legacyKeyToIdempotencyKey(key) {
  if (!key.startsWith(PREFIX) || !key.endsWith('.json')) return '';
  return key.slice(PREFIX.length, -'.json'.length);
}

function buildItem(idempotencyKey, record, etag, lastModified) {
  const claimedAt = readText(record.claimedAt) || readText(record.updatedAt) || lastModified.toISOString();
  const updatedAt = readText(record.updatedAt) || claimedAt;
  const state = readText(record.state);
  if (!['claimed', 'queued', 'completed'].includes(state)) fail('Legacy claim has an unsupported state');
  if (!readText(record.rootRequestId) || !readText(record.revision) || !readText(record.hex)) {
    fail('Legacy claim is missing required identity fields');
  }
  if (!/^[a-f0-9]+$/i.test(readText(record.hex))) fail('Legacy claim HEX is invalid');

  const item = {
    requestId: { S: `approval-idempotency#${idempotencyKey}` },
    feed: { S: 'approval-idempotency' },
    idempotencyKey: { S: idempotencyKey },
    state: { S: state },
    rootRequestId: { S: readText(record.rootRequestId) },
    revision: { S: readText(record.revision) },
    hex: { S: readText(record.hex).toLowerCase() },
    requiresGeneratedImage: { BOOL: record.requiresGeneratedImage === true },
    claimedAt: { S: claimedAt },
    createdAt: { S: claimedAt },
    updatedAt: { S: updatedAt },
    sourceETag: { S: etag },
    legacyKey: { S: `${PREFIX}${idempotencyKey}.json` },
  };
  if (record.takeoverOf) item.takeoverOf = { S: readText(record.takeoverOf) };
  if (record.result && typeof record.result === 'object') item.resultJson = { S: JSON.stringify(record.result) };
  return item;
}

function sameIdentity(existing, expected) {
  return existing?.idempotencyKey?.S === expected.idempotencyKey.S
    && existing?.rootRequestId?.S === expected.rootRequestId.S
    && existing?.revision?.S === expected.revision.S
    && existing?.hex?.S === expected.hex.S;
}

async function readExisting(idempotencyKey) {
  const response = await dynamodb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { requestId: { S: `approval-idempotency#${idempotencyKey}` } },
    ConsistentRead: true,
  }));
  return response?.Item || null;
}

async function collectLegacyClaims() {
  const claims = [];
  for await (const page of paginateListObjectsV2({ client: s3 }, { Bucket: BUCKET, Prefix: PREFIX })) {
    for (const object of page.Contents || []) {
      const key = readText(object.Key);
      const idempotencyKey = legacyKeyToIdempotencyKey(key);
      if (!idempotencyKey) fail('S3 prefix contained a key outside the expected JSON shape');
      if (!/^[a-f0-9]{64}$/i.test(idempotencyKey)) fail('Legacy approval idempotency key is not a SHA-256 digest');
      const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      const body = await response.Body.transformToString();
      let record;
      try { record = JSON.parse(body); } catch { fail('Legacy claim JSON is invalid'); }
      if (readText(record.idempotencyKey) !== idempotencyKey) fail('Legacy key and record idempotency key do not match');
      claims.push({
        idempotencyKey,
        record,
        item: buildItem(idempotencyKey, record, readText(response.ETag), object.LastModified || new Date()),
      });
    }
  }
  return claims;
}

async function main() {
  if (APPLY && !CONFIRMED_ACCOUNT) {
    fail(`Apply mode requires --confirm-account ${EXPECTED_ACCOUNT}`);
  }

  loadAwsCliCredentials();
  const identity = JSON.parse(execFileSync('aws', [
    'sts', 'get-caller-identity', '--region', REGION, '--output', 'json',
  ], { encoding: 'utf8' }));
  if (identity?.Account !== EXPECTED_ACCOUNT) {
    fail(`Unexpected AWS account ${identity?.Account || 'unknown'}; expected ${EXPECTED_ACCOUNT}`);
  }

  const claims = await collectLegacyClaims();
  const counts = { objects: claims.length, claimed: 0, queued: 0, completed: 0, imported: 0, alreadyPresent: 0, conflicts: 0 };
  const conflicts = [];

  for (const claim of claims) {
    counts[claim.record.state] += 1;
    const existing = await readExisting(claim.idempotencyKey);
    if (!existing) {
      if (!APPLY) {
        counts.imported += 1;
        continue;
      }
      try {
        await dynamodb.send(new PutItemCommand({
          TableName: TABLE,
          Item: claim.item,
          ConditionExpression: 'attribute_not_exists(requestId)',
        }));
        counts.imported += 1;
      } catch (error) {
        if (error?.name !== 'ConditionalCheckFailedException') throw error;
        const winner = await readExisting(claim.idempotencyKey);
        if (!sameIdentity(winner, claim.item)) {
          counts.conflicts += 1;
          conflicts.push('identity_conflict');
        } else {
          counts.alreadyPresent += 1;
        }
      }
      continue;
    }

    if (!sameIdentity(existing, claim.item)) {
      counts.conflicts += 1;
      conflicts.push('identity_conflict');
      continue;
    }

    const existingUpdatedAt = readText(existing.updatedAt?.S);
    const legacyUpdatedAt = readText(claim.item.updatedAt?.S);
    const existingState = readText(existing.state?.S);
    const legacyState = readText(claim.item.state?.S);
    if (existingState === legacyState && existingUpdatedAt === legacyUpdatedAt) {
      counts.alreadyPresent += 1;
      continue;
    }

    if (APPLY && existingUpdatedAt === legacyUpdatedAt) {
      conflicts.push('equal_timestamp_state_conflict');
      counts.conflicts += 1;
      continue;
    }
    if (APPLY && legacyUpdatedAt > existingUpdatedAt) {
      conflicts.push('newer_legacy_record_requires_review');
      counts.conflicts += 1;
      continue;
    }
    counts.alreadyPresent += 1;
  }

  const output = {
    account: identity.Account,
    region: REGION,
    table: TABLE,
    mode: APPLY ? 'apply' : 'dry-run',
    ...counts,
    conflicts: conflicts.length,
    ttl: 'expiresAt omitted to preserve the legacy no-expiry replay contract',
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (conflicts.length) fail('Legacy approval claims need reconciliation before cutover');
}

main().catch((error) => {
  process.stderr.write(`Approval idempotency migration failed: ${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
