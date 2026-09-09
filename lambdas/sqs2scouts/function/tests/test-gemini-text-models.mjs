import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GEMINI_TEXT_MODELS,
  generateGeminiTextWithFallback,
  isRetryableGeminiTextError,
  parseGeminiTextModels,
} from '../gemini-text-models.mjs';

test('text fallback defaults to current free-tier compatible Gemini models', () => {
  assert.deepEqual(DEFAULT_GEMINI_TEXT_MODELS, [
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ]);
  assert.deepEqual(parseGeminiTextModels('gemini-3.5-flash, gemini-3.5-flash, gemini-2.5-flash'), [
    'gemini-3.5-flash',
    'gemini-2.5-flash',
  ]);
});

test('429 retries the next configured model and returns its result', async () => {
  const attempted = [];
  const result = await generateGeminiTextWithFallback({
    models: ['primary', 'fallback'],
    generate: async (model) => {
      attempted.push(model);
      if (model === 'primary') throw Object.assign(new Error('Too Many Requests'), { status: 429 });
      return 'generated tagline';
    },
  });
  assert.deepEqual(attempted, ['primary', 'fallback']);
  assert.equal(result.model, 'fallback');
  assert.equal(result.result, 'generated tagline');
});

test('non-retryable Gemini errors do not fan out to other models', async () => {
  const attempted = [];
  await assert.rejects(() => generateGeminiTextWithFallback({
    models: ['primary', 'fallback'],
    generate: async (model) => {
      attempted.push(model);
      throw Object.assign(new Error('Invalid request'), { status: 400 });
    },
  }), /Invalid request/);
  assert.deepEqual(attempted, ['primary']);
});

test('retryability recognises provider quota and transient availability errors', () => {
  assert.equal(isRetryableGeminiTextError({ status: 429 }), true);
  assert.equal(isRetryableGeminiTextError({ message: 'RESOURCE_EXHAUSTED' }), true);
  assert.equal(isRetryableGeminiTextError({ status: 503 }), true);
  assert.equal(isRetryableGeminiTextError({ status: 403, message: 'Forbidden' }), false);
});
