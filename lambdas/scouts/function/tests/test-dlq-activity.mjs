import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

process.env.SCOUTS_REQUEST_ACTIVITY_TABLE_NAME = 'test-request-activity';
const { activityInputFromDlqRecord } = await import('../dlq-activity.mjs');
const { buildRequestActivityUpdate } = await import('../../../shared-layer/nodejs/request-activity.mjs');

const payload = {
  realm: 'tagline', action: 'request', requestId: 'request-123',
  hex: '7375726269746f6e', title: 'Surbiton festival parade',
};

test('processing DLQ messages create a browser-safe terminal activity input', () => {
  const activity = activityInputFromDlqRecord({ messageId: 'sqs-message-123', body: JSON.stringify(payload) });
  assert.deepEqual(activity, {
    requestId: 'request-123', hex: '7375726269746f6e', title: 'Surbiton festival parade', action: 'request',
    state: 'needs_attention', stage: 'scoutsProcessingDLQ', publication: 'failed',
    failure: {
      type: 'WORKER_DELIVERY_EXHAUSTED',
      message: 'Delivery to the Scouts worker exhausted its retry limit. Inspect Operations before redriving this request.',
    },
  });
});

test('processing DLQ records without a request ID create deterministic trackable activity', () => {
  const record = { messageId: 'sqs-message-123', body: JSON.stringify({ hex: payload.hex }) };
  const activity = activityInputFromDlqRecord(record);
  assert.match(activity.requestId, /^dlq-malformed#[a-f0-9]{64}$/);
  assert.equal(activity.requestId, activityInputFromDlqRecord(record).requestId);
  assert.equal(activity.hex, payload.hex);
  assert.equal(activity.failure.type, 'WORKER_DELIVERY_MISSING_REQUEST_ID');
  assert.match(activity.failure.message, /no request ID/);
});

test('invalid JSON and non-object payloads create generic trackable failure activity', () => {
  for (const body of ['not-json', 'null', '[]']) {
    const activity = activityInputFromDlqRecord({ messageId: `message-${body}`, body });
    assert.match(activity.requestId, /^dlq-malformed#[a-f0-9]{64}$/);
    assert.equal(activity.hex, null);
    assert.equal(activity.title, null);
    assert.equal(activity.failure.type, 'WORKER_DELIVERY_INVALID_PAYLOAD');
    assert.equal(activity.failure.message.includes(body), false);
  }
});

test('a DLQ record without its SQS message ID cannot be assigned a stable activity ID', () => {
  assert.equal(activityInputFromDlqRecord({ body: JSON.stringify(payload) }), null);
});

test('duplicate DLQ delivery cannot append another terminal activity timeline entry', () => {
  const update = buildRequestActivityUpdate({ ...activityInputFromDlqRecord({ messageId: 'sqs-message-123', body: JSON.stringify(payload) }), strictTerminal: true });
  assert.match(update.command.input.ConditionExpression, /terminal = :notTerminal/);
  assert.match(update.command.input.ConditionExpression, /priority < :priority/);
  assert.equal(update.command.input.ExpressionAttributeValues[':notTerminal'].S, 'false');
});

test('a successful redrive completion can supersede an exhausted-delivery terminal state', () => {
  const update = buildRequestActivityUpdate({ requestId: payload.requestId, state: 'completed', stage: 'agenda_published' });
  assert.match(update.command.input.ConditionExpression, /:state = :completed/);
  assert.match(update.command.input.ConditionExpression, /:state = :published/);
});

async function loadDlqHandler(recordActivity) {
  const sourcePath = path.resolve(import.meta.dirname, '../dlq-activity-handler.mjs');
  const context = vm.createContext({ console });
  const module = new vm.SourceTextModule(readFileSync(sourcePath, 'utf8'), { context, identifier: sourcePath });
  const modules = new Map();
  const synthetic = (specifier, exports) => {
    const result = new vm.SyntheticModule(Object.keys(exports), function initialize() {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context, identifier: specifier });
    modules.set(specifier, result);
    return result;
  };
  await module.link(async (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    if (specifier === '/opt/nodejs/request-activity.mjs') {
      return synthetic(specifier, { recordWorkerDeliveryExhausted: recordActivity });
    }
    if (specifier === './dlq-activity.mjs') {
      const helperPath = path.resolve(import.meta.dirname, '../dlq-activity.mjs');
      const helperModule = new vm.SourceTextModule(readFileSync(helperPath, 'utf8'), { context, identifier: helperPath });
      modules.set(specifier, helperModule);
      return helperModule;
    }
    if (specifier === 'node:crypto') return synthetic(specifier, { createHash });
    throw new Error(`Unhandled import ${specifier}`);
  });
  await module.evaluate();
  return module.namespace.lambdaHandler;
}

test('handler records malformed DLQ activity and retries the record if the activity write fails', async () => {
  const recorded = [];
  const handler = await loadDlqHandler(async (activity) => { recorded.push(activity); return { recorded: true }; });
  const response = await handler({ Records: [{ messageId: 'sqs-message-bad', body: '{broken' }] });
  assert.equal(response.batchItemFailures.length, 0);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].failure.type, 'WORKER_DELIVERY_INVALID_PAYLOAD');

  const failedHandler = await loadDlqHandler(async () => { throw new Error('DynamoDB unavailable'); });
  const failedResponse = await failedHandler({ Records: [{ messageId: 'sqs-message-failed', body: '{}' }] });
  assert.deepEqual(Array.from(failedResponse.batchItemFailures, (item) => ({ ...item })), [
    { itemIdentifier: 'sqs-message-failed' },
  ]);

  const unavailableHandler = await loadDlqHandler(async () => null);
  const unavailableResponse = await unavailableHandler({ Records: [{ messageId: 'sqs-message-unavailable', body: '{}' }] });
  assert.deepEqual(Array.from(unavailableResponse.batchItemFailures, (item) => ({ ...item })), [
    { itemIdentifier: 'sqs-message-unavailable' },
  ]);
});

test('handler fails the invocation if the SQS message ID is missing', async () => {
  const handler = await loadDlqHandler(async () => {});
  await assert.rejects(handler({ Records: [{ body: '{}' }] }), /missing messageId/);
});
