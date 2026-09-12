#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { assertCanonicalAgendaEvent, assertCanonicalEventDocument } from '../shared-layer/nodejs/canonical-event.mjs';

const BUCKET = process.env.BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const REGION = process.env.AWS_REGION || 'eu-west-2';
const PROFILE = (process.env.AWS_PROFILE || '').trim();
const PREFIX = process.env.PREFIX || 'events/';
const AGENDA_KEY = process.env.AGENDA_KEY || 'agenda.json';
const CHECK_AGENDA = process.env.CHECK_AGENDA !== '0';

function aws(args) {
  const cliArgs = [...args, '--region', REGION];
  if (PROFILE) cliArgs.unshift('--profile', PROFILE);
  return execFileSync('aws', cliArgs, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

function listKeys() {
  const keys = [];
  let token = null;
  do {
    const args = ['s3api', 'list-objects-v2', '--bucket', BUCKET, '--prefix', PREFIX, '--output', 'json'];
    if (token) args.push('--continuation-token', token);
    const page = JSON.parse(aws(args));
    for (const entry of page.Contents || []) {
      if (typeof entry.Key === 'string' && entry.Key.endsWith('.json')) keys.push(entry.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : null;
  } while (token);
  return keys;
}

function readJson(key) {
  return JSON.parse(aws(['s3', 'cp', `s3://${BUCKET}/${key}`, '-']));
}

function expectedHexFromKey(key) {
  const filename = key.split('/').pop() || '';
  const hex = filename.replace(/\.json$/i, '').trim().toLowerCase();
  return /^[0-9a-f]+$/.test(hex) ? hex : null;
}

const keys = listKeys();
console.log(`Checking ${keys.length} event files in s3://${BUCKET}/${PREFIX}...\n`);

let clean = 0;
const dirty = [];

for (const key of keys) {
  try {
    const data = readJson(key);
    assertCanonicalEventDocument(data, { expectedHex: expectedHexFromKey(key) });
    clean += 1;
  } catch (error) {
    dirty.push({ key, error: error?.message || String(error) });
  }
}

let agendaResult = null;
if (CHECK_AGENDA) {
  try {
    const agenda = readJson(AGENDA_KEY);
    if (!Array.isArray(agenda.events)) throw new Error('agenda.json is missing events[]');
    const failures = [];
    for (const [index, event] of agenda.events.entries()) {
      try {
        assertCanonicalAgendaEvent(event);
      } catch (error) {
        failures.push({
          index,
          title: event?.title ?? event?.summary ?? null,
          error: error?.message || String(error),
        });
      }
    }
    agendaResult = { key: AGENDA_KEY, total: agenda.events.length, dirty: failures.length, failures };
  } catch (error) {
    agendaResult = { key: AGENDA_KEY, total: 0, dirty: 1, failures: [{ error: error?.message || String(error) }] };
  }
}

console.log(`Scanned : ${keys.length}`);
console.log(`Clean   : ${clean}`);
console.log(`Dirty   : ${dirty.length}`);
if (agendaResult) console.log(`Agenda  : ${agendaResult.dirty === 0 ? 'clean' : `${agendaResult.dirty} dirty event(s)`}`);
console.log('');

for (const { key, error } of dirty) {
  console.log(`  ${key}`);
  console.log(`    ${error}`);
}

if (agendaResult?.dirty > 0) {
  console.log(`\nAgenda validation failures (${agendaResult.dirty}):`);
  for (const failure of agendaResult.failures.slice(0, 50)) {
    console.log(`  [${failure.index ?? '?'}] ${failure.title ?? '<unknown>'}: ${failure.error}`);
  }
  if (agendaResult.failures.length > 50) console.log(`  ... ${agendaResult.failures.length - 50} more`);
}

if (dirty.length > 0 || (agendaResult && agendaResult.dirty > 0)) {
  process.exitCode = 1;
} else {
  console.log('✓ All persisted event files and agenda metadata use the strict canonical schema.');
}
