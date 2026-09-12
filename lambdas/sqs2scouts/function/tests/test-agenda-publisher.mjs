import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCanonicalEventIntoAgenda, publishCanonicalEventToAgenda } from '../agenda-publisher.mjs';

const HEX = '77617465722067616d6573';

function agenda() {
  return {
    generatedAt: '2026-09-08T21:00:00.000Z',
    events: [{
      uid: 'osm-water-games',
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

test('publishes image, approval, and visibility changes from the canonical HEX event', () => {
  const result = mergeCanonicalEventIntoAgenda(agenda(), canonical({
    metadata: {
      hex: HEX,
      tagline: 'Updated',
      image: { theme: 'Watercolour water fight', url: 'website/eventImages/water-games.jpg' },
      status: { isHidden: true, isApproved: true },
    },
  }), HEX);
  assert.deepEqual(result.agenda.events[0].metadata, {
    hex: HEX,
    tagline: 'Updated',
    image: { theme: 'Watercolour water fight', url: 'website/eventImages/water-games.jpg' },
    status: { isHidden: true, isApproved: true },
  });
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
