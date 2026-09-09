import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SCOUTS_REQUEST_ACTIVITY_TABLE_NAME = 'test-request-activity';
const { buildRequestActivityUpdate } = await import('./request-activity.mjs');

test('activity ledger update only supplies DynamoDB placeholders used by the expression', () => {
  const update = buildRequestActivityUpdate({
    requestId: 'request-123', hex: '686578', action: 'generateTagline', state: 'queued', at: new Date('2026-09-09T00:00:00.000Z'),
  });
  assert.equal(update.command.input.Key.requestId.S, 'request-123');
  assert.equal(update.command.input.ExpressionAttributeValues[':requestId'], undefined);
  assert.match(update.command.input.UpdateExpression, /feed = :feed/);
  assert.match(update.command.input.ConditionExpression, /priority <= :priority/);
});
