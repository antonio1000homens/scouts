import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SCOUTS_REQUEST_ACTIVITY_TABLE_NAME = 'test-request-activity';
const {
  buildRequestActivityUpdate,
  trackReconciliationPublication,
  withRequestActivityContext,
} = await import('./request-activity.mjs');

test('activity ledger update only supplies DynamoDB placeholders used by the expression', () => {
  const update = buildRequestActivityUpdate({
    requestId: 'request-123', hex: '686578', action: 'generateTagline', state: 'queued', at: new Date('2026-09-09T00:00:00.000Z'),
  });
  assert.equal(update.command.input.Key.requestId.S, 'request-123');
  assert.equal(update.command.input.ExpressionAttributeValues[':requestId'], undefined);
  assert.match(update.command.input.UpdateExpression, /feed = :feed/);
  assert.match(update.command.input.ConditionExpression, /priority <= :priority/);
});

test('activity ledger defaults rootRequestId to requestId for backwards compatibility', () => {
  const update = buildRequestActivityUpdate({
    requestId: 'request-123',
    hex: '686578',
    action: 'approve',
    state: 'processing',
    at: new Date('2026-09-09T00:00:00.000Z'),
  });
  assert.equal(update.rootRequestId, 'request-123');
  assert.equal(update.command.input.ExpressionAttributeValues[':rootRequestId'].S, 'request-123');
  assert.match(update.command.input.UpdateExpression, /rootRequestId = if_not_exists\(rootRequestId, :rootRequestId\)/);
});

test('explicit rootRequestId is persisted independently of child requestId', () => {
  const update = buildRequestActivityUpdate({
    requestId: 'child-image-456',
    rootRequestId: 'approval-root-123',
    hex: '686578',
    action: 'imageEnrich',
    state: 'awaiting_image',
    at: new Date('2026-09-09T00:00:00.000Z'),
  });
  assert.equal(update.requestId, 'child-image-456');
  assert.equal(update.rootRequestId, 'approval-root-123');
  assert.equal(update.command.input.ExpressionAttributeValues[':rootRequestId'].S, 'approval-root-123');
  assert.equal(update.command.input.ExpressionAttributeValues[':state'].S, 'awaiting_image');
  assert.equal(update.command.input.ExpressionAttributeValues[':terminal'].S, 'false');
});

test('operationId is accepted as a migration alias for rootRequestId', () => {
  const update = buildRequestActivityUpdate({
    requestId: 'child-review-456',
    operationId: 'approval-root-123',
    state: 'awaiting_review',
    at: new Date('2026-09-09T00:00:00.000Z'),
  });
  assert.equal(update.rootRequestId, 'approval-root-123');
  assert.equal(update.command.input.ExpressionAttributeValues[':state'].S, 'awaiting_review');
  assert.equal(update.command.input.ExpressionAttributeValues[':terminal'].S, 'false');
});

test('activity context supplies rootRequestId to child writes', async () => {
  const context = { rootRequestId: 'approval-root-context' };
  await withRequestActivityContext(context, async () => {
    const update = buildRequestActivityUpdate({
      requestId: 'child-from-context',
      state: 'processing',
      at: new Date('2026-09-09T00:00:00.000Z'),
    });
    assert.equal(update.rootRequestId, 'approval-root-context');
    assert.equal(update.command.input.ExpressionAttributeValues[':rootRequestId'].S, 'approval-root-context');
  });
});

test('reconciliation context is persisted on queued activity', async () => {
  const context = { reconciliationId: 'reconcile-123' };
  await withRequestActivityContext(context, async () => {
    const update = buildRequestActivityUpdate({
      requestId: 'request-456',
      hex: '686578',
      action: 'new',
      state: 'queued',
      stage: 'scoutsRequests',
      at: new Date('2026-09-09T00:00:00.000Z'),
    });
    assert.equal(update.reconciliationId, 'reconcile-123');
    assert.equal(update.command.input.ExpressionAttributeValues[':reconciliationId'].S, 'reconcile-123');
    assert.match(update.command.input.UpdateExpression, /reconciliationId = if_not_exists\(reconciliationId, :reconciliationId\)/);
  });
});

test('concurrent reconciliation contexts count only their own successful queue publications', async () => {
  const first = { reconciliationId: 'reconcile-first' };
  const second = { reconciliationId: 'reconcile-second' };

  await Promise.all([
    withRequestActivityContext(first, async () => {
      await Promise.resolve();
      assert.equal(trackReconciliationPublication({ requestId: 'first-1', action: 'new', state: 'queued', stage: 'scoutsRequests' }), true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(trackReconciliationPublication({ requestId: 'first-2', action: 'imageEnrich', state: 'queued', stage: 'scoutsRequests' }), true);
      assert.equal(trackReconciliationPublication({ requestId: 'first-2', action: 'imageEnrich', state: 'queued', stage: 'scoutsRequests' }), false);
    }),
    withRequestActivityContext(second, async () => {
      assert.equal(trackReconciliationPublication({ requestId: 'second-1', action: 'new', state: 'queued', stage: 'scoutsRequests' }), true);
      assert.equal(trackReconciliationPublication({ requestId: 'second-not-enrichment', action: 'status', state: 'queued', stage: 'scoutsRequests' }), false);
    }),
  ]);

  assert.equal(first.enrichmentRequestsStarted, 2);
  assert.equal(second.enrichmentRequestsStarted, 1);
  assert.deepEqual([...first.enrichmentRequestIds].sort(), ['first-1', 'first-2']);
  assert.deepEqual([...second.enrichmentRequestIds], ['second-1']);
});

test('publication without a reconciliation context is not counted', () => {
  assert.equal(trackReconciliationPublication({ requestId: 'unrelated-1', action: 'new', state: 'queued', stage: 'scoutsRequests' }), false);
});
