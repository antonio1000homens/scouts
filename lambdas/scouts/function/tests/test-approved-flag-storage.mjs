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

  assert.equal(approvedEvent.uid, 'uid-1');
  assert.equal(approvedEvent.summary, 'Camp');
  assert.equal(approvedEvent.dtstart, '20260626T183000');
  assert.equal(approvedEvent.metadata.hex, '63616d70');
  assert.deepEqual(approvedEvent.metadata.image, {
    theme: 'camp',
    url: null,
  });
  assert.deepEqual(approvedEvent.metadata.status, {
    isApproved: true,
    isHidden: false,
  });

  const pendingEvent = prepareEventForStorage({
    uid: 'uid-2',
    title: 'Hike',
    summary: 'Hike',
    approved: false,
    image: {},
  });

  assert.equal(pendingEvent.metadata.hex, null);
  assert.deepEqual(pendingEvent.metadata.status, {
    isApproved: false,
    isHidden: false,
  });
});

test('prepareEventForStorage accepts flat isApproved compatibility inputs', () => {
  const explicitApprovedEvent = prepareEventForStorage({
    uid: 'uid-3',
    title: 'Climbing',
    isApproved: 'yes',
    image: {},
  });
  assert.equal(explicitApprovedEvent.metadata.status.isApproved, true);

  const explicitPendingEvent = prepareEventForStorage({
    uid: 'uid-4',
    title: 'Kayak',
    isApproved: 'no',
    image: {},
  });
  assert.equal(explicitPendingEvent.metadata.status.isApproved, false);
});

test('prepareEventForStorage keeps hidden-state compatibility across legacy and new fields', () => {
  const hiddenByStatus = prepareEventForStorage({
    uid: 'uid-5',
    title: 'Campfire',
    status: 'hidden',
    image: {},
  });
  assert.equal(hiddenByStatus.metadata.status.isHidden, true);

  const hiddenByTimestamp = prepareEventForStorage({
    uid: 'uid-6',
    title: 'Badge Night',
    hiddenAt: '2026-03-06T12:00:00.000Z',
    image: {},
  });
  assert.equal(hiddenByTimestamp.metadata.status.isHidden, true);

  const explicitVisibleOverride = prepareEventForStorage({
    uid: 'uid-7',
    title: 'Swimming',
    isHidden: 'false',
    hiddenAt: null,
    image: {},
  });
  assert.equal(explicitVisibleOverride.metadata.status.isHidden, false);

  const explicitHiddenFlag = prepareEventForStorage({
    uid: 'uid-8',
    title: 'Hike',
    isHidden: 'yes',
    image: {},
  });
  assert.equal(explicitHiddenFlag.metadata.status.isHidden, true);
});
