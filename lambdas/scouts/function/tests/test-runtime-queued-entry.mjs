#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildQueuedRuntimeRequestEntry } from '../scouts.mjs';

test('buildQueuedRuntimeRequestEntry captures external tagline request metadata', () => {
  const entry = buildQueuedRuntimeRequestEntry({
    requestId: 'req-tagline-request',
    realm: 'scoutsRequest',
    subject: 'tagline',
    subjectLabel: 'tagline',
    requestedField: 'tagline',
    hexId: '6b696e6773746f6e',
    title: 'Kingston\u0000 & Surbiton',
    action: 'request',
  }, 'msg-tagline-request', '2026-03-16T18:00:00.000Z');

  assert.deepEqual(entry, {
    requestTime: '2026-03-16T18:00:00.000Z',
    requestId: 'req-tagline-request',
    messageId: 'msg-tagline-request',
    hexId: '6b696e6773746f6e',
    title: 'Kingston  & Surbiton',
    subject: 'tagline',
    realm: 'scoutsRequest',
    action: 'request',
    status: 'queued',
  });
});

test('buildQueuedRuntimeRequestEntry captures external tagline persist metadata', () => {
  const entry = buildQueuedRuntimeRequestEntry({
    requestId: 'req-tagline-persist',
    realm: 'scoutsRequest',
    subject: 'tagline',
    requestedField: 'tagline',
    hexId: '63616d70',
    title: 'Camp Night',
    tagline: 'Ready for camp',
    action: 'persist',
  }, 'msg-tagline-persist', '2026-03-16T18:05:00.000Z');

  assert.equal(entry.hexId, '63616d70');
  assert.equal(entry.title, 'Camp Night');
  assert.equal(entry.subject, 'tagline');
  assert.equal(entry.realm, 'scoutsRequest');
  assert.equal(entry.action, 'persist');
  assert.equal(entry.status, 'queued');
});

test('buildQueuedRuntimeRequestEntry captures external imageTheme request metadata', () => {
  const entry = buildQueuedRuntimeRequestEntry({
    requestId: 'req-image-theme-request',
    realm: 'scoutsRequest',
    subject: 'imageTheme',
    subjectLabel: 'imageTheme',
    requestedField: 'imageTheme',
    hexId: '696d6167657468656d65',
    title: 'Night Walk',
    action: 'request',
  }, 'msg-image-theme-request', '2026-03-16T18:06:00.000Z');

  assert.equal(entry.hexId, '696d6167657468656d65');
  assert.equal(entry.title, 'Night Walk');
  assert.equal(entry.subject, 'imageTheme');
  assert.equal(entry.realm, 'scoutsRequest');
  assert.equal(entry.action, 'request');
});

test('buildQueuedRuntimeRequestEntry captures external imageTheme persist metadata', () => {
  const entry = buildQueuedRuntimeRequestEntry({
    requestId: 'req-image-theme-persist',
    realm: 'scoutsRequest',
    subject: 'imageTheme',
    requestedField: 'imageTheme',
    hexId: '696d6167657468656d65',
    title: 'Night Walk',
    imageTheme: 'Lantern-lit woodland path',
    action: 'persist',
  }, 'msg-image-theme-persist', '2026-03-16T18:07:00.000Z');

  assert.equal(entry.hexId, '696d6167657468656d65');
  assert.equal(entry.title, 'Night Walk');
  assert.equal(entry.subject, 'imageTheme');
  assert.equal(entry.realm, 'scoutsRequest');
  assert.equal(entry.action, 'persist');
});

test('buildQueuedRuntimeRequestEntry captures external imageUrl request metadata', () => {
  const entry = buildQueuedRuntimeRequestEntry({
    requestId: 'req-image-url-request',
    realm: 'scoutsRequest',
    subject: 'imageUrl',
    subjectLabel: 'imageUrl',
    requestedField: 'imageUrl',
    hexId: '696d61676575726c',
    title: 'River Hike',
    action: 'request',
  }, 'msg-image-url-request', '2026-03-16T18:08:00.000Z');

  assert.equal(entry.hexId, '696d61676575726c');
  assert.equal(entry.title, 'River Hike');
  assert.equal(entry.subject, 'imageUrl');
  assert.equal(entry.realm, 'scoutsRequest');
  assert.equal(entry.action, 'request');
});

test('buildQueuedRuntimeRequestEntry captures external imageUrl persist metadata', () => {
  const entry = buildQueuedRuntimeRequestEntry({
    requestId: 'req-image-url-persist',
    realm: 'scoutsRequest',
    subject: 'imageUrl',
    requestedField: 'imageUrl',
    hexId: '696d61676575726c',
    title: 'River Hike',
    imageUrl: 'https://example.com/river-hike.jpg',
    action: 'persist',
  }, 'msg-image-url-persist', '2026-03-16T18:09:00.000Z');

  assert.equal(entry.hexId, '696d61676575726c');
  assert.equal(entry.title, 'River Hike');
  assert.equal(entry.subject, 'imageUrl');
  assert.equal(entry.realm, 'scoutsRequest');
  assert.equal(entry.action, 'persist');
});