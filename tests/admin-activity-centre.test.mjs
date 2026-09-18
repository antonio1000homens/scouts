import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFunctionsFromSource } from './helpers/source-function-loader.mjs';

const source = readFileSync('website/admin/admin-activity-centre.js', 'utf8');
const shellSource = readFileSync('website/admin/admin-simplify.js', 'utf8');
const adminSource = readFileSync('website/admin/admin-script.js', 'utf8');
const html = readFileSync('website/admin/index.html', 'utf8');

function activityHelpers(sandbox = {}) {
  return loadFunctionsFromSource(source, [
    'text',
    'eventFromEntry',
    'canonicalEventHex',
    'loadedEventEntries',
    'activityEventTitle',
    'stateLabel',
    'activityTimestamp',
    'formatActivityForClipboard',
  ], sandbox).functions;
}

test('activity centre persists request IDs, stacks notices and exposes a seven-day log', () => {
  assert.match(source, /SCOUTS_ADMIN_TRACKED_REQUEST_IDS|scouts_admin_tracked_request_ids/i);
  assert.match(source, /activity-toast-stack/);
  assert.match(source, /function notifyMessage/);
  assert.doesNotMatch(source, /window\.showAdminNotification\s*=(?!=)/);
  assert.match(source, /TERMINAL\.has\(request\.state\) \? 8000 : 5000/);
  assert.match(source, /activity-centre-drawer/);
  assert.match(source, /activity-log-hex/);
  assert.match(source, /activityCommand\('lookup'|activityCommand\('history'/);
  assert.match(source, /View event/);
  assert.match(source, /openAdminEventByHex/);
  assert.match(adminSource, /no longer present/);
});

test('Activity refresh returns tracked lookup completions as part of the canonical request view', () => {
  assert.match(source, /const statusActivity = result\?\.activity \|\| null/);
  assert.match(source, /const requests = \[\.\.\.statusRequests, \.\.\.\(lookup\?\.activity\?\.requests \|\| \[\]\)\]/);
  assert.match(source, /latestStatusActivity = \{[\s\S]*requests,[\s\S]*\}/);
  assert.match(source, /refreshNow: async \(\) => \{[\s\S]*const activity = await poll\(\)[\s\S]*return activity/);
});

test('Admin shell removes raw viewers and duplicate legacy request panels from the normal view', () => {
  assert.match(shellSource, /viewer-menu-shell/);
  assert.match(shellSource, /requests-sidebar/);
  assert.match(shellSource, /admin-runtime-footer/);
  assert.doesNotMatch(source, /diagnostics-raw-state/);
  assert.match(html, /admin-activity-centre\.js/);
  assert.match(html, /admin-activity-centre\.css/);
});

test('activity cards show a human title with visible HEX and a per-card copy action', () => {
  assert.match(source, /activityEventTitle\(request\)/);
  assert.match(source, /activity-event-hex/);
  assert.match(source, /activity-copy-event/);
  assert.match(source, /copyActivity\(request, copyButton\)/);
  assert.doesNotMatch(source, /activity-log-list[^\n]*innerText|activity-centre-drawer[^\n]*innerText/);
});

test('activity title prefers ledger title and falls back to loaded canonical event by HEX', () => {
  const event = { summary: 'Summer Camp', metadata: { hex: 'A1B2C3D4' } };
  const helpers = activityHelpers({
    visibleEventEntries: [],
    uniqueEventEntries: [{ event }],
    eventsData: [],
    getEventHex: (value) => value?.metadata?.hex || '',
  });

  assert.equal(helpers.activityEventTitle({ title: 'Ledger title', hex: 'ffff' }), 'Ledger title');
  assert.equal(helpers.activityEventTitle({ hex: 'a1b2c3d4' }), 'Summer Camp');
  assert.equal(helpers.activityEventTitle({ hex: 'A1B2C3D4' }), 'Summer Camp');
  assert.equal(helpers.activityEventTitle({ hex: 'deadbeef' }), 'Unknown event');
});

test('clipboard formatter contains only the selected logical activity entry', () => {
  const helpers = activityHelpers({
    visibleEventEntries: [],
    uniqueEventEntries: [],
    eventsData: [],
  });
  const first = {
    title: 'Summer Camp',
    hex: 'a1b2c3d4',
    state: 'failed',
    action: 'imageenrich',
    updatedAt: '2026-09-17T15:10:42.000Z',
    failure: { message: 'Image provider failed' },
    timeline: [
      { at: '2026-09-17T15:09:03.000Z', state: 'queued' },
      { at: '2026-09-17T15:10:42.000Z', state: 'failed' },
    ],
  };
  const second = { title: 'Scout Hike', hex: 'eeeeffff', state: 'completed' };

  const copied = helpers.formatActivityForClipboard(first);
  const other = helpers.formatActivityForClipboard(second);

  assert.match(copied, /Event: Summer Camp/);
  assert.match(copied, /HEX: a1b2c3d4/);
  assert.match(copied, /Status: Needs attention/);
  assert.match(copied, /Failure: Image provider failed/);
  assert.match(copied, /Timeline:/);
  assert.doesNotMatch(copied, /Scout Hike|eeeeffff/);
  assert.match(other, /Event: Scout Hike/);
});

test('clipboard handling uses the browser clipboard API with a safe fallback and non-blocking feedback', () => {
  assert.match(source, /navigator\.clipboard/);
  assert.match(source, /writeText\(value\)/);
  assert.match(source, /document\.execCommand\('copy'\)/);
  assert.match(source, /Copied/);
  assert.match(source, /Could not copy activity\./);
});
