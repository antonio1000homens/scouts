import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('website/admin/admin-activity-centre.js', 'utf8');
const adminSource = readFileSync('website/admin/admin-script.js', 'utf8');
const html = readFileSync('website/admin/index.html', 'utf8');

test('activity centre persists request IDs, stacks notices and exposes a seven-day log', () => {
  assert.match(source, /SCOUTS_ADMIN_TRACKED_REQUEST_IDS|scouts_admin_tracked_request_ids/i);
  assert.match(source, /activity-toast-stack/);
  assert.match(source, /window\.showAdminNotification = notifyMessage/);
  assert.match(source, /TERMINAL\.has\(request\.state\) \? 8000 : 5000/);
  assert.match(source, /activity-centre-drawer/);
  assert.match(source, /activity-log-hex/);
  assert.match(source, /activityCommand\('lookup'|activityCommand\('history'/);
  assert.match(source, /View event/);
  assert.match(source, /openAdminEventByHex/);
  assert.match(adminSource, /no longer present/);
});

test('raw file viewers and duplicate legacy request panels are removed from the normal view', () => {
  assert.match(source, /viewer-menu-shell/);
  assert.match(source, /requests-sidebar/);
  assert.match(source, /admin-runtime-footer/);
  assert.match(source, /diagnostics-raw-state/);
  assert.match(html, /admin-activity-centre\.js/);
  assert.match(html, /admin-activity-centre\.css/);
});
