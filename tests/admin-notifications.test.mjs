import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFunctionsFromSource } from './helpers/source-function-loader.mjs';

const adminSource = readFileSync('website/admin/admin-script.js', 'utf8');
const enhancementsSource = readFileSync('website/admin/admin-diagnostics-enhancements.js', 'utf8');

function loadChangeHelpers() {
  return loadFunctionsFromSource(adminSource, [
    'notificationEventIdentity',
    'notificationEventSnapshot',
    'buildAgendaChangeSet',
  ]).functions;
}

function entry(event) {
  return { event };
}

test('browser notification control is opt-in and permission is requested from its change handler', () => {
  assert.match(enhancementsSource, /id = 'browser-notifications-toggle'/);
  assert.match(enhancementsSource, /input\.addEventListener\('change'/);
  assert.match(adminSource, /Notification\.requestPermission\(\)/);
  assert.match(adminSource, /readBrowserNotificationsPreference[\s\S]*return false/);
  assert.match(adminSource, /BROWSER_NOTIFICATIONS_PREF_KEY/);
});

test('agenda polling compares stable event snapshots and avoids initial-load notifications', () => {
  assert.match(adminSource, /const previousAgendaEntries = agendaNotificationBaseline/);
  assert.match(adminSource, /if \(notifyOnAgendaChanges && previousAgendaEntries\)/);
  assert.match(adminSource, /loadEvents\(\{ silent: true, notifyOnAgendaChanges: true, onlyIfChanged: true/);
  assert.match(adminSource, /tag: 'scouts-admin-agenda-change'/);
});

test('new and removed events are detected', () => {
  const { buildAgendaChangeSet } = loadChangeHelpers();
  const before = [entry({ uid: 'old', summary: 'Old event' })];
  const after = [entry({ uid: 'new', summary: 'New event' })];
  const changes = buildAgendaChangeSet(before, after);
  assert.deepEqual(Array.from(changes.added, (item) => item.snapshot.title), ['New event']);
  assert.deepEqual(Array.from(changes.removed, (item) => item.snapshot.title), ['Old event']);
  assert.equal(changes.changed.length, 0);
});

test('image generation is reported as an image change', () => {
  const { buildAgendaChangeSet } = loadChangeHelpers();
  const before = [entry({ uid: 'event-1', summary: 'Camp', metadata: { image: {} } })];
  const after = [entry({ uid: 'event-1', summary: 'Camp', metadata: { image: { url: 'website/eventImages/camp.png' } } })];
  const changes = buildAgendaChangeSet(before, after);
  assert.deepEqual(Array.from(changes.changed[0].changes), ['image']);
});

test('approval, visibility, metadata and event details are detected', () => {
  const { buildAgendaChangeSet } = loadChangeHelpers();
  const before = [entry({
    uid: 'event-1',
    summary: 'Camp',
    dtstart: '2026-09-01T10:00:00Z',
    location: 'Field',
    metadata: { status: { isApproved: false, isHidden: false }, tagline: 'Old', image: { theme: 'Outdoor' } },
  })];
  const after = [entry({
    uid: 'event-1',
    summary: 'Camp updated',
    dtstart: '2026-09-02T10:00:00Z',
    location: 'New field',
    metadata: { status: { isApproved: true, isHidden: true }, tagline: 'New', image: { theme: 'Indoor' } },
  })];
  const changes = buildAgendaChangeSet(before, after);
  assert.deepEqual(Array.from(changes.changed[0].changes), [
    'title', 'date', 'location', 'visibility', 'approval', 'tagline', 'image theme',
  ]);
});

test('identical snapshots do not produce changes and multiple changes remain grouped', () => {
  const { buildAgendaChangeSet } = loadChangeHelpers();
  const unchanged = [entry({ uid: 'same', summary: 'Same' })];
  const identical = buildAgendaChangeSet(unchanged, structuredClone(unchanged));
  assert.equal(identical.hasChanges, false);

  const grouped = buildAgendaChangeSet(
    [entry({ uid: 'one', summary: 'One' })],
    [
      entry({ uid: 'one', summary: 'One updated' }),
      entry({ uid: 'two', summary: 'Two' }),
    ],
  );
  assert.equal(grouped.added.length, 1);
  assert.equal(grouped.changed.length, 1);
  assert.equal(grouped.hasChanges, true);
});
