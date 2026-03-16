#!/usr/bin/env node

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pruneQueuedRuntimeRequests } from '../scouts.mjs';

test('Runtime queued snapshot pruning', async (t) => {
  await t.test('removes queued requests that already completed successfully', () => {
    const queuedEntries = [
      {
        requestTime: '2026-03-16T10:00:00.000Z',
        requestId: 'req-completed',
        messageId: 'msg-completed',
        hexId: '6a756d7020696e',
        title: 'Jump In',
        realm: 'approval',
        action: 'approve',
        status: 'queued',
      },
      {
        requestTime: '2026-03-16T10:05:00.000Z',
        requestId: 'req-active',
        messageId: 'msg-active',
        hexId: '686f6c64',
        title: 'Hold Fast',
        realm: 'approval',
        action: 'approve',
        status: 'queued',
      },
    ];

    const completedSnapshot = {
      requests: [
        {
          requestTime: '2026-03-16T10:07:00.000Z',
          requestId: 'req-completed',
          messageId: 'msg-completed',
          hexId: '6a756d7020696e',
          title: 'Jump In',
          realm: 'approval',
          action: 'approve',
          status: 'completed',
          completedAt: '2026-03-16T10:08:00.000Z',
        },
      ],
    };

    const result = pruneQueuedRuntimeRequests(queuedEntries, null, completedSnapshot, Date.parse('2026-03-16T10:10:00.000Z'));

    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0]?.requestId, 'req-active');
    assert.equal(result.removedCount, 1);
  });

  await t.test('keeps only the newest queued entry for the same hex/action signature', () => {
    const queuedEntries = [
      {
        requestTime: '2026-03-16T09:55:00.000Z',
        requestId: 'req-older',
        messageId: 'msg-older',
        hexId: '6a756d7020696e',
        title: 'Jump In',
        realm: 'approval',
        action: 'approve',
        status: 'queued',
      },
      {
        requestTime: '2026-03-16T10:05:00.000Z',
        requestId: 'req-newer',
        messageId: 'msg-newer',
        hexId: '6a756d7020696e',
        title: 'Jump In',
        realm: 'approval',
        action: 'approve',
        status: 'queued',
      },
      {
        requestTime: '2026-03-16T10:06:00.000Z',
        requestId: 'req-different-action',
        messageId: 'msg-different-action',
        hexId: '6a756d7020696e',
        title: 'Jump In',
        realm: 'persist',
        action: 'persist',
        status: 'queued',
      },
    ];

    const result = pruneQueuedRuntimeRequests(queuedEntries, null, null, Date.parse('2026-03-16T10:10:00.000Z'));

    assert.deepEqual(
      result.requests.map((entry) => entry.requestId),
      ['req-newer', 'req-different-action']
    );
    assert.equal(result.removedCount, 1);
  });
});
