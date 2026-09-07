import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './issue-43-runtime-activity.test.mjs';

const html = readFileSync('website/admin/index.html', 'utf8');
const simplify = readFileSync('website/admin/admin-simplify.js', 'utf8');
const css = readFileSync('website/admin/admin-simplify.css', 'utf8');

test('admin page loads simplified presentation assets after legacy controller', () => {
  assert.match(html, /admin-simplify\.css/);
  assert.match(html, /admin-script\.js[\s\S]*admin-simplify\.js/);
});

test('default UI exposes diagnostics separately and keeps activity user-facing', () => {
  assert.match(simplify, /Diagnostics/);
  assert.match(simplify, /Activity/);
  assert.match(simplify, /All services available/);
  assert.match(simplify, /Waiting for retry|Waiting/);
  assert.match(css, /admin-diagnostics-drawer/);
  assert.match(css, /admin-primary-summary/);
});

test('age alone is not an authoritative lifecycle state', () => {
  assert.match(simplify, /classifyAggregateRuntimeRequestStatus = function/);
  assert.match(simplify, /if \(hasProcessing\) return 'processing'/);
  assert.match(simplify, /if \(hasQueued\) return 'queued'/);
  assert.doesNotMatch(simplify, /QUEUED_STALLED_THRESHOLD_MS/);
});

test('agenda enrichment control is expressed as user intent', () => {
  assert.match(simplify, /AI off/);
  assert.match(simplify, /1 event/);
  assert.match(simplify, /5 events/);
  assert.match(simplify, /10 events/);
  assert.match(simplify, /AI enrichment events/);
});

test('activity rendering uses lifecycle data and textContent rather than cloned diagnostics DOM', () => {
  assert.match(simplify, /function renderCanonicalActivity/);
  assert.match(simplify, /statusEl\.textContent = stateLabel\(request\)/);
  assert.match(simplify, /titleEl\.textContent = requestTitle\(request\)/);
  assert.doesNotMatch(simplify, /function cloneActivityCards/);
});

test('diagnostics split request lifecycle from queue and workflow telemetry', () => {
  assert.match(simplify, /Authoritative requests, infrastructure health and raw state/);
  assert.match(simplify, /'Requests'/);
  assert.match(simplify, /'Queue health'/);
  assert.match(simplify, /'Step Functions'/);
  assert.match(simplify, /'Raw snapshots and tools'/);
});

test('one authoritative status poll replaces snapshot polling for the presentation layer', () => {
  assert.match(simplify, /realm: 'runtime', subject: 'activity', action: 'status'/);
  assert.match(simplify, /pollQueueDepthSnapshots = pollAuthoritativeActivity/);
  assert.match(simplify, /lastActivitySuccessAt/);
  assert.match(simplify, /retaining last good result/);
});

test('observer cannot self-trigger during presentation updates', () => {
  assert.match(simplify, /presentationRefreshInProgress/);
  assert.match(simplify, /observer\?\.disconnect\(\)/);
  assert.match(simplify, /observer\.observe\(document\.body, OBSERVER_OPTIONS\)/);
});

test('legacy diagnostics are hidden only after successful simplify initialization', () => {
  assert.match(simplify, /classList\.add\('admin-simplify-ready'\)/);
  assert.match(css, /body\.admin-simplify-ready \.events-layout > \.requests-sidebar/);
  assert.doesNotMatch(css, /\n\.events-layout > \.requests-sidebar,/);
});
