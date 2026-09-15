import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildVisibilityPersistGuard,
  extractVisibilityPersistMutation,
  verifyVisibilityPersistReadback,
} from '../full-enrich-helpers.mjs';
import { mergeCanonicalEventIntoAgenda } from '../agenda-publisher.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const functionDir = path.join(repoRoot, 'lambdas/sqs2scouts/function');
const deployScript = readFileSync(path.join(repoRoot, 'lambdas/sqs2scouts/deploy.sh'), 'utf8');
const persistenceProcessor = readFileSync(path.join(functionDir, 'persistence-processor.mjs'), 'utf8');
const HOLIDAY_HEX = '686f6c69646179';

function packagedFiles() {
  const block = deployScript.match(/zip -jq sqs2scouts-lambda\.zip \\\n([\s\S]*?)\n\)/)?.[1];
  assert.ok(block, 'Could not find the sqs2scouts ZIP manifest in deploy.sh');
  return [...block.matchAll(/^\s*([^\\\s]+)(?:\s*\\)?$/gm)].map((match) => match[1]);
}

function relativeImports(zipPath, entry) {
  const source = execFileSync('unzip', ['-p', zipPath, entry], { encoding: 'utf8' });
  return [...source.matchAll(/from\s+['"](\.\/?[^'"]+)['"]/g)]
    .map((match) => path.posix.normalize(path.posix.join(path.posix.dirname(entry), match[1])));
}

function visibilityMessage(isHidden = true) {
  return {
    realm: 'persist',
    operation: 'persist',
    subject: HOLIDAY_HEX,
    action: JSON.stringify({
      metadata: {
        hex: HOLIDAY_HEX,
        status: { isHidden },
      },
    }),
  };
}

function occurrenceVisibilityMessage(occurrenceId, isHidden = true) {
  return {
    realm: 'persist',
    operation: 'persist',
    occurrenceId,
    subject: { hex: HOLIDAY_HEX, occurrenceId },
    action: JSON.stringify({ metadata: { hex: HOLIDAY_HEX, status: { isHidden } } }),
  };
}

function canonicalEvent(isHidden = false) {
  return {
    title: 'HOLIDAY',
    metadata: {
      hex: HOLIDAY_HEX,
      tagline: 'School holiday',
      image: { theme: 'calendar', url: '/website/eventImages/holiday.webp' },
      status: { isHidden, isApproved: false },
    },
  };
}

function agendaEvent(uid, isHidden = false) {
  return {
    uid,
    summary: 'HOLIDAY',
    dtstart: '20260923T183000',
    metadata: {
      hex: HOLIDAY_HEX,
      tagline: 'School holiday',
      image: { theme: 'calendar', url: '/website/eventImages/holiday.webp' },
      status: { isHidden, isApproved: false },
    },
  };
}

