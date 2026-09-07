import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Issue #39 journey/security coverage is imported here so it executes in the
// existing consolidated plan-and-test lane without creating another workflow
// or GitHub-hosted runner.
import './issue-39-admin-actions.test.mjs';
import './issue-39-actions-rendering.test.mjs';
import './issue-39-synthetic-workflow.integration.test.mjs';
import './issue-39-security-contract.test.mjs';

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

test('age-only stalled vocabulary is normalized out of primary presentation', () => {
  assert.match(simplify, /Queued Stalled', 'Waiting'/);
  assert.match(simplify, /Processing Stall', 'Processing'/);
  assert.doesNotMatch(simplify, /60\s*\*\s*1000/);
});

test('agenda enrichment control is expressed as user intent', () => {
  assert.match(simplify, /AI off/);
  assert.match(simplify, /1 event/);
  assert.match(simplify, /5 events/);
  assert.match(simplify, /10 events/);
  assert.match(simplify, /AI enrichment events/);
});

test('activity rendering uses textContent rather than interpolated innerHTML', () => {
  assert.match(simplify, /statusEl\.textContent = sanitizeStatusText\(badge\)/);
  assert.match(simplify, /titleEl\.textContent = sanitizeStatusText\(title\)/);
  assert.doesNotMatch(simplify, /item\.innerHTML\s*=\s*`[^`]*\$\{sanitizeStatusText/);
});

test('diagnostics retain raw status and request detail', () => {
  assert.match(simplify, /isDiagnosticsNode/);
  assert.match(simplify, /#admin-diagnostics-drawer/);
  assert.match(simplify, /if \(isDiagnosticsNode\(el\)\) return/);
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
