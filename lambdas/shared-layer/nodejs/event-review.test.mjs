import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalIdempotencyKey,
  buildApprovedSnapshotPatch,
  buildEventReviewSnapshot,
  compareEventReviewRevision,
  eventReviewRevision,
} from './event-review.mjs';

function event(overrides = {}) {
  return {
    uid: 'osm-123',
    title: 'Campfire night',
    metadata: {
      hex: 'ABCD',
      tagline: 'Join us by the fire',
      image: {
        theme: 'campfire at dusk',
        url: null,
      },
      status: {
        isHidden: false,
        isApproved: false,
      },
    },
    ...overrides,
  };
}

test('review snapshot normalises reviewable fields and generates a stable revision', () => {
  const snapshot = buildEventReviewSnapshot(event());
  assert.deepEqual(snapshot, {
    hex: 'abcd',
    tagline: 'Join us by the fire',
    imageTheme: 'campfire at dusk',
    imageUrl: null,
    isHidden: false,
    revision: snapshot.revision,
    title: 'Campfire night',
    uid: 'osm-123',
  });
  assert.match(snapshot.revision, /^[a-f0-9]{24}$/);
  assert.equal(snapshot.revision, eventReviewRevision(snapshot));
});

test('non-review display fields do not change the revision', () => {
  const first = buildEventReviewSnapshot(event());
  const second = buildEventReviewSnapshot(event({ title: 'Renamed only for display' }));
  assert.equal(first.revision, second.revision);
});

test('every reviewable field changes the revision', () => {
  const base = buildEventReviewSnapshot(event());
  const variants = [
    event({ metadata: { ...event().metadata, tagline: 'Different tagline' } }),
    event({ metadata: { ...event().metadata, image: { ...event().metadata.image, theme: 'different theme' } } }),
    event({ metadata: { ...event().metadata, image: { ...event().metadata.image, url: 'website/eventImages/a.png' } } }),
    event({ metadata: { ...event().metadata, status: { ...event().metadata.status, isHidden: true } } }),
  ];
  for (const variant of variants) {
    assert.notEqual(buildEventReviewSnapshot(variant).revision, base.revision);
  }
});

test('stale submitted revision is rejected against current canonical state', () => {
  const oldSnapshot = buildEventReviewSnapshot(event());
  const changed = event({ metadata: { ...event().metadata, tagline: 'Changed elsewhere' } });
  const comparison = compareEventReviewRevision(changed, oldSnapshot.revision);
  assert.equal(comparison.ok, false);
  assert.equal(comparison.submittedRevision, oldSnapshot.revision);
  assert.notEqual(comparison.currentRevision, oldSnapshot.revision);
  assert.equal(comparison.current.tagline, 'Changed elsewhere');
});

test('current submitted revision is accepted', () => {
  const current = event();
  const snapshot = buildEventReviewSnapshot(current);
  const comparison = compareEventReviewRevision(current, snapshot.revision);
  assert.equal(comparison.ok, true);
  assert.equal(comparison.currentRevision, snapshot.revision);
});

test('approving snapshot without an image persists metadata but requires image generation and final review', () => {
  const snapshot = buildEventReviewSnapshot(event());
  const patch = buildApprovedSnapshotPatch(snapshot);
  assert.deepEqual(patch.metadata, {
    hex: 'abcd',
    tagline: 'Join us by the fire',
    image: {
      theme: 'campfire at dusk',
      url: null,
    },
    status: {
      isHidden: false,
      isApproved: false,
    },
  });
  assert.deepEqual(patch.approval, {
    revision: snapshot.revision,
    nextState: 'awaiting_image',
    requiresGeneratedImage: true,
    requiresFinalImageReview: true,
  });
});

test('approving snapshot with a visible image can complete approval immediately', () => {
  const withImage = event({
    metadata: {
      ...event().metadata,
      image: {
        theme: 'campfire at dusk',
        url: 'website/eventImages/manual.png',
      },
    },
  });
  const snapshot = buildEventReviewSnapshot(withImage);
  const patch = buildApprovedSnapshotPatch(snapshot);
  assert.equal(patch.metadata.status.isApproved, true);
  assert.equal(patch.approval.nextState, 'approved');
  assert.equal(patch.approval.requiresGeneratedImage, false);
  assert.equal(patch.approval.requiresFinalImageReview, false);
});

test('approval patch rejects a snapshot whose values no longer match its revision', () => {
  const snapshot = buildEventReviewSnapshot(event());
  const tampered = { ...snapshot, tagline: 'Changed after review' };
  assert.throws(() => buildApprovedSnapshotPatch(tampered), /revision does not match/);
});

test('approval idempotency key is stable for root operation, revision and action', () => {
  const snapshot = buildEventReviewSnapshot(event());
  const first = approvalIdempotencyKey({ rootRequestId: 'root-123', revision: snapshot.revision, action: 'approve' });
  const second = approvalIdempotencyKey({ rootRequestId: 'root-123', revision: snapshot.revision, action: 'APPROVE' });
  const different = approvalIdempotencyKey({ rootRequestId: 'root-124', revision: snapshot.revision, action: 'approve' });
  assert.equal(first, second);
  assert.notEqual(first, different);
  assert.match(first, /^[a-f0-9]{64}$/);
});
