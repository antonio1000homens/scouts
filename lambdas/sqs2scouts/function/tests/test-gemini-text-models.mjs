import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GEMINI_TEXT_MODELS,
  assertGeminiStructuredTextResult,
  generateGeminiTextWithFallback,
  isRetryableGeminiTextError,
  parseGeminiTextModels,
  GEMINI_TEXT_RESPONSE_SCHEMAS,
  validateGeminiTextResponse,
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
  assert.equal(isRetryableGeminiTextError({ name: 'MALFORMED_MODEL_RESPONSE' }), true);
});

test('structured response schemas and semantic validation reject malformed event data', () => {
  assert.deepEqual(GEMINI_TEXT_RESPONSE_SCHEMAS.tagline.required, ['tagline', 'imageTag']);
  assert.deepEqual(GEMINI_TEXT_RESPONSE_SCHEMAS.imageTheme.required, ['imageTag']);
  assert.equal(validateGeminiTextResponse({ tagline: 'Adventure awaits!', imageTag: 'forest ropes course' }, 'tagline').valid, true);
  assert.equal(validateGeminiTextResponse({ tagline: '', imageTag: 'forest ropes course' }, 'tagline').reason, 'missing_tagline');
  assert.equal(validateGeminiTextResponse({ tagline: 'x'.repeat(81), imageTag: 'forest ropes course' }, 'tagline').reason, 'tagline_too_long');
  assert.equal(validateGeminiTextResponse({ imageTag: 'Laser Tag!' }, 'imageTheme').reason, 'invalid_image_tag');
});

test('429 quota response remains retryable even when provider reports quota exhaustion', () => {
  assert.equal(isRetryableGeminiTextError({ status: 429, message: 'quota exceeded' }), true);
});

test('truncated JSON is treated as a retryable malformed model response', () => {
  const result = {
    response: {
      text: () => '{"imageTag":"street festival',
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { candidatesTokenCount: 6 },
    },
  };
  assert.throws(
    () => assertGeminiStructuredTextResult(result, { model: 'primary' }),
    (error) => error?.name === 'MALFORMED_MODEL_RESPONSE' && error?.retryable === true,
  );
});

test('MAX_TOKENS completion is retryable even before JSON parsing', () => {
  const result = {
    response: {
      text: () => '{"imageTag":"street festival',
      candidates: [{ finishReason: 'MAX_TOKENS' }],
      usageMetadata: { candidatesTokenCount: 2048 },
    },
  };
  assert.throws(
    () => assertGeminiStructuredTextResult(result, { model: 'primary' }),
    (error) => error?.name === 'MALFORMED_MODEL_RESPONSE' && error?.finishReason === 'MAX_TOKENS',
  );
});

test('malformed structured output retries the same model once before succeeding', async () => {
  const attempts = [];
  const result = await generateGeminiTextWithFallback({
    models: ['primary', 'fallback'],
    generate: async (model) => {
      attempts.push(model);
      const text = attempts.length === 1
        ? '{"imageTag":"street festival'
        : '{"imageTag":"street festival parade"}';
      return {
        response: {
          text: () => text,
          candidates: [{ finishReason: 'STOP' }],
        },
      };
    },
  });

  assert.deepEqual(attempts, ['primary', 'primary']);
  assert.equal(result.model, 'primary');
});

test('repeated malformed output falls back to the next configured model', async () => {
  const attempts = [];
  const result = await generateGeminiTextWithFallback({
    models: ['primary', 'fallback'],
    generate: async (model) => {
      attempts.push(model);
      if (model === 'primary') {
        return {
          response: {
            text: () => '{"imageTag":"street festival',
            candidates: [{ finishReason: 'STOP' }],
          },
        };
      }
      return {
        response: {
          text: () => '{"imageTag":"street festival parade"}',
          candidates: [{ finishReason: 'STOP' }],
        },
      };
    },
  });

  assert.deepEqual(attempts, ['primary', 'primary', 'fallback']);
  assert.equal(result.model, 'fallback');
});
