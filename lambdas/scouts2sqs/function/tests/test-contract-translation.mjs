#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildQueuePayload, buildRuntimeRequestEntry } from '../scouts2sqs.mjs';

test('buildQueuePayload translates scoutsRequest tagline request to internal tagline request', () => {
  const payload = buildQueuePayload({
    requestId: 'req-1',
    realm: 'scoutsRequest',
    subject: 'tagline',
    requestedField: 'tagline',
    hexId: '6b696e6773746f6e',
    title: 'Kingston Visit',
    action: 'request',
  });

  assert.deepEqual(payload, {
    realm: 'tagline',
    action: 'request',
    subject: '6b696e6773746f6e',
    requestedField: 'tagline',
    subjectLabel: 'tagline',
    hexId: '6b696e6773746f6e',
    title: 'Kingston Visit',
  });
});

test('buildQueuePayload translates scoutsRequest tagline persist to internal persist payload', () => {
  const payload = buildQueuePayload({
    requestId: 'req-2',
    realm: 'scoutsRequest',
    subject: 'tagline',
    requestedField: 'tagline',
    hexId: '63616d70',
    title: 'Camp Night',
    tagline: 'Ready for camp',
    action: 'persist',
  });

  assert.deepEqual(payload, {
    realm: 'persist',
    action: 'persist',
    subject: {
      hexId: '63616d70',
      tagline: 'Ready for camp',
      title: 'Camp Night',
    },
    requestedField: 'tagline',
    subjectLabel: 'tagline',
    hexId: '63616d70',
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
    requestedField: 'tagline',
    hexId: '6b696e6773746f6e',
    title: 'Kingston Visit',
    action: 'request',
  }, 'processing');

  assert.equal(entry.hexId, '6b696e6773746f6e');
  assert.equal(entry.title, 'Kingston Visit');
  assert.equal(entry.subject, 'tagline');
  assert.equal(entry.realm, 'scoutsRequest');
  assert.equal(entry.action, 'request');
  assert.equal(entry.status, 'processing');
});

test('buildQueuePayload translates scoutsRequest imageTheme request to internal imageTheme request', () => {
  const payload = buildQueuePayload({
    requestId: 'req-4',
    realm: 'scoutsRequest',
    subject: 'imageTheme',
    requestedField: 'imageTheme',
    hexId: '696d6167657468656d65',
    title: 'Night Walk',
    action: 'request',
  });

  assert.deepEqual(payload, {
    realm: 'imageTheme',
    action: 'request',
    subject: '696d6167657468656d65',
    requestedField: 'imageTheme',
    subjectLabel: 'imageTheme',
    hexId: '696d6167657468656d65',
    title: 'Night Walk',
  });
});

test('buildQueuePayload translates scoutsRequest imageTheme persist to internal persist payload', () => {
  const payload = buildQueuePayload({
    requestId: 'req-5',
    realm: 'scoutsRequest',
    subject: 'imageTheme',
    requestedField: 'imageTheme',
    hexId: '696d6167657468656d65',
    title: 'Night Walk',
    imageTheme: 'Lantern-lit woodland path',
    action: 'persist',
  });

  assert.deepEqual(payload, {
    realm: 'persist',
    action: 'persist',
    subject: {
      hexId: '696d6167657468656d65',
      imageTheme: 'Lantern-lit woodland path',
      title: 'Night Walk',
    },
    requestedField: 'imageTheme',
    subjectLabel: 'imageTheme',
    hexId: '696d6167657468656d65',
    title: 'Night Walk',
  });
});

test('buildQueuePayload translates scoutsRequest imageUrl request to internal image request', () => {
  const payload = buildQueuePayload({
    requestId: 'req-6',
    realm: 'scoutsRequest',
    subject: 'imageUrl',
    requestedField: 'imageUrl',
    hexId: '696d61676575726c',
    title: 'River Hike',
    action: 'request',
  });

  assert.deepEqual(payload, {
    realm: 'image',
    action: 'request',
    subject: '696d61676575726c',
    requestedField: 'imageUrl',
    subjectLabel: 'imageUrl',
    hexId: '696d61676575726c',
    title: 'River Hike',
  });
});

test('buildQueuePayload translates scoutsRequest imageUrl persist to internal persist payload', () => {
  const payload = buildQueuePayload({
    requestId: 'req-7',
    realm: 'scoutsRequest',
    subject: 'imageUrl',
    requestedField: 'imageUrl',
    hexId: '696d61676575726c',
    title: 'River Hike',
    imageUrl: 'https://example.com/river-hike.jpg',
    action: 'persist',
  });

  assert.deepEqual(payload, {
    realm: 'persist',
    action: 'persist',
    subject: {
      hexId: '696d61676575726c',
      imageUrl: 'https://example.com/river-hike.jpg',
      title: 'River Hike',
    },
    requestedField: 'imageUrl',
    subjectLabel: 'imageUrl',
    hexId: '696d61676575726c',
    title: 'River Hike',
  });
});