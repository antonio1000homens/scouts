import assert from 'node:assert/strict';
import test from 'node:test';
import { occurrenceStorageKey, resolveOccurrenceId, sourceOccurrenceIdentity } from './occurrence-identity.mjs';

test('occurrence identity is stable for a source event and reschedule', () => {
  const first = { uid: 'osm-scouts-event-1793083', dtstart: '2026-12-18T18:00:00Z' };
  const moved = { ...first, dtstart: '2026-12-18T19:00:00Z' };
  assert.equal(sourceOccurrenceIdentity(first), 'osm-event:1793083');
  assert.equal(resolveOccurrenceId(first), resolveOccurrenceId(moved));
});

test('same title with different source occurrences receives distinct IDs', () => {
  const first = { uid: 'calendar-a', summary: 'HOLIDAY', dtstart: '2026-12-18T00:00:00Z' };
  const second = { uid: 'calendar-b', summary: 'HOLIDAY', dtstart: '2026-12-19T00:00:00Z' };
  assert.notEqual(resolveOccurrenceId(first), resolveOccurrenceId(second));
  assert.match(occurrenceStorageKey(resolveOccurrenceId(first)), /^occurrences\/occ_[a-f0-9]{24}\.json$/);
});