test('sqs2scouts deployment ZIP contains every handler-relative import', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'scouts-sqs2scouts-package-'));
  const zipPath = path.join(tempDir, 'sqs2scouts-lambda.zip');
  try {
    const files = packagedFiles();
    execFileSync('zip', ['-jq', zipPath, ...files.map((file) => path.resolve(functionDir, file))], { stdio: 'pipe' });
    const entries = new Set(execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n'));
    assert.ok(entries.has('image-provider-adapter.mjs'));
    assert.ok(entries.has('gemini-text-models.mjs'));

    const pending = ['image-provider-adapter.mjs'];
    const visited = new Set();
    while (pending.length) {
      const entry = pending.pop();
      if (visited.has(entry)) continue;
      visited.add(entry);
      assert.ok(entries.has(entry), `Artifact is missing ${entry}`);
      for (const imported of relativeImports(zipPath, entry)) {
        assert.ok(entries.has(imported), `${entry} imports ${imported}, but the deployment ZIP omits it`);
        pending.push(imported);
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('persistence worker parses and merges the JSON action patch before writing', () => {
  assert.match(persistenceProcessor, /function parsePersistPatch\(action\)/);
  assert.match(persistenceProcessor, /const persistPatch = parsePersistPatch\(action\)/);
  assert.match(persistenceProcessor, /mergePersistPatch\(baseEvent, persistPatch\)/);
  assert.match(persistenceProcessor, /await saveHexEventToS3\(hexValue, event\);\s*await publishHexEventToAgenda\(hexValue, event\);/);
});

test('persist handler passes its parsed request body into occurrence visibility persistence', () => {
  assert.match(
    persistenceProcessor,
    /const visibility = extractOccurrenceVisibility\(messageBody, rawSubject, action\);/,
  );
  assert.doesNotMatch(
    persistenceProcessor,
    /const visibility = extractOccurrenceVisibility\(message, rawSubject, action\);/,
  );
});

test('persist handler records a verified completed outcome after canonical publication', () => {
  assert.match(
    persistenceProcessor,
    /Successfully persisted HEX file for \$\{eventTitle\}\`\);\s*runtimeOutcome = \{ status: 'completed' \};/,
  );
});

test('occurrence persist contract writes hidden state to the effective agenda without mutating the canonical event', () => {
  const occurrenceId = 'occ_0123456789abcdef01234567';
  const messageBody = occurrenceVisibilityMessage(occurrenceId, true);
  const canonical = canonicalEvent(false);
  const beforeCanonical = structuredClone(canonical);
  const visibility = extractVisibilityPersistMutation(messageBody);
  const agenda = { events: [agendaEvent('osm-event-1', false), { ...agendaEvent('osm-event-2', false), occurrenceId }] };
  const merged = mergeCanonicalEventIntoAgenda(agenda, canonical, HOLIDAY_HEX, {
    occurrenceId,
    visibility: visibility.isHidden,
  });

  assert.equal(visibility.hex, HOLIDAY_HEX);
  assert.equal(visibility.isHidden, true);
  assert.deepEqual(canonical, beforeCanonical);
  assert.equal(merged.agenda.events[0].metadata.status.isHidden, false);
  assert.equal(merged.agenda.events[1].metadata.status.isHidden, true);
});

test('visibility guard understands the live subject-HEX plus encoded-action contract', () => {
  assert.deepEqual(extractVisibilityPersistMutation(visibilityMessage(true)), {
    hex: HOLIDAY_HEX,
    isHidden: true,
  });
});

test('visibility guard refuses five HOLIDAY occurrences before persistence', () => {
  const agendaSnapshot = {
    value: {
      events: [1, 2, 3, 4, 5].map((index) => agendaEvent(`osm-event-${index}`)),
    },
    eTag: '"agenda-before"',
  };
  const eventSnapshot = { value: canonicalEvent(false), eTag: '"0fe52dbc"' };

  assert.throws(
    () => buildVisibilityPersistGuard(visibilityMessage(true), agendaSnapshot, eventSnapshot),
    (error) => error?.code === 'AMBIGUOUS_EVENT_OCCURRENCE' && error?.matched === 5,
  );
});

test('visibility guard selects exactly one same-HEX occurrence when occurrenceId is supplied', () => {
  const occurrenceId = 'occ_0123456789abcdef01234567';
  const agendaSnapshot = {
    value: {
      events: [1, 2, 3].map((index) => ({ ...agendaEvent(`osm-event-${index}`), occurrenceId: index === 2 ? occurrenceId : `occ_${String(index).repeat(24)}` })),
    },
  };
  const eventSnapshot = { value: canonicalEvent(false), eTag: '"before"' };
  const guard = buildVisibilityPersistGuard(occurrenceVisibilityMessage(occurrenceId), agendaSnapshot, eventSnapshot);
  assert.equal(guard.occurrenceId, occurrenceId);
  assert.equal(guard.hex, HOLIDAY_HEX);
});

test('visibility read-back rejects an unchanged canonical value', () => {
  const beforeAgenda = { value: { events: [agendaEvent('osm-event-1', false)] } };
  const beforeEvent = { value: canonicalEvent(false), eTag: '"0fe52dbc"' };
  const guard = buildVisibilityPersistGuard(visibilityMessage(true), beforeAgenda, beforeEvent);

  assert.throws(
    () => verifyVisibilityPersistReadback(
      guard,
      { value: { events: [agendaEvent('osm-event-1', false)] }, eTag: '"agenda-after"' },
      { value: canonicalEvent(false), eTag: '"0fe52dbc"' },
    ),
    (error) => error?.code === 'PERSISTENCE_READ_BACK_MISMATCH',
  );
});

test('visibility read-back rejects an unchanged S3 ETag when the boolean changed', () => {
  const beforeAgenda = { value: { events: [agendaEvent('osm-event-1', false)] } };
  const beforeEvent = { value: canonicalEvent(false), eTag: '"0fe52dbc"' };
  const guard = buildVisibilityPersistGuard(visibilityMessage(true), beforeAgenda, beforeEvent);

  assert.throws(
    () => verifyVisibilityPersistReadback(
      guard,
      { value: { events: [agendaEvent('osm-event-1', true)] }, eTag: '"agenda-after"' },
      { value: canonicalEvent(true), eTag: '"0fe52dbc"' },
    ),
    (error) => error?.code === 'PERSISTENCE_ETAG_UNCHANGED',
  );
});

test('visibility read-back succeeds only when canonical S3 and agenda both match', () => {
  const beforeAgenda = { value: { events: [agendaEvent('osm-event-1', false)] } };
  const beforeEvent = { value: canonicalEvent(false), eTag: '"0fe52dbc"' };
  const guard = buildVisibilityPersistGuard(visibilityMessage(true), beforeAgenda, beforeEvent);

  assert.deepEqual(
    verifyVisibilityPersistReadback(
      guard,
      { value: { events: [agendaEvent('osm-event-1', true)] }, eTag: '"agenda-after"' },
      { value: canonicalEvent(true), eTag: '"new-etag"' },
    ),
    { hex: HOLIDAY_HEX, isHidden: true, eTag: '"new-etag"' },
  );
});
