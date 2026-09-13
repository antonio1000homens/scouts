#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { isDeepStrictEqual } from 'node:util';
import os from 'os';
import path from 'path';
import {
  assertCanonicalEventDocument,
  buildCanonicalEventDocument,
  titleToHex,
} from '../shared-layer/nodejs/canonical-event.mjs';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const BUCKET = process.env.BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const AWS_PROFILE = (process.env.AWS_PROFILE || '').trim();
const API_URL = (process.env.SCOUTS_API_URL || '').trim();
const API_KEY = (process.env.SCOUTS_API_KEY || '').trim();
const ACK = process.env.LIVE_TEST_ACK === '1';
const TIMEOUT_MS = Number(process.env.LIVE_TEST_TIMEOUT_MS || 240000);
const POLL_MS = Number(process.env.LIVE_TEST_POLL_MS || 3000);
const AGENDA_KEY = process.env.AGENDA_KEY || 'agenda.json';
const BACKUP_PREFIX = process.env.BACKUP_PREFIX || 'migration-backups/live-regression/';
const FUTURE_DATE_RAW = process.env.LIVE_TEST_DATE_RAW || '20990101T120000';
const FUTURE_DATE_ISO = process.env.LIVE_TEST_DATE_ISO || '2099-01-01T12:00:00Z';
const REGRESSION_UID_PREFIX = 'scouts-regression-';
const EXPECTED_AWS_ACCOUNT = process.env.EXPECTED_AWS_ACCOUNT || '553490163883';
const DEPLOYED_EVENT_LOADER_KEY = process.env.DEPLOYED_EVENT_LOADER_KEY || 'website/scripts/event-loader.js';
const IS_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const CONDITIONAL_WRITE_ATTEMPTS = 8;

if (!ACK) {
  throw new Error('Refusing live mutation. Set LIVE_TEST_ACK=1 after reviewing this script.');
}
if (!API_URL) throw new Error('SCOUTS_API_URL is required');
if (!API_KEY) throw new Error('SCOUTS_API_KEY is required');
if (!IS_GITHUB_ACTIONS && !AWS_PROFILE) {
  throw new Error('AWS_PROFILE is required for local live regression runs; do not use ambient/default production credentials.');
}
if (!(Date.parse(FUTURE_DATE_ISO) > Date.now())) {
  throw new Error(`Regression event must be future-dated: ${FUTURE_DATE_ISO}`);
}

const results = [];

function recordPass(label, detail = '') {
  results.push({ label, status: 'PASS', detail });
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

function recordFailure(label, error) {
  const detail = error?.message || String(error);
  results.push({ label, status: 'FAIL', detail });
  console.error(`✗ ${label} — ${detail}`);
}

function writeStepSummary({ title, hex, uid, failure = null }) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const rows = results.map(({ label, status, detail }) => `| ${label} | ${status} | ${String(detail || '').replace(/\|/g, '\\|')} |`).join('\n');
  const failureText = failure ? `\n**Failure:** ${String(failure?.message || failure).replace(/\n/g, ' ')}\n` : '';
  appendFileSync(summaryPath, [
    '## Scouts live regression canary',
    '',
    `- Event: \`${title}\``,
    `- UID: \`${uid}\``,
    `- HEX: \`${hex}\``,
    `- Bucket: \`s3://${BUCKET}\``,
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
    rows,
    failureText,
    '',
  ].join('\n'));
}

