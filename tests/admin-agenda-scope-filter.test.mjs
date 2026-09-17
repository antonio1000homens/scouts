import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const shell = readFileSync('website/admin/admin-simplify.js', 'utf8');
const scoutsEntry = readFileSync('lambdas/scouts/function/scouts-entry.mjs', 'utf8');

function assertSyntax(path) {
  execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
}

test('Admin event scope defaults to agenda and offers Show all', () => {
  assert.match(shell, /let eventScope = 'agenda'/);
  assert.match(shell, />\s*In agenda\s*</);
  assert.match(shell, />\s*Show all\s*</);
  assert.match(shell, /data-event-scope="agenda"/);
  assert.match(shell, /data-event-scope="all"/);
  assert.match(shell, /window\.adminEventScopeController = Object\.freeze/);
});

test('Show all loads the authenticated canonical event catalogue', () => {
  assert.match(shell, /realm: 'runtime',[\s\S]*subject: 'event',[\s\S]*action: 'list'/);
  assert.match(shell, /replaceAdminEventDataset\(result\.events\)/);
  assert.match(shell, /uniqueEventEntries = buildUniqueEventEntries\(eventsData\)/);
  assert.match(shell, /if \(eventScope === 'all'\)/);
});

test('runtime event list remains private and paginates canonical event objects', () => {
  assert.match(scoutsEntry, /ListObjectsV2Command/);
  assert.match(scoutsEntry, /Prefix: 'events\/'/);
  assert.match(scoutsEntry, /NextContinuationToken/);
  assert.match(scoutsEntry, /\['get', 'review', 'list'\]\.includes\(command\.action\)/);
  assert.match(scoutsEntry, /if \(command\.action === 'list'\)/);
  assert.match(scoutsEntry, /return response\(200, \{ status: 'ok', events, count: events\.length \}\)/);
});

test('scope implementation keeps Admin v2 controller ownership explicit', () => {
  assert.doesNotMatch(shell, /window\.(renderEvents|loadEvents|sendScoutsCommand)\s*=(?!=)/);
  assertSyntax('website/admin/admin-simplify.js');
  assertSyntax('lambdas/scouts/function/scouts-entry.mjs');
});
