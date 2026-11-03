import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SCOUTS_DEFERRED_REFRESH_TABLE_NAME ||= 'test-deferred-refresh';

const {
  buildDeferredRefreshWork,
  drainDeferredRefreshQueue,
  enqueueDeferredRefresh,
  getDeferredRefreshStatus,
  resetDeferredRefreshClientForTests,
  setDeferredRefreshClientForTests,
} = await import('../runtime-deferred-refresh.mjs');

const NOW = new Date('2026-11-03T12:00:00.000Z');
const GENERATION = 'a'.repeat(64);
const SUBJECT = { title: 'Camp', metadata: { hex: '63616d70' }, uid: 'private-uid', originalUid: 'old-private-uid' };

function itemAttributes(overrides = {}) {
  return {
    workKey: { S: 'work-1' },
    requestId: { S: 'deferred-work-1' },
    rootRequestId: { S: 'deferred-work-1' },
    hex: { S: '63616d70' },
    stage: { S: 'tagline' },
    generationId: { S: GENERATION },
    title: { S: 'Camp' },
    subjectJson: { S: JSON.stringify({ title: 'Camp', metadata: { hex: '63616d70' } }) },
    state: { S: 'ready' },
    createdAt: { S: NOW.toISOString() },
    expiresAt: { N: String(Math.floor(NOW.getTime() / 1000) + 86400) },
    attemptCount: { N: '0' },
    ...overrides,
  };
}

test('deferred work keys are stable by HEX, stage and generation, with private IDs stripped', () => {
  const input = { hex: '63616D70', stage: 'tagline', generationId: GENERATION, title: 'Camp', subject: SUBJECT, sourceKey: 'cubsevents#cubs' };
  const first = buildDeferredRefreshWork(input, { now: NOW });
  const second = buildDeferredRefreshWork(input, { now: NOW });
  assert.equal(first.workKey, second.workKey);
  assert.equal(first.requestId, second.requestId);
  assert.equal(first.requestId, first.rootRequestId);
  assert.deepEqual(JSON.parse(first.subjectJson), {
    title: 'Camp', hex: '63616d70',
    metadata: {
      hex: '63616d70', tagline: null, image: { theme: null, url: null },
      status: { isHidden: false, isApproved: false },
    },
  });
  assert.notEqual(first.workKey, buildDeferredRefreshWork({ ...input, generationId: 'b'.repeat(64) }, { now: NOW }).workKey);
  assert.throws(() => buildDeferredRefreshWork({ ...input, sourceKey: 'https://private.example/feed#cubs' }, { now: NOW }), /must be a feed identifier/);
});

test('enqueue uses one conditional outbox item and atomically coalesces source feed identifiers', async () => {
  const sent = [];
  setDeferredRefreshClientForTests({
    async send(command) {
      sent.push(command);
      return { Attributes: itemAttributes() };
    },
  });
  try {
    const result = await enqueueDeferredRefresh({
      hex: '63616d70', stage: 'tagline', generationId: GENERATION,
      title: 'Camp', subject: SUBJECT, sourceKey: 'cubsevents#cubs',
    }, { now: NOW });
    assert.equal(result.enqueued, true);
    const update = sent[0].input;
    assert.match(update.ConditionExpression, /:ready, :leased/);
    assert.match(update.ConditionExpression, /expiresAt > :nowEpoch/);
    assert.match(update.UpdateExpression, /ADD sourceKeys :sourceKeys/);
    assert.equal(update.ExpressionAttributeValues[':sourceKeys'].SS[0], 'cubsevents#cubs');
  } finally {
    resetDeferredRefreshClientForTests();
  }
});

