#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  assertCanonicalEventDocument,
  buildCanonicalEventDocument,
  buildCanonicalMetadata,
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
const BACKUP_PREFIX = process.env.BACKUP_PREFIX || 'migration-backups/live-smoke/';

if (!ACK) {
  throw new Error('Refusing live mutation. Set LIVE_TEST_ACK=1 after reviewing this script.');
}
if (!API_URL) throw new Error('SCOUTS_API_URL is required');
if (!API_KEY) throw new Error('SCOUTS_API_KEY is required');

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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scouts-live-smoke-'));
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

function upsertAgendaDummy(agenda, dummy) {
  const events = Array.isArray(agenda?.events) ? agenda.events.filter((event) => event?.metadata?.hex !== dummy.metadata.hex) : [];
  events.push({
    uid: `live-smoke-${dummy.metadata.hex}`,
    title: dummy.title,
    description: 'Temporary canonical schema smoke-test event',
    start: {
      raw: '20990101T120000',
      iso: '2099-01-01T12:00:00',
      epochMillis: Date.parse('2099-01-01T12:00:00Z'),
    },
    source: {
      uid: `live-smoke-${dummy.metadata.hex}`,
      title: dummy.title,
      section: 'cubs',
      icsType: 'cubs',
      dtstart: '20990101T120000',
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

async function waitForCanonicalEvent(hex, predicate, label) {
  return poll(label, () => {
    const event = readJson(`events/${hex}.json`);
    assertCanonicalEventDocument(event, { expectedHex: hex });
    return predicate(event) ? event : null;
  });
}

async function waitForAgendaStatus(hex, field, expected) {
  return poll(`agenda ${field}=${expected}`, () => {
    const event = eventFromAgenda(readJson(AGENDA_KEY), hex);
    return event?.metadata?.status?.[field] === expected ? event : null;
  });
}

const runSuffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const title = `SCOUTS CANONICAL SMOKE ${runSuffix}`;
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

let generatedImageKey = null;
let agendaBackupKey = null;
let eventBackupKey = null;

console.log(`Live canonical smoke test: ${title}`);
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
  writeJson(AGENDA_KEY, upsertAgendaDummy(agendaBefore, dummy));
  console.log('✓ Seeded clean canonical event and temporary agenda entry');

  const generate = await postCommand({
    realm: 'scouts',
    action: 'generateFull',
    subject: { hex },
  });
  console.log(`✓ Full enrichment queued${generate?.requestId ? ` (${generate.requestId})` : ''}`);

  const enriched = await waitForCanonicalEvent(
    hex,
    (event) => Boolean(event.metadata.tagline && event.metadata.image.theme && event.metadata.image.url),
    'full enrichment',
  );
  assertCanonicalEventDocument(enriched, { expectedHex: hex, requireComplete: true });
  generatedImageKey = enriched.metadata.image.url.startsWith('website/eventImages/')
    ? enriched.metadata.image.url.replace(/^\//, '')
    : null;
  if (generatedImageKey) {
    aws(['s3api', 'head-object', '--bucket', BUCKET, '--key', generatedImageKey, '--output', 'json']);
  }
  console.log(`✓ Enriched: tagline/theme/image URL are populated${generatedImageKey ? ' and image exists in S3' : ''}`);

  await postCommand({ realm: 'scouts', action: 'approve', subject: { hex, isApproved: true } });
  await waitForCanonicalEvent(hex, (event) => event.metadata.status.isApproved === true, 'approval persistence');
  await waitForAgendaStatus(hex, 'isApproved', true);
  console.log('✓ Approval persisted to HEX and agenda');

  await postCommand({ realm: 'scouts', action: 'hide', subject: { hex, isHidden: true } });
  await waitForCanonicalEvent(hex, (event) => event.metadata.status.isHidden === true, 'hide persistence');
  await waitForAgendaStatus(hex, 'isHidden', true);
  console.log('✓ Hide persisted to HEX and agenda');

  await postCommand({ realm: 'scouts', action: 'unhide', subject: { hex, isHidden: false } });
  await waitForCanonicalEvent(hex, (event) => event.metadata.status.isHidden === false, 'unhide persistence');
  await waitForAgendaStatus(hex, 'isHidden', false);
  console.log('✓ Unhide persisted to HEX and agenda');

  console.log('✓ Live canonical lifecycle passed');
} finally {
  try {
    const currentAgenda = readJson(AGENDA_KEY);
    writeJson(AGENDA_KEY, removeAgendaDummy(currentAgenda, hex));
    console.log('✓ Removed temporary agenda entry');
  } catch (error) {
    console.error(`Failed to remove temporary agenda entry. Recovery backup: ${agendaBackupKey || '<none>'}`);
    console.error(error?.message || error);
  }

  if (eventBackupKey) {
    console.error(`Event key unexpectedly existed; original backup retained at s3://${BUCKET}/${eventBackupKey}`);
  } else {
    deleteObject(eventKey);
    console.log('✓ Removed temporary event object');
  }

  if (generatedImageKey && generatedImageKey.includes(hex)) {
    deleteObject(generatedImageKey);
    console.log('✓ Removed generated test image');
  }

  if (agendaBackupKey) {
    console.log(`Agenda recovery backup retained at s3://${BUCKET}/${agendaBackupKey}`);
  }
}
