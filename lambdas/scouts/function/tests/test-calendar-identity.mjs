import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dedupeSectionedEvents,
  mergeEvents,
  parseIcsEvents,
  stableOsmEventIdentity,
} from '../scouts-service.mjs';

const start = {
  raw: '20260923T183000',
  sortKey: '20260923T183000',
  epochMillis: Date.parse('2026-09-23T18:30:00Z'),
};

function event(uid, title = 'Wild Tolworth', metadata = {}) {
  return {
    uid,
    title,
    summary: title,
    location: 'Tolworth Court Farm Fields',
    start,
    sortKey: start.sortKey,
    lastModified: { raw: uid.includes('myscout') ? '20260912T233430Z' : '20260911T233423Z' },
    section: 'cubs',
    image: { prompt: null, url: null },
    metadata,
  };
}

test('ICS parser preserves colons in values', () => {
  const [parsed] = parseIcsEvents([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:osm-scouts-myscout-event-1793083-Europe/London',
    'DTSTART:20260923T183000Z',
    'SUMMARY:Wild Tolworth: Bat Walk with Citizen Zoo',
    'LOCATION:Tolworth Court Farm Fields: North Field',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n'));

  assert.equal(parsed.title, 'Wild Tolworth: Bat Walk with Citizen Zoo');
  assert.equal(parsed.location, 'Tolworth Court Farm Fields: North Field');
});

test('known OSM UID variants resolve to one stable event identity', () => {
  assert.equal(stableOsmEventIdentity('osm-scouts-event-1793083'), 'osm-event:1793083');
  assert.equal(stableOsmEventIdentity('osm-scouts-myscout-event-1793083'), 'osm-event:1793083');
  assert.equal(stableOsmEventIdentity('local-calendar-item-12'), null);
});

test('incoming UID migration replaces one event and retains metadata', () => {
  const metadata = {
    hex: '77696c6420746f6c776f727468',
    tagline: 'Wild adventures await in Tolworth!',
    image: { theme: 'woodland', url: '/website/eventImages/wild.jpg' },
    status: { isHidden: false, isApproved: true },
  };
  const result = mergeEvents(
    { events: [event('osm-scouts-event-1793083', 'Wild Tolworth', metadata)] },
    [event('osm-scouts-myscout-event-1793083', 'Wild Tolworth: Bat Walk with Citizen Zoo')],
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].uid, 'osm-scouts-myscout-event-1793083');
  assert.equal(result[0].title, 'Wild Tolworth: Bat Walk with Citizen Zoo');
  assert.deepEqual(result[0].metadata, metadata);
});

test('duplicate existing records collapse by stable OSM identity', () => {
  const result = mergeEvents(
    { events: [
      event('osm-scouts-event-1793083', 'Wild Tolworth'),
      event('osm-scouts-myscout-event-1793083', 'Wild Tolworth'),
    ] },
    [],
  );
  assert.equal(result.length, 1);
});

test('same title/date events with different stable OSM identities remain separate', () => {
  const result = dedupeSectionedEvents([
    event('osm-scouts-event-1793083'),
    event('osm-scouts-event-1793084'),
  ]);
  assert.equal(result.length, 2);
});
