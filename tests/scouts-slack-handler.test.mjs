import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFunctionsFromSource } from './helpers/source-function-loader.mjs';

const source = readFileSync('lambdas/scouts-slack-handler/function/slack-handler.mjs', 'utf8');

function loadSlackHelpers() {
  return loadFunctionsFromSource(source, ['parseActionValue', 'handleSkipInteraction']).functions;
}

test('Skip returns an empty 200 acknowledgement and does not enqueue work', async () => {
  const { handleSkipInteraction } = loadSlackHelpers();
  let replacementCalls = 0;
  const result = await handleSkipInteraction({
    eventTitle: 'Synthetic event',
    responseUrl: null,
    sendResponse: async () => {
      replacementCalls += 1;
      return { statusCode: 200 };
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body, '');
  assert.equal(replacementCalls, 0);
});

test('malformed or empty action values still produce a safe Skip acknowledgement', async () => {
  const { parseActionValue, handleSkipInteraction } = loadSlackHelpers();
  for (const value of [parseActionValue(undefined), parseActionValue('{not-json')]) {
    assert.deepEqual(Object.keys(value), ['event', 'meta']);
    assert.deepEqual(Object.keys(value.event), []);
    assert.deepEqual(Object.keys(value.meta), []);
  }

  const result = await handleSkipInteraction({
    eventTitle: 'event',
    responseUrl: null,
    sendResponse: async () => ({ statusCode: 200 }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Content-Type'], 'application/json');
  assert.equal(result.body, '');
});

test('response-url replacement failure cannot turn Skip into an HTTP failure', async () => {
  const { handleSkipInteraction } = loadSlackHelpers();
  const result = await handleSkipInteraction({
    eventTitle: 'Synthetic event',
    responseUrl: 'https://hooks.slack.test/response',
    sendResponse: async () => {
      throw new Error('response URL expired');
    },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, '');
});

test('a non-2xx response-url replacement is logged but still acknowledged', async () => {
  const { handleSkipInteraction } = loadSlackHelpers();
  const result = await handleSkipInteraction({
    eventTitle: 'Synthetic event',
    responseUrl: 'https://hooks.slack.test/response',
    sendResponse: async () => ({ statusCode: 500 }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, '');
});
