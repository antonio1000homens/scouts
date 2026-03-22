#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFullEnrichExecutionInput, buildQueuePayload, buildRuntimeRequestEntry } from '../scouts2sqs.mjs';

test('buildQueuePayload translates scoutsRequest tagline request to internal tagline request', () => {
  const payload = buildQueuePayload({
    requestId: 'req-1',
    realm: 'scoutsRequest',
    subject: 'tagline',
    subjectLabel: 'tagline',
    hex: '6b696e6773746f6e',
    title: 'Kingston Visit',
    action: 'request',
  });

  assert.deepEqual(payload, {
    realm: 'tagline',
    action: 'request',
    subject: '6b696e6773746f6e',
    subjectLabel: 'tagline',
    hex: '6b696e6773746f6e',
    title: 'Kingston Visit',
  });
});

test('buildQueuePayload translates scoutsRequest tagline persist to internal persist payload', () => {
  const payload = buildQueuePayload({
    requestId: 'req-2',
    realm: 'scoutsRequest',
    subject: 'tagline',
    subjectLabel: 'tagline',
    hex: '63616d70',
    title: 'Camp Night',
    tagline: 'Ready for camp',
    action: 'persist',
  });

  assert.deepEqual(payload, {
    realm: 'persist',
    action: 'persist',
    subject: {
      hex: '63616d70',
      tagline: 'Ready for camp',
      title: 'Camp Night',
    },
    subjectLabel: 'tagline',
    hex: '63616d70',
    title: 'Camp Night',
  });
});

test('buildRuntimeRequestEntry preserves external tracking fields for scoutsRequest jobs', () => {
  const entry = buildRuntimeRequestEntry({
    messageId: 'msg-1',
    attributes: { SentTimestamp: String(Date.parse('2026-03-16T18:10:00.000Z')) },
  }, {
    requestId: 'req-3',
    realm: 'scoutsRequest',
    subject: 'tagline',
    subjectLabel: 'tagline',
    hex: '6b696e6773746f6e',
    title: 'Kingston Visit',
    action: 'request',
  }, 'processing');

  assert.equal(entry.hex, '6b696e6773746f6e');
  assert.equal(entry.title, 'Kingston Visit');
  assert.equal(entry.subject, 'tagline');
  assert.equal(entry.realm, 'scoutsRequest');
  assert.equal(entry.action, 'request');
  assert.equal(entry.status, 'processing');
});

test('buildRuntimeRequestEntry normalizes translated persist jobs back to logical scoutsRequest tracking fields', () => {
  const entry = buildRuntimeRequestEntry({
    messageId: 'msg-persist',
    attributes: { SentTimestamp: String(Date.parse('2026-03-16T18:15:00.000Z')) },
  }, {
    requestId: 'req-persist',
    realm: 'persist',
    action: 'persist',
    subject: {
      hex: '63616d70',
      tagline: 'Ready for camp',
    },
    title: 'Camp Night',
  }, 'processing');

  assert.equal(entry.requestId, 'req-persist');
  assert.equal(entry.hex, '63616d70');
  assert.equal(entry.title, 'Camp Night');
  assert.equal(entry.subject, 'tagline');
  assert.equal(entry.realm, 'scoutsRequest');
  assert.equal(entry.action, 'persist');
  assert.equal(entry.status, 'processing');
});

test('buildQueuePayload translates scoutsRequest imageTheme request to internal imageTheme request', () => {
  const payload = buildQueuePayload({
    requestId: 'req-4',
    realm: 'scoutsRequest',
    subject: 'imageTheme',
    subjectLabel: 'imageTheme',
    hex: '696d6167657468656d65',
    title: 'Night Walk',
    action: 'request',
  });

  assert.deepEqual(payload, {
    realm: 'imageTheme',
    action: 'request',
    subject: '696d6167657468656d65',
    subjectLabel: 'imageTheme',
    hex: '696d6167657468656d65',
    title: 'Night Walk',
  });
});

test('buildQueuePayload translates scoutsRequest imageTheme persist to internal persist payload', () => {
  const payload = buildQueuePayload({
    requestId: 'req-5',
    realm: 'scoutsRequest',
    subject: 'imageTheme',
    subjectLabel: 'imageTheme',
    hex: '696d6167657468656d65',
    title: 'Night Walk',
    imageTheme: 'Lantern-lit woodland path',
    action: 'persist',
  });

  assert.deepEqual(payload, {
    realm: 'persist',
    action: 'persist',
    subject: {
      hex: '696d6167657468656d65',
      imageTheme: 'Lantern-lit woodland path',
      title: 'Night Walk',
    },
    subjectLabel: 'imageTheme',
    hex: '696d6167657468656d65',
    title: 'Night Walk',
  });
});

test('buildQueuePayload translates scoutsRequest imageUrl request to internal image request', () => {
  const payload = buildQueuePayload({
    requestId: 'req-6',
    realm: 'scoutsRequest',
    subject: 'imageUrl',
    subjectLabel: 'imageUrl',
    hex: '696d61676575726c',
    title: 'River Hike',
    action: 'request',
  });

  assert.deepEqual(payload, {
    realm: 'image',
    action: 'request',
    subject: '696d61676575726c',
    subjectLabel: 'imageUrl',
    hex: '696d61676575726c',
    title: 'River Hike',
  });
});

test('buildQueuePayload translates scoutsRequest imageUrl persist to internal persist payload', () => {
  const payload = buildQueuePayload({
    requestId: 'req-7',
    realm: 'scoutsRequest',
    subject: 'imageUrl',
    subjectLabel: 'imageUrl',
    hex: '696d61676575726c',
    title: 'River Hike',
    imageUrl: 'https://example.com/river-hike.jpg',
    action: 'persist',
  });

  assert.deepEqual(payload, {
    realm: 'persist',
    action: 'persist',
    subject: {
      hex: '696d61676575726c',
      imageUrl: 'https://example.com/river-hike.jpg',
      title: 'River Hike',
    },
    subjectLabel: 'imageUrl',
    hex: '696d61676575726c',
    title: 'River Hike',
  });
});

test('buildFullEnrichExecutionInput normalizes a new full-enrich request for step functions', () => {
  const payload = buildFullEnrichExecutionInput({
    requestId: 'req-full-1',
    realm: 'scoutsRequest',
    action: 'fullEnrich',
    requestMode: 'auto',
    approvalMode: 'auto',
    source: 'scouts',
    subject: {
      hex: '6e6577686578',
      title: 'New Hex Event',
      uid: 'New Hex Event/123',
    },
  }, {
    requestId: 'req-full-1',
    hex: '6e6577686578',
  });

  assert.equal(payload.requestId, 'req-full-1');
  assert.equal(payload.hex, '6e6577686578');
  assert.equal(payload.requestHex, '6e6577686578');
  assert.equal(payload.requestMode, 'auto');
  assert.equal(payload.approvalMode, 'auto');
  assert.equal(payload.orchestrationType, 'fullEnrich');
  assert.equal(payload.source, 'scouts');
  assert.equal(payload.subject.hex, '6e6577686578');
  assert.equal(payload.subject.uid, 'New-Hex-Event');
  assert.equal(payload.subject.originalUid, 'New Hex Event/123');
});