function aws(args) {
  const cliArgs = [...args, '--region', REGION];
  if (AWS_PROFILE) cliArgs.unshift('--profile', AWS_PROFILE);
  return execFileSync('aws', cliArgs, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function verifyAwsIdentity() {
  const actualAccount = aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']).trim();
  if (actualAccount !== EXPECTED_AWS_ACCOUNT) {
    throw new Error(`Unexpected AWS account ${actualAccount}; expected ${EXPECTED_AWS_ACCOUNT}`);
  }
  recordPass('AWS account verified', actualAccount);
}

function verifyDeployedRegressionGuard() {
  const source = aws(['s3', 'cp', `s3://${BUCKET}/${DEPLOYED_EVENT_LOADER_KEY}`, '-']);
  const hasReservedPrefix = source.includes("const REGRESSION_UID_PREFIX = 'scouts-regression-'");
  const checksBothUidLocations = /const candidates\s*=\s*\[event\?\.uid,\s*event\?\.source\?\.uid\]/.test(source);
  if (!hasReservedPrefix || !checksBothUidLocations) {
    throw new Error(`Deployed ${DEPLOYED_EVENT_LOADER_KEY} does not contain the required regression UID guard; refusing live canary mutation/unhide.`);
  }
  recordPass('Deployed public exclusion verified', DEPLOYED_EVENT_LOADER_KEY);
}

function errorText(error) {
  return [error?.message, error?.stderr?.toString?.(), error?.stdout?.toString?.()]
    .filter(Boolean)
    .join(' ');
}

function isNotFoundError(error) {
  return /404|NoSuchKey|Not Found|not exist|does not exist/i.test(errorText(error));
}

function isPreconditionFailure(error) {
  return /412|PreconditionFailed|precondition failed/i.test(errorText(error));
}

function withTempFile(key, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scouts-live-regression-'));
  const filePath = path.join(dir, path.basename(key) || 'object.json');
  try {
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readJson(key) {
  return JSON.parse(aws(['s3', 'cp', `s3://${BUCKET}/${key}`, '-']));
}

function readJsonVersioned(key) {
  return withTempFile(key, (filePath) => {
    const response = JSON.parse(aws([
      's3api', 'get-object',
      '--bucket', BUCKET,
      '--key', key,
      '--output', 'json',
      filePath,
    ]));
    return {
      value: JSON.parse(readFileSync(filePath, 'utf8')),
      eTag: response?.ETag,
    };
  });
}

function putJson(key, value, condition = {}) {
  return withTempFile(key, (filePath) => {
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    const args = [
      's3api', 'put-object',
      '--bucket', BUCKET,
      '--key', key,
      '--body', filePath,
      '--content-type', 'application/json',
      '--cache-control', 'no-store',
      '--output', 'json',
    ];
    if (condition.ifMatch) args.push('--if-match', condition.ifMatch);
    if (condition.ifNoneMatch) args.push('--if-none-match', condition.ifNoneMatch);
    return JSON.parse(aws(args));
  });
}

function writeJsonIfAbsent(key, value) {
  return putJson(key, value, { ifNoneMatch: '*' });
}

function writeJsonIfMatch(key, value, eTag) {
  if (!eTag) throw new Error(`Cannot conditionally write ${key} without an ETag`);
  return putJson(key, value, { ifMatch: eTag });
}

async function mutateJsonOptimistically(key, mutate, label) {
  for (let attempt = 1; attempt <= CONDITIONAL_WRITE_ATTEMPTS; attempt += 1) {
    const current = readJsonVersioned(key);
    const next = mutate(structuredClone(current.value));
    if (isDeepStrictEqual(next, current.value)) return next;
    try {
      writeJsonIfMatch(key, next, current.eTag);
      return next;
    } catch (error) {
      if (!isPreconditionFailure(error) || attempt === CONDITIONAL_WRITE_ATTEMPTS) throw error;
      await sleep(Math.min(1000, attempt * 150));
    }
  }
  throw new Error(`${label} could not complete after ${CONDITIONAL_WRITE_ATTEMPTS} conditional-write attempts`);
}

function backupObject(key, suffix) {
  const backupKey = `${BACKUP_PREFIX}${suffix}/${key}`;
  aws(['s3', 'cp', `s3://${BUCKET}/${key}`, `s3://${BUCKET}/${backupKey}`]);
  return backupKey;
}

function headObject(key) {
  return JSON.parse(aws(['s3api', 'head-object', '--bucket', BUCKET, '--key', key, '--output', 'json']));
}

function objectExists(key) {
  try {
    headObject(key);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function deleteObjectChecked(key) {
  aws(['s3api', 'delete-object', '--bucket', BUCKET, '--key', key, '--output', 'json']);
  if (objectExists(key)) throw new Error(`S3 object still exists after delete: ${key}`);
}

function listOwnedImageKeys(hex) {
  const prefix = `website/eventImages/${hex}-`;
  const response = JSON.parse(aws([
    's3api', 'list-objects-v2',
    '--bucket', BUCKET,
    '--prefix', prefix,
    '--output', 'json',
  ]));
  return (response?.Contents || [])
    .map((entry) => entry?.Key)
    .filter((key) => typeof key === 'string' && key.startsWith(prefix));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postCommand(payload) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`Scouts API ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function poll(label, fn) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${label} did not become true within ${TIMEOUT_MS}ms${lastError ? `: ${lastError.message}` : ''}`);
}

function eventFromAgenda(agenda, hex) {
  return (agenda?.events || []).find((event) => event?.metadata?.hex === hex) || null;
}

function addAgendaDummy(agenda, dummy, uid) {
  if (eventFromAgenda(agenda, dummy.metadata.hex)) {
    throw new Error(`Refusing to replace existing agenda entry for HEX ${dummy.metadata.hex}`);
  }
  const events = Array.isArray(agenda?.events) ? [...agenda.events] : [];
  events.push({
    uid,
    title: dummy.title,
    description: 'Temporary deployed regression canary event',
    start: {
      raw: FUTURE_DATE_RAW,
      iso: FUTURE_DATE_ISO.replace(/Z$/, ''),
      epochMillis: Date.parse(FUTURE_DATE_ISO),
    },
    source: {
      uid,
      title: dummy.title,
      section: 'cubs',
      icsType: 'regression',
      dtstart: FUTURE_DATE_RAW,
    },
    metadata: structuredClone(dummy.metadata),
  });
  return { ...agenda, generatedAt: new Date().toISOString(), events };
}

function assertOwnedAgendaEvent(event, hex, uid) {
  if (!event) return;
  if (
    event?.metadata?.hex !== hex
    || event?.uid !== uid
    || (event?.source?.uid !== undefined && event?.source?.uid !== uid)
  ) {
    throw new Error(`Refusing to mutate non-canary agenda entry for HEX ${hex}`);
  }
}

function removeAgendaDummy(agenda, hex, uid) {
  const matching = eventFromAgenda(agenda, hex);
  if (!matching) return agenda;
  assertOwnedAgendaEvent(matching, hex, uid);
  return {
    ...agenda,
    generatedAt: new Date().toISOString(),
    events: (Array.isArray(agenda?.events) ? agenda.events : []).filter((event) => event !== matching),
  };
}

function replaceAgendaMetadata(agenda, hex, uid, metadata) {
  let matched = false;
  const events = (Array.isArray(agenda?.events) ? agenda.events : []).map((event) => {
    if (event?.metadata?.hex !== hex) return event;
    assertOwnedAgendaEvent(event, hex, uid);
    matched = true;
    return { ...event, metadata: structuredClone(metadata) };
  });
  if (!matched) throw new Error(`Cannot update agenda metadata; HEX ${hex} is missing`);
  return { ...agenda, generatedAt: new Date().toISOString(), events };
}

function imageKeyFromEvent(event) {
  const imageUrl = event?.metadata?.image?.url;
  if (typeof imageUrl !== 'string') return null;
  const trimmed = imageUrl.trim().replace(/^\//, '');
  return trimmed.startsWith('website/eventImages/') ? trimmed : null;
}

function metadataMatches(event, agendaEvent) {
  return isDeepStrictEqual(event?.metadata ?? null, agendaEvent?.metadata ?? null);
}

async function waitForEventAndAgenda(hex, predicate, label) {
  return poll(label, () => {
    const event = readJson(`events/${hex}.json`);
    assertCanonicalEventDocument(event, { expectedHex: hex });
    const agendaEvent = eventFromAgenda(readJson(AGENDA_KEY), hex);
    if (!agendaEvent) return null;
    if (!metadataMatches(event, agendaEvent)) return null;
    return predicate(event, agendaEvent) ? { event, agendaEvent } : null;
  });
}

async function writeCanonicalState(hex, mutate) {
  const eventKey = `events/${hex}.json`;
  const next = await mutateJsonOptimistically(eventKey, (current) => {
    assertCanonicalEventDocument(current, { expectedHex: hex });
    const updated = structuredClone(current);
    mutate(updated);
    assertCanonicalEventDocument(updated, { expectedHex: hex });
    return updated;
  }, 'canonical event reset');
  await mutateJsonOptimistically(
    AGENDA_KEY,
    (agenda) => replaceAgendaMetadata(agenda, hex, uid, next.metadata),
    'canonical agenda reset',
  );
  await waitForEventAndAgenda(hex, () => true, 'canonical state reset');
  return next;
}

async function requestAndVerify({ action, stage, reset, predicate, label }) {
  if (reset) {
    await writeCanonicalState(hex, (event) => {
      reset(event);
      // The production reservation logic resets a succeeded stage when its
      // generation ID changes. The canonical schema has no description field,
      // so vary the title (while retaining the original HEX namespace) to
      // keep the canary self-contained without DynamoDB write access.
      event.title = `${title} ${stage}`;
    });
    recordPass(`${label} generation reset`, stage);
  }
  const response = await postCommand({ realm: 'scouts', action, subject: { hex } });
  const { event } = await waitForEventAndAgenda(hex, predicate, `${label} persistence`);
  recordPass(label, response?.requestId ? `request ${response.requestId}` : 'persisted to event + agenda');
  return event;
}

const runSuffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const title = `SCOUTS REGRESSION ${runSuffix}`;
// Production agenda hydration sanitizes UIDs by retaining the prefix through
// the first numeric run. Keep the canary UID in that canonical form so the
// ownership check remains exact during cleanup.
const uid = `${REGRESSION_UID_PREFIX}${runSuffix.split('-', 1)[0]}`;
const hex = titleToHex(title);
const eventKey = `events/${hex}.json`;
const dummy = buildCanonicalEventDocument({
  title,
  hex,
  tagline: null,
  imageTheme: null,
  imageUrl: null,
  isHidden: false,
  isApproved: false,
  requests: [],
});

const generatedImageKeys = new Set();
let agendaBackupKey = null;
let eventBackupKey = null;
let eventExistedBeforeRun = false;
let eventCreatedByRun = false;
let agendaEntryCreatedByRun = false;
let failure = null;

function requireGeneratedImage(event, label) {
  const key = imageKeyFromEvent(event);
  if (!key) {
    throw new Error(`${label} did not persist an S3-backed website/eventImages/ key`);
  }
  if (!key.includes(hex)) {
    throw new Error(`${label} generated image is outside the canary HEX namespace: ${key}`);
  }
  headObject(key);
  generatedImageKeys.add(key);
  recordPass(`${label} image exists in S3`, key);
  return key;
}

function markCleanupFailure(label, error) {
  recordFailure(label, error);
  if (!failure) failure = error;
}

console.log(`Live regression canary: ${title}`);
console.log(`UID: ${uid}`);
console.log(`HEX: ${hex}`);
console.log(`Bucket: s3://${BUCKET}`);

try {
  assertCanonicalEventDocument(dummy, { expectedHex: hex });
  verifyAwsIdentity();
  verifyDeployedRegressionGuard();

  const agendaBefore = readJson(AGENDA_KEY);
  if (eventFromAgenda(agendaBefore, hex)) {
    throw new Error(`Refusing to overwrite existing agenda entry for HEX ${hex}`);
  }
  agendaBackupKey = backupObject(AGENDA_KEY, runSuffix);

  try {
    readJson(eventKey);
    eventExistedBeforeRun = true;
    eventBackupKey = backupObject(eventKey, runSuffix);
    throw new Error(`Refusing to overwrite existing ${eventKey}`);
  } catch (error) {
    if (eventExistedBeforeRun) throw error;
    if (!isNotFoundError(error)) throw error;
  }

  writeJsonIfAbsent(eventKey, dummy);
  eventCreatedByRun = true;
  await mutateJsonOptimistically(
    AGENDA_KEY,
    (agenda) => addAgendaDummy(agenda, dummy, uid),
    'synthetic agenda seed',
  );
  agendaEntryCreatedByRun = true;

  headObject(eventKey);
  const seeded = await waitForEventAndAgenda(
    hex,
    (event, agendaEvent) => (
      agendaEvent.uid === uid
      && agendaEvent.source?.uid === uid
      && Date.parse(agendaEvent.start?.iso || FUTURE_DATE_ISO) > Date.now()
      && event.metadata.tagline === null
      && event.metadata.image.theme === null
      && event.metadata.image.url === null
      && event.metadata.status.isHidden === false
      && event.metadata.status.isApproved === false
    ),
    'synthetic event seed',
  );
  if (!seeded.agendaEvent.uid.startsWith(REGRESSION_UID_PREFIX)) {
    throw new Error('Synthetic event does not use the reserved regression UID prefix');
  }
  recordPass('Synthetic event seeded', `${eventKey} + ${AGENDA_KEY}`);

  let current = await requestAndVerify({
    action: 'generateFull',
    label: 'Full enrichment',
    predicate: (event) => Boolean(event.metadata.tagline && event.metadata.image.theme && event.metadata.image.url),
  });
  assertCanonicalEventDocument(current, { expectedHex: hex, requireComplete: true });
  requireGeneratedImage(current, 'Full enrichment');

  current = await requestAndVerify({
    action: 'generateTagline',
    stage: 'tagline',
    label: 'Tagline enrichment',
    reset: (event) => { event.metadata.tagline = null; },
    predicate: (event) => Boolean(event.metadata.tagline),
  });

  current = await requestAndVerify({
    action: 'generateImageTheme',
    stage: 'imageTheme',
    label: 'Image theme enrichment',
    reset: (event) => { event.metadata.image.theme = null; },
    predicate: (event) => Boolean(event.metadata.image.theme),
  });

  current = await requestAndVerify({
    action: 'generateImage',
    stage: 'image',
    label: 'Image enrichment',
    reset: (event) => { event.metadata.image.url = null; },
    predicate: (event) => Boolean(event.metadata.image.url),
  });
  requireGeneratedImage(current, 'Image enrichment');

  const approve = await postCommand({ realm: 'scouts', action: 'approve', subject: { hex, isApproved: true } });
  await waitForEventAndAgenda(hex, (event) => event.metadata.status.isApproved === true, 'approval persistence');
  recordPass('Approval persisted', approve?.requestId ? `request ${approve.requestId}` : 'event + agenda');

  const hide = await postCommand({ realm: 'scouts', action: 'hide', subject: { hex, isHidden: true } });
  await waitForEventAndAgenda(hex, (event) => event.metadata.status.isHidden === true, 'hide persistence');
  recordPass('Hide persisted', hide?.requestId ? `request ${hide.requestId}` : 'event + agenda');

  const unhide = await postCommand({ realm: 'scouts', action: 'unhide', subject: { hex, isHidden: false } });
  const unhidden = await waitForEventAndAgenda(
    hex,
    (event, agendaEvent) => event.metadata.status.isHidden === false && agendaEvent.uid === uid,
    'unhide persistence',
  );
  if (!unhidden.agendaEvent.uid.startsWith(REGRESSION_UID_PREFIX)) {
    throw new Error('Unhidden canary lost the reserved regression UID prefix');
  }
  recordPass('Unhide persisted', unhide?.requestId ? `request ${unhide.requestId}` : 'event + agenda');
  recordPass('Public exclusion identity retained', uid);

  recordPass('Live canonical lifecycle', 'all regression stages passed');
} catch (error) {
  failure = error;
  recordFailure('Live canonical lifecycle', error);
} finally {
  if (agendaEntryCreatedByRun) {
    try {
      await mutateJsonOptimistically(
        AGENDA_KEY,
        (agenda) => removeAgendaDummy(agenda, hex, uid),
        'agenda cleanup',
      );
      if (eventFromAgenda(readJson(AGENDA_KEY), hex)) {
        throw new Error(`Canary agenda entry still exists after cleanup for HEX ${hex}`);
      }
      recordPass('Cleanup agenda entry', AGENDA_KEY);
    } catch (error) {
      markCleanupFailure('Cleanup agenda entry', error);
      console.error(`Agenda recovery backup: ${agendaBackupKey || '<none>'}`);
    }
  } else {
    console.log('Skipping agenda cleanup because this run never created the agenda entry');
  }

  if (eventCreatedByRun) {
    try {
      const currentEvent = readJson(eventKey);
      if (currentEvent?.title !== title || currentEvent?.metadata?.hex !== hex) {
        throw new Error(`Refusing to delete event object no longer owned by this canary: ${eventKey}`);
      }
      deleteObjectChecked(eventKey);
      recordPass('Cleanup event object', eventKey);
    } catch (error) {
      if (isNotFoundError(error)) {
        recordPass('Cleanup event object', `${eventKey} already absent`);
      } else {
        markCleanupFailure('Cleanup event object', error);
      }
    }
  } else if (eventExistedBeforeRun) {
    console.error(`Pre-existing event retained${eventBackupKey ? `; backup at s3://${BUCKET}/${eventBackupKey}` : ''}`);
  } else {
    console.log('Skipping event cleanup because this run never created the event object');
  }

  if (eventCreatedByRun) {
    try {
      const ownedKeys = listOwnedImageKeys(hex);
      for (const key of ownedKeys) {
        try {
          deleteObjectChecked(key);
          recordPass('Cleanup generated image', key);
        } catch (error) {
          markCleanupFailure('Cleanup generated image', error);
        }
      }
      const leftovers = listOwnedImageKeys(hex);
      if (leftovers.length > 0) {
        throw new Error(`Canary image prefix still contains ${leftovers.length} object(s): ${leftovers.join(', ')}`);
      }
      if (ownedKeys.length === 0) recordPass('Cleanup generated images', 'no owned image objects remain');
    } catch (error) {
      markCleanupFailure('Cleanup generated image prefix', error);
    }
  }

  if (agendaBackupKey) {
    console.log(`Agenda recovery backup retained at s3://${BUCKET}/${agendaBackupKey}`);
  }
  writeStepSummary({ title, hex, uid, failure });
}

if (failure) throw failure;
