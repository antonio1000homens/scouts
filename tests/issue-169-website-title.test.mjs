import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertCanonicalEventDocument,
  buildCanonicalEventDocument,
} from '../lambdas/shared-layer/nodejs/canonical-event.mjs';
import { mergeCanonicalEventIntoAgenda } from '../lambdas/sqs2scouts/function/agenda-publisher.mjs';
import {
  buildEventReviewSnapshot,
  compareEventReviewRevision,
} from '../lambdas/shared-layer/nodejs/event-review.mjs';

const hex = Buffer.from('water games', 'utf8').toString('hex');
const originalTitle = 'Water Games';
const editorialTitle = 'Cubs Water Games and Team Challenges';

function doc(displayTitle) {
  return buildCanonicalEventDocument({
    title: originalTitle,
    hex,
    displayTitle,
    tagline: 'Splash into adventure',
    imageTheme: 'Summer water games',
    imageUrl: 'website/eventImages/water-games.png',
    isApproved: false,
  });
}

test('website title is independent of the source-derived HEX', () => {
  const event = doc(editorialTitle);
  assert.equal(event.title, originalTitle);
  assert.equal(event.metadata.hex, hex);
  assert.equal(event.metadata.displayTitle, editorialTitle);
  assert.doesNotThrow(() => assertCanonicalEventDocument(event, { expectedHex: hex }));
});

test('legacy HEX events need no migration and null title resets to the calendar', () => {
  const legacy = doc(undefined);
  assert.equal(Object.hasOwn(legacy.metadata, 'displayTitle'), false);
  assert.doesNotThrow(() => assertCanonicalEventDocument(legacy));
  const reset = doc(null);
  assert.equal(reset.metadata.displayTitle, null);
  assert.doesNotThrow(() => assertCanonicalEventDocument(reset));
});

test('title override publication updates every same-HEX occurrence without changing summaries', () => {
  const agenda = {
    events: [0, 1].map(i => ({
      uid: `uid-${i}`,
      summary: originalTitle,
      dtstart: `2027010${i + 1}T180000`,
      metadata: { hex, tagline: null, image: { theme: null, url: null },
        status: { isHidden: false, isApproved: false } },
    })),
  };
  const published = mergeCanonicalEventIntoAgenda(agenda, doc(editorialTitle), hex);
  assert.equal(published.matched, 2);
  assert.deepEqual(published.agenda.events.map(e => e.metadata.displayTitle), [editorialTitle, editorialTitle]);
  assert.deepEqual(published.agenda.events.map(e => e.summary), [originalTitle, originalTitle]);
  assert.deepEqual(published.agenda.events.map(e => e.metadata.hex), [hex, hex]);

  const reset = mergeCanonicalEventIntoAgenda(published.agenda, doc(null), hex);
  assert.deepEqual(reset.agenda.events.map(e => e.metadata.displayTitle), [null, null]);
});

test('edited website title invalidates the review revision, not source identity or media', () => {
  const current = doc(editorialTitle);
  const old = doc(undefined);
  const before = buildEventReviewSnapshot(old);
  const after = buildEventReviewSnapshot(current);
  assert.notEqual(before.revision, after.revision);
  assert.equal(compareEventReviewRevision(current, before.revision).ok, false);
  assert.equal(after.hex, before.hex);
  assert.equal(after.imageUrl, before.imageUrl);
  assert.equal(after.tagline, before.tagline);
});

test('calendar title remains the source of identity and editorial title never becomes a rename', () => {
  const repair = readFileSync('lambdas/scouts/function/agenda-hex-repair.mjs', 'utf8');
  const service = readFileSync('lambdas/scouts/function/scouts-service.mjs', 'utf8');
  assert.match(repair, /titleToHex\(event\.summary \?\? event\.title/);
  assert.match(service, /displayTitle: existingHexFile\?\.metadata\?\.displayTitle/);
  assert.match(service, /baseEvent\.metadata\.displayTitle = trimOptionalText\(existingHexFile\.metadata\.displayTitle\)/);
  assert.match(service, /displayTitleRequest = commandActionToken === 'persistdisplaytitle'/);
  const worker = readFileSync('lambdas/sqs2scouts/function/persistence-processor.mjs', 'utf8');
  assert.match(worker, /oldTitle !== newTitle/);
  assert.match(worker, /baseEvent\.metadata\.status\.isApproved = false/);
});
