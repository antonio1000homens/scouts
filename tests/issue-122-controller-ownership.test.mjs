import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const admin = readFileSync('website/admin/admin-script.js', 'utf8');
const privateStorage = readFileSync('website/admin/private-storage-client.js', 'utf8');
const approval = readFileSync('website/admin/admin-approval-workflow.js', 'utf8');
const shell = readFileSync('website/admin/admin-simplify.js', 'utf8');
const agenda = readFileSync('website/admin/admin-agenda-refresh.js', 'utf8');
const operations = readFileSync('website/admin/admin-diagnostics-enhancements.js', 'utf8');
const activity = readFileSync('website/admin/admin-activity-centre.js', 'utf8');

const extensions = [privateStorage, approval, shell, agenda, operations, activity].join('\n');

test('issue 122 extensions register owners instead of replacing base controller functions', () => {
  assert.match(privateStorage, /window\.privateStorageController = Object\.freeze/);
  assert.match(approval, /window\.scoutsApprovalController = Object\.freeze/);
  assert.match(agenda, /window\.adminAgendaController = Object\.freeze/);
  assert.match(activity, /window\.adminActivityController = Object\.freeze/);
  assert.doesNotMatch(extensions, /window\.(renderEvents|openUploadModal|updateModalContent|approveEvent|refreshLambda|sendScoutsCommand)\s*=(?!=)/);
  assert.doesNotMatch(operations, /installEventCardRenderHook|enhanceEventCards/);
});

test('issue 122 Activity is the only recurring lifecycle poll owner', () => {
  assert.match(activity, /function schedulePoll/);
  assert.match(activity, /ACTIVE_POLL_MS = 4000/);
  assert.match(activity, /IDLE_POLL_MS = 25000/);
  assert.match(admin, /Canonical Activity polling is owned by admin-activity-centre\.js/);
  assert.match(admin, /setStatusPollingEnabled\(false, false\)/);
  assert.doesNotMatch(shell, /pollAuthoritativeActivity|setInterval|setTimeout/);
  assert.doesNotMatch(operations, /subject: 'activity', action: 'status'/);
});

test('issue 122 transport and actions use explicit controller contracts', () => {
  assert.match(admin, /window\.adminActivityController\?\.trackAcceptedMutation/);
  assert.match(admin, /window\.scoutsApprovalController/);
  assert.match(admin, /window\.adminAgendaController/);
  assert.match(admin, /window\.privateStorageController/);
  assert.match(admin, /button\.dataset\.apiPending === 'true'/);
});

test('issue 122 keeps Operations separate from normal Activity', () => {
  assert.match(shell, /<h2>Operations<\/h2>/);
  assert.match(operations, /Scheduled calendar refresh/);
  assert.match(operations, /Dead-letter queues/);
  assert.match(activity, /<h2>Activity<\/h2>/);
  assert.doesNotMatch(shell, /Authoritative requests, infrastructure health and raw state/);
});
