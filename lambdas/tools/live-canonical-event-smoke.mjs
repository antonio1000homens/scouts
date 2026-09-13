#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

if (!ACK) {
  throw new Error('Refusing live mutation. Set LIVE_TEST_ACK=1 after reviewing this script.');
}
if (!API_URL) throw new Error('SCOUTS_API_URL is required');
if (!API_KEY) throw new Error('SCOUTS_API_KEY is required');
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

function writeJson(key, value) {
  return withTempFile(key, (filePath) => {
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    aws(['s3', 'cp', filePath, `s3://${BUCKET}/${key}`, '--content-type', 'application/json', '--cache-control', 'no-store']);
  });
}

function backupObject(key, suffix) {
  const backupKey = `${BACKUP_PREFIX}${suffix}/${key}`;
  aws(['s3', 'cp', `s3://${BUCKET}/${key}`, `s3://${BUCKET}/${backupKey}`]);
  return backupKey;
}

function deleteObject(key) {
  try {
    aws(['s3', 'rm', `s3://${BUCKET}/${key}`]);
  } catch (error) {
    console.warn(`Cleanup warning for ${key}: ${error?.message || error}`);
  }
}

function headObject(key) {
  return JSON.parse(aws(['s3api', 'head-object', '--bucket', BUCKET, '--key', key, '--output', 'json']));
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

function upsertAgendaDummy(agenda, dummy, uid) {
  const events = Array.isArray(agenda?.events)
    ? agenda.events.filter((event) => event?.metadata?.hex !== dummy.metadata.hex)
    : [];
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

function removeAgendaDummy(agenda, hex) {
  return {
    ...agenda,
    generatedAt: new Date().toISOString(),
    events: (Array.isArray(agenda?.events) ? agenda.events : []).filter((event) => event?.metadata?.hex !== hex),
  };
}

function replaceAgendaMetadata(agenda, hex, metadata) {
  let matched = false;
  const events = (Array.isArray(agenda?.events) ? agenda.events : []).map((event) => {
    if (event?.metadata?.hex !== hex) return event;
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
  return JSON.stringify(event?.metadata ?? null) === JSON.stringify(agendaEvent?.metadata ?? null);
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
  const current = readJson(eventKey);
  assertCanonicalEventDocument(current, { expectedHex: hex });
  const next = structuredClone(current);
  mutate(next);
  assertCanonicalEventDocument(next, { expectedHex: hex });
  writeJson(eventKey, next);
  const agenda = readJson(AGENDA_KEY);
  writeJson(AGENDA_KEY, replaceAgendaMetadata(agenda, hex, next.metadata));
  await waitForEventAndAgenda(hex, () => true, 'canonical state reset');
  return next;
}

async function requestAndVerify({ action, reset, predicate, label }) {
  if (reset) await writeCanonicalState(hex, reset);
  const response = await postCommand({ realm: 'scouts', action, subject: { hex } });
  const { event } = await waitForEventAndAgenda(hex, predicate, `${label} persistence`);
  recordPass(label, response?.requestId ? `request ${response.requestId}` : 'persisted to event + agenda');
  return event;
}

const runSuffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const title = `SCOUTS REGRESSION ${runSuffix}`;
const uid = `${REGRESSION_UID_PREFIX}${runSuffix}`;
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
let failure = null;

console.log(`Live regression canary: ${title}`);
console.log(`UID: ${uid}`);
console.log(`HEX: ${hex}`);
console.log(`Bucket: s3://${BUCKET}`);

try {
  assertCanonicalEventDocument(dummy, { expectedHex: hex });

  const agendaBefore = readJson(AGENDA_KEY);
  agendaBackupKey = backupObject(AGENDA_KEY, runSuffix);
  try {
    readJson(eventKey);
    eventBackupKey = backupObject(eventKey, runSuffix);
    throw new Error(`Refusing to overwrite existing ${eventKey}`);
  } catch (error) {
    const message = error?.stderr?.toString?.() || error?.message || '';
    if (!/404|NoSuchKey|not exist|does not exist/i.test(message)) throw error;
  }

  writeJson(eventKey, dummy);
  writeJson(AGENDA_KEY, upsertAgendaDummy(agendaBefore, dummy, uid));
  headObject(eventKey);
  const seeded = await waitForEventAndAgenda(
    hex,
    (event, agendaEvent) => (
      agendaEvent.uid === uid
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
  let imageKey = imageKeyFromEvent(current);
  if (imageKey) {
    headObject(imageKey);
    generatedImageKeys.add(imageKey);
    recordPass('Generated image exists in S3', imageKey);
  }

  current = await requestAndVerify({
    action: 'generateTagline',
    label: 'Tagline enrichment',
    reset: (event) => { event.metadata.tagline = null; },
    predicate: (event) => Boolean(event.metadata.tagline),
  });

  current = await requestAndVerify({
    action: 'generateImageTheme',
    label: 'Image theme enrichment',
    reset: (event) => { event.metadata.image.theme = null; },
    predicate: (event) => Boolean(event.metadata.image.theme),
  });

  current = await requestAndVerify({
    action: 'generateImage',
    label: 'Image enrichment',
    reset: (event) => { event.metadata.image.url = null; },
    predicate: (event) => Boolean(event.metadata.image.url),
  });
  imageKey = imageKeyFromEvent(current);
  if (imageKey) {
    headObject(imageKey);
    generatedImageKeys.add(imageKey);
  }

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
  try {
    const currentAgenda = readJson(AGENDA_KEY);
    writeJson(AGENDA_KEY, removeAgendaDummy(currentAgenda, hex));
    recordPass('Cleanup agenda entry', AGENDA_KEY);
  } catch (error) {
    recordFailure('Cleanup agenda entry', error);
    if (!failure) failure = error;
    console.error(`Agenda recovery backup: ${agendaBackupKey || '<none>'}`);
  }

  if (eventBackupKey) {
    console.error(`Event key unexpectedly existed; original backup retained at s3://${BUCKET}/${eventBackupKey}`);
  } else {
    deleteObject(eventKey);
    recordPass('Cleanup event object', eventKey);
  }

  for (const key of generatedImageKeys) {
    if (!key.includes(hex)) {
      console.warn(`Retaining generated image outside canary HEX namespace: s3://${BUCKET}/${key}`);
      continue;
    }
    deleteObject(key);
    recordPass('Cleanup generated image', key);
  }

  if (agendaBackupKey) {
    console.log(`Agenda recovery backup retained at s3://${BUCKET}/${agendaBackupKey}`);
  }
  writeStepSummary({ title, hex, uid, failure });
}

if (failure) throw failure;
