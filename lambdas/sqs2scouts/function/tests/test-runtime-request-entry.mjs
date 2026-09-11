#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRuntimeRequestEntry } from '../runtime-request-entry.mjs';

test('buildRuntimeRequestEntry preserves translated persist metadata for downstream tracking', () => {
  const entry = buildRuntimeRequestEntry({
    messageId: 'msg-persist',
    attributes: { SentTimestamp: String(Date.parse('2026-03-16T18:15:00.000Z')) },
  }, {
    requestId: 'req-persist',
    realm: 'persist',
    action: 'persist',
    requestedField: 'tagline',
    subject: {
      hexId: '63616d70',
      tagline: 'Ready for camp',
    },
    title: 'Camp Night',
  }, 'completed');

  assert.equal(entry.requestId, 'req-persist');
  assert.equal(entry.hexId, '63616d70');
  assert.equal(entry.title, 'Camp Night');
  assert.equal(entry.subject, 'tagline');
  assert.equal(entry.realm, 'persist');
  assert.equal(entry.action, 'persist');
  assert.equal(entry.status, 'completed');
});
