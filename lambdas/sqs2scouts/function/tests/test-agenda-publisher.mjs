import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCanonicalEventIntoAgenda, publishCanonicalEventToAgenda } from '../agenda-publisher.mjs';

const HEX = '77617465722067616d6573';

function agenda() {
  return {
    generatedAt: '2026-09-08T21:00:00.000Z',
    events: [{
      uid: 'osm-water-games',
      occurrenceId: 'occ_0123456789abcdef01234567',
      summary: 'Water Games',
      dtstart: '20260715T183000',
      metadata: {
        hex: HEX,
        tagline: null,
        image: { theme: null, url: null },
        status: { isHidden: false, isApproved: false },
      },
    }],
  };
}

function canonical(overrides = {}) {
  return {
    title: 'Water Games',
    metadata: {
      hex: HEX,
      tagline: 'Splash into adventure, fun guaranteed!',
      image: { theme: null, url: null },
      status: { isHidden: false, isApproved: false },
    },
    requests: [],
    ...overrides,
  };
}

test('publishes a partial direct tagline without requiring an image', () => {
  const result = mergeCanonicalEventIntoAgenda(agenda(), canonical(), HEX);
  assert.equal(result.matched, 1);
  assert.equal(result.agenda.events[0].metadata.tagline, 'Splash into adventure, fun guaranteed!');
  assert.equal(result.agenda.events[0].metadata.image.theme, null);
  assert.equal(result.agenda.events[0].metadata.image.url, null);
});

test('shared metadata publication preserves occurrence-owned visibility', () => {
  const hiddenAgenda = agenda();
  hiddenAgenda.events[0].metadata.status.isHidden = true;
  const result = mergeCanonicalEventIntoAgenda(hiddenAgenda, canonical({
    metadata: {
      hex: HEX,
      tagline: 'Updated',
      image: { theme: 'Watercolour water fight', url: 'website/eventImages/water-games.jpg' },
      status: { isHidden: false, isApproved: true },
    },
  }), HEX);
  assert.deepEqual(result.agenda.events[0].metadata, {
    hex: HEX,
    tagline: 'Updated',
    image: { theme: 'Watercolour water fight', url: 'website/eventImages/water-games.jpg' },
    status: { isHidden: true, isApproved: true },
  });
});

test('explicit occurrence visibility changes only the selected same-HEX occurrence', () => {
  const source = agenda();
  source.events = [
    source.events[0],
    {
      ...structuredClone(source.events[0]),
      uid: 'osm-water-games-2',
      occurrenceId: 'occ_89abcdef0123456701234567',
      dtstart: '20260716T183000',
    },
  ];
  const result = mergeCanonicalEventIntoAgenda(source, canonical(), HEX, {
    occurrenceId: 'occ_89abcdef0123456701234567',
    visibility: true,
  });
  assert.equal(result.matched, 1);
  assert.equal(result.agenda.events[0].metadata.status.isHidden, false);
  assert.equal(result.agenda.events[1].metadata.status.isHidden, true);
});

test('HEX-wide visibility changes every matching occurrence', () => {
  const source = agenda();
  source.events = [source.events[0], ...[2, 3, 4, 5].map((index) => ({
    ...structuredClone(source.events[0]),
    uid: `osm-water-games-${index}`,
    occurrenceId: `occ_${String(index).repeat(24)}`,
    dtstart: `202607${String(15 + index).padStart(2, '0')}T183000`,
  }))];
  const result = mergeCanonicalEventIntoAgenda(source, canonical(), HEX, { visibility: true });
  assert.equal(result.matched, 5);
  assert.deepEqual(result.agenda.events.map((event) => event.metadata.status.isHidden), [true, true, true, true, true]);
});

test('publisher rejects compatibility fields in canonical metadata', () => {
  const legacy = canonical();
  legacy.metadata.hexId = HEX;
  assert.throws(
    () => mergeCanonicalEventIntoAgenda(agenda(), legacy, HEX),
    /metadata contains unsupported fields: hexId/,
  );
});

test('publisher only matches agenda entries by canonical metadata.hex', () => {
  const legacyAgenda = agenda();
  legacyAgenda.events[0].hex = HEX;
  delete legacyAgenda.events[0].metadata.hex;
  assert.throws(
    () => mergeCanonicalEventIntoAgenda(legacyAgenda, canonical(), HEX),
    (error) => error?.code === 'AGENDA_EVENT_NOT_FOUND',
  );
});

test('missing agenda event fails publication instead of claiming completion', () => {
  assert.throws(
    () => mergeCanonicalEventIntoAgenda({ events: [] }, canonical(), HEX),
    (error) => error?.code === 'AGENDA_EVENT_NOT_FOUND',
  );
});

test('publisher writes no-store agenda content only after a matching event is merged', async () => {
  const writes = [];
  const result = await publishCanonicalEventToAgenda({
    hex: HEX,
    event: canonical(),
    loadAgenda: async () => agenda(),
    writeAgenda: async (nextAgenda) => {
      writes.push(nextAgenda);
      return { ETag: '"published"' };
    },
  });
  assert.equal(result.matched, 1);
  assert.equal(result.eTag, '"published"');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].events[0].metadata.tagline, 'Splash into adventure, fun guaranteed!');
});