test('terminal duplicate discovery is not revived', async () => {
  const commands = [];
  setDeferredRefreshClientForTests({
    async send(command) {
      commands.push(command);
      if (command.constructor.name === 'UpdateItemCommand') {
        const error = new Error('condition failed');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      return { Item: { state: { S: 'dispatched' } } };
    },
  });
  try {
    const result = await enqueueDeferredRefresh({
      hex: '63616d70', stage: 'tagline', generationId: GENERATION,
      title: 'Camp', subject: SUBJECT, sourceKey: 'cubsevents#cubs',
    }, { now: NOW });
    assert.deepEqual(result, {
      enqueued: false,
      state: 'dispatched',
      workKey: buildDeferredRefreshWork({
        hex: '63616d70', stage: 'tagline', generationId: GENERATION,
        title: 'Camp', subject: SUBJECT, sourceKey: 'cubsevents#cubs',
      }, { now: NOW }).workKey,
      requestId: buildDeferredRefreshWork({
        hex: '63616d70', stage: 'tagline', generationId: GENERATION,
        title: 'Camp', subject: SUBJECT, sourceKey: 'cubsevents#cubs',
      }, { now: NOW }).requestId,
    });
    assert.equal(commands.length, 2);
    assert.equal(commands[1].input.ConsistentRead, true);
  } finally {
    resetDeferredRefreshClientForTests();
  }
});

test('dispatcher claims due work conditionally, publishes stable IDs, then marks dispatched', async () => {
  const commands = [];
  const attributes = itemAttributes();
  setDeferredRefreshClientForTests({
    async send(command) {
      commands.push(command);
      if (command.constructor.name === 'QueryCommand') {
        const state = command.input.ExpressionAttributeValues[':state'].S;
        return { Items: state === 'ready' ? [{ workKey: { S: 'work-1' }, nextAttemptAt: { S: `${NOW.toISOString()}#work-1` }, state: { S: 'ready' } }] : [] };
      }
      if (command.constructor.name === 'GetItemCommand') return { Item: attributes };
      if (command.input.UpdateExpression.includes(':leased')) {
        return { Attributes: itemAttributes({ state: { S: 'leased' }, leaseId: command.input.ExpressionAttributeValues[':leaseId'], attemptCount: { N: '1' } }) };
      }
      return {};
    },
  });
  try {
    let published;
    const result = await drainDeferredRefreshQueue({
      now: NOW,
      publish: async (payload) => { published = payload; return { messageId: 'sqs-1' }; },
    });
    assert.equal(result.dispatched, 1);
    assert.equal(published.requestId, 'deferred-work-1');
    assert.equal(published.action, 'new');
    assert.equal(commands.filter((command) => command.constructor.name === 'UpdateItemCommand').length, 2);
    assert.match(commands.at(-1).input.UpdateExpression, /dispatchedAt/);
  } finally {
    resetDeferredRefreshClientForTests();
  }
});

test('dispatcher backs off failed sends and exposes terminal queues with a bounded read', async () => {
  const commands = [];
  const attributes = itemAttributes();
  setDeferredRefreshClientForTests({
    async send(command) {
      commands.push(command);
      if (command.constructor.name === 'QueryCommand') {
        const state = command.input.ExpressionAttributeValues[':state'].S;
        if (state === 'ready') return { Items: [{ workKey: { S: 'work-1' }, nextAttemptAt: { S: `${NOW.toISOString()}#work-1` }, state: { S: 'ready' } }] };
        return { Items: [] };
      }
      if (command.constructor.name === 'GetItemCommand') return { Item: attributes };
      if (command.input.UpdateExpression.includes(':leased')) {
        return { Attributes: itemAttributes({ state: { S: 'leased' }, leaseId: command.input.ExpressionAttributeValues[':leaseId'], attemptCount: { N: '1' } }) };
      }
      return {};
    },
  });
  try {
    const result = await drainDeferredRefreshQueue({ now: NOW, publish: async () => { throw Object.assign(new Error('queue unavailable'), { name: 'ServiceUnavailable' }); } });
    assert.equal(result.retried, 1);
    const failedUpdate = commands.at(-1).input;
    assert.match(failedUpdate.UpdateExpression, /nextAttemptAt = :nextAttemptAt/);
    assert.match(failedUpdate.ConditionExpression, /leaseId = :leaseId/);
    assert.equal(failedUpdate.ExpressionAttributeValues[':nextState'].S, 'ready');
  } finally {
    resetDeferredRefreshClientForTests();
  }
});

test('dispatcher recovers stale leases and sends exhausted work to needs_attention', async () => {
  for (const [attemptCount, expected] of [[1, 'ready'], [6, 'needs_attention']]) {
    const commands = [];
    const leasedAttributes = itemAttributes({
      state: { S: 'leased' },
      attemptCount: { N: String(attemptCount) },
      nextAttemptAt: { S: `${NOW.toISOString()}#work-1` },
      leaseUntil: { S: `${NOW.toISOString()}#work-1` },
    });
    setDeferredRefreshClientForTests({
      async send(command) {
        commands.push(command);
        if (command.constructor.name === 'QueryCommand') {
          const state = command.input.ExpressionAttributeValues[':state'].S;
          return { Items: state === 'leased' ? [{ workKey: { S: 'work-1' }, nextAttemptAt: { S: `${NOW.toISOString()}#work-1` }, state: { S: 'leased' } }] : [] };
        }
        if (command.constructor.name === 'GetItemCommand') return { Item: leasedAttributes };
        return {};
      },
    });
    try {
      const result = await drainDeferredRefreshQueue({ now: NOW, publish: async () => { throw new Error('must not publish stale lease in same pass'); } });
      assert.equal(result.leaseRecovered, expected === 'ready' ? 1 : 0);
      assert.equal(result.needsAttention, expected === 'needs_attention' ? 1 : 0);
      const recovery = commands.find((command) => command.constructor.name === 'UpdateItemCommand');
      assert.equal(recovery.input.ExpressionAttributeValues[':nextState'].S, expected);
      assert.match(recovery.input.ConditionExpression, /#state = :leased/);
    } finally {
      resetDeferredRefreshClientForTests();
    }
  }
});

test('dispatcher never processes more than its configured bounded batch', async () => {
  const commands = [];
  const dueItems = Array.from({ length: 15 }, (_, index) => ({
    workKey: { S: `work-${index}` },
    nextAttemptAt: { S: `${NOW.toISOString()}#work-${String(index).padStart(2, '0')}` },
    state: { S: 'ready' },
  }));
  const dueAttributes = (key) => itemAttributes({
    workKey: { S: key },
    requestId: { S: `deferred-${key}` },
    rootRequestId: { S: `deferred-${key}` },
  });
  setDeferredRefreshClientForTests({
    async send(command) {
      commands.push(command);
      if (command.constructor.name === 'QueryCommand') {
        const state = command.input.ExpressionAttributeValues[':state'].S;
        return { Items: state === 'ready' ? dueItems.slice(0, command.input.Limit) : [] };
      }
      if (command.constructor.name === 'GetItemCommand') return { Item: dueAttributes(command.input.Key.workKey.S) };
      if (command.input.UpdateExpression.includes(':leased')) {
        const key = command.input.Key.workKey.S;
        return { Attributes: dueAttributes(key) };
      }
      return {};
    },
  });
  try {
    let published = 0;
    const result = await drainDeferredRefreshQueue({
      now: NOW,
      limit: 50,
      publish: async () => { published += 1; return {}; },
    });
    assert.equal(result.dispatched, 10);
    assert.equal(published, 10);
    assert.ok(commands.filter((command) => command.constructor.name === 'QueryCommand').every((command) => command.input.Limit === 10));
  } finally {
    resetDeferredRefreshClientForTests();
  }
});

test('expired ready work is marked visible as expired instead of being dispatched', async () => {
  const commands = [];
  const expired = itemAttributes({ expiresAt: { N: String(Math.floor(NOW.getTime() / 1000) - 1) } });
  setDeferredRefreshClientForTests({
    async send(command) {
      commands.push(command);
      if (command.constructor.name === 'QueryCommand') {
        const state = command.input.ExpressionAttributeValues[':state'].S;
        return { Items: state === 'ready' ? [{ workKey: { S: 'work-1' }, nextAttemptAt: { S: `${NOW.toISOString()}#work-1` }, state: { S: 'ready' } }] : [] };
      }
      if (command.constructor.name === 'GetItemCommand') return { Item: expired };
      return {};
    },
  });
  try {
    const result = await drainDeferredRefreshQueue({ now: NOW, publish: async () => { throw new Error('expired work must not publish'); } });
    assert.equal(result.expired, 1);
    assert.equal(result.dispatched, 0);
    const terminal = commands.find((command) => command.constructor.name === 'UpdateItemCommand');
    assert.match(terminal.input.UpdateExpression, /terminalReason/);
    assert.match(terminal.input.UpdateExpression, /nextAttemptAt/);
    assert.equal(terminal.input.ExpressionAttributeValues[':state'].S, 'expired');
  } finally {
    resetDeferredRefreshClientForTests();
  }
});

test('outbox capacity throttling propagates for scheduled retry instead of dropping work', async () => {
  const error = Object.assign(new Error('DynamoDB throttled'), { name: 'ProvisionedThroughputExceededException' });
  setDeferredRefreshClientForTests({ async send() { throw error; } });
  try {
    await assert.rejects(
      drainDeferredRefreshQueue({ now: NOW, publish: async () => assert.fail('must not publish when the outbox read is throttled') }),
      /DynamoDB throttled/,
    );
  } finally {
    resetDeferredRefreshClientForTests();
  }
});

test('status lookup is bounded and reports oldest sample and continuation state', async () => {
  const commands = [];
  setDeferredRefreshClientForTests({
    async send(command) {
      commands.push(command);
      return { Items: [{ nextAttemptAt: { S: `${NOW.toISOString()}#work-1` }, workKey: { S: 'work-1' } }], LastEvaluatedKey: { workKey: { S: 'more' } } };
    },
  });
  try {
    const status = await getDeferredRefreshStatus({ limit: 20 });
    assert.equal(status.bounded, true);
    assert.equal(status.states.ready.sampledItems, 1);
    assert.equal(status.states.ready.oldestReadyAt, NOW.toISOString());
    assert.equal(status.states.ready.hasMore, true);
    assert.equal(commands.length, 6);
    assert.ok(commands.every((command) => command.input.Limit === 20));
  } finally {
    resetDeferredRefreshClientForTests();
  }
});
