import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
