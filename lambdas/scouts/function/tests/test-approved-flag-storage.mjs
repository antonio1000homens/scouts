import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareEventForStorage } from '../scouts.mjs';

test('prepareEventForStorage writes structured status with approval state', () => {
  const approvedEvent = prepareEventForStorage({
    uid: 'uid-1',
    title: 'Camp',
    summary: 'Camp',
    dtstart: '20260626T183000',
    hex: '63616d70',
    approved: true,
    image: { prompt: 'camp', url: null },
  });

  assert.deepEqual(approvedEvent.source, {
    uid: 'uid-1',
    title: 'Camp',
    summary: 'Camp',
    location: null,
    dtstart: '20260626T183000',
    section: 'cubs',
    icsType: null,
  });
  assert.equal(approvedEvent.metadata.hexId, '63616d70');
  assert.equal(approvedEvent.status.isApproved, true);
  assert.equal(approvedEvent.status.isHidden, false);

  const pendingEvent = prepareEventForStorage({
    uid: 'uid-2',
    title: 'Hike',
    summary: 'Hike',
    approved: false,
    image: {},
  });

  assert.equal(pendingEvent.metadata.hexId, null);
  assert.equal(pendingEvent.status.isApproved, false);
  assert.equal(pendingEvent.status.isHidden, false);
});

test('prepareEventForStorage accepts flat isApproved compatibility inputs', () => {
  const explicitApprovedEvent = prepareEventForStorage({
    uid: 'uid-3',
    title: 'Climbing',
    isApproved: 'yes',
    image: {},
  });
  assert.equal(explicitApprovedEvent.status.isApproved, true);

  const explicitPendingEvent = prepareEventForStorage({
    uid: 'uid-4',
    title: 'Kayak',
    isApproved: 'no',
    image: {},
  });
  assert.equal(explicitPendingEvent.status.isApproved, false);
});

test('prepareEventForStorage keeps hidden-state compatibility across legacy and new fields', () => {
  const hiddenByStatus = prepareEventForStorage({
    uid: 'uid-5',
    title: 'Campfire',
    status: 'hidden',
    image: {},
  });
  assert.equal(hiddenByStatus.status.isHidden, true);

  const hiddenByTimestamp = prepareEventForStorage({
    uid: 'uid-6',
    title: 'Badge Night',
    hiddenAt: '2026-03-06T12:00:00.000Z',
    image: {},
  });
  assert.equal(hiddenByTimestamp.status.isHidden, true);
  assert.equal(hiddenByTimestamp.status.hiddenAt, '2026-03-06T12:00:00.000Z');

  const explicitVisibleOverride = prepareEventForStorage({
    uid: 'uid-7',
    title: 'Swimming',
    isHidden: 'false',
    hiddenAt: null,
    image: {},
  });
  assert.equal(explicitVisibleOverride.status.isHidden, false);

  const explicitHiddenFlag = prepareEventForStorage({
    uid: 'uid-8',
    title: 'Hike',
    isHidden: 'yes',
    image: {},
  });
  assert.equal(explicitHiddenFlag.status.isHidden, true);
});
