import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const scoutsService = readFileSync('lambdas/scouts/function/scouts-service.mjs', 'utf8');
const persistence = readFileSync('lambdas/sqs2scouts/function/persistence-processor.mjs', 'utf8');
const agendaPublisher = readFileSync('lambdas/sqs2scouts/function/agenda-publisher.mjs', 'utf8');
const adminScript = readFileSync('website/admin/admin-script.js', 'utf8');

test('calendar reconciliation treats canonical HEX visibility as authoritative in both directions', () => {
  assert.match(
    scoutsService,
    /const existingHexStatus = getEventStatusObject\(existingHexFile\);[\s\S]{0,500}isHidden = existingHexStatus\.isHidden === true;/,
  );
  assert.doesNotMatch(
    scoutsService,
    /if \(!isHidden && isEventHidden\(existingHexFile\)\) \{\s*isHidden = true;\s*\}/,
  );
});

test('calendar reconciliation treats canonical HEX approval as authoritative in both directions', () => {
  assert.match(
    scoutsService,
    /const existingHexStatus = getEventStatusObject\(existingHexFile\);[\s\S]{0,500}baseEvent\.approved = existingHexStatus\.isApproved === true;/,
  );
});

test('production visibility no longer reads or writes per-occurrence overlays', () => {
  assert.doesNotMatch(scoutsService, /occurrenceStorageKey|occurrences\//);
  assert.doesNotMatch(persistence, /occurrenceStorageKey|persistOccurrenceVisibility|persistVisibilityOverlays|occurrences\//);
});

test('Admin groups shared events by HEX before considering occurrence identity', () => {
  assert.match(
    adminScript,
    /function getEventMergeKey\(event, index\) \{\s*const hex = getEventHex\(event\);\s*if \(hex\) return `hex:\$\{hex\}`;\s*if \(hasText\(event\?\.occurrenceId\)\)/,
  );
});

test('agenda publication projects one canonical HEX status onto all matching instances', () => {
  assert.doesNotMatch(agendaPublisher, /occurrenceId|occurrenceMatched|hasExplicitVisibility/);
  assert.match(agendaPublisher, /if \(eventHex\(event\) !== normalisedHex\) return event;[\s\S]{0,160}metadata: clone\(canonicalMetadata\)/);
});
