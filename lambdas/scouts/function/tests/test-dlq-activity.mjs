import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SCOUTS_REQUEST_ACTIVITY_TABLE_NAME = 'test-request-activity';
const { activityInputFromDlqRecord } = await import('../dlq-activity.mjs');
const { buildRequestActivityUpdate } = await import('../../../shared-layer/nodejs/request-activity.mjs');

const payload = {
  realm: 'tagline', action: 'request', requestId: 'request-123',
  hex: '7375726269746f6e', title: 'Surbiton festival parade',
};

test('processing DLQ messages create a browser-safe terminal activity input', () => {
  const activity = activityInputFromDlqRecord({ body: JSON.stringify(payload) });
  assert.deepEqual(activity, {
    requestId: 'request-123', hex: '7375726269746f6e', title: 'Surbiton festival parade', action: 'request',
    state: 'needs_attention', stage: 'scoutsProcessingDLQ', publication: 'failed',
    failure: {
      type: 'WORKER_DELIVERY_EXHAUSTED',
      message: 'Delivery to the Scouts worker exhausted its retry limit. Inspect Operations before redriving this request.',
    },
  });
});

test('processing DLQ records without a request ID do not create untrackable browser activity', () => {
  assert.equal(activityInputFromDlqRecord({ body: JSON.stringify({ hex: payload.hex }) }), null);
});

test('duplicate DLQ delivery cannot append another terminal activity timeline entry', () => {
  const update = buildRequestActivityUpdate({ ...activityInputFromDlqRecord({ body: JSON.stringify(payload) }), strictTerminal: true });
  assert.match(update.command.input.ConditionExpression, /terminal = :notTerminal/);
  assert.match(update.command.input.ConditionExpression, /priority < :priority/);
  assert.equal(update.command.input.ExpressionAttributeValues[':notTerminal'].S, 'false');
});

test('a successful redrive completion can supersede an exhausted-delivery terminal state', () => {
  const update = buildRequestActivityUpdate({ requestId: payload.requestId, state: 'completed', stage: 'agenda_published' });
  assert.match(update.command.input.ConditionExpression, /:state = :completed/);
  assert.match(update.command.input.ConditionExpression, /:state = :published/);
});
