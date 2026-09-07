#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CLOUDFLARE_IMAGE_MODEL,
  normaliseImageProvider,
  normaliseCloudflareSteps,
  cloudflareImageEndpoint,
  decodeCloudflareImagePayload,
  generateCloudflareImageAsset,
  dispatchImageGeneration,
} from '../cloudflare-image-client.mjs';

test('provider selection is explicit and has no fallback', async () => {
  let cloudflareCalls = 0;
  let geminiCalls = 0;
  const handlers = {
    cloudflare: async () => { cloudflareCalls += 1; return 'cf'; },
    gemini: async () => { geminiCalls += 1; return 'gemini'; },
  };

  assert.equal(await dispatchImageGeneration('cloudflare', handlers), 'cf');
  assert.equal(cloudflareCalls, 1);
  assert.equal(geminiCalls, 0);

  assert.equal(await dispatchImageGeneration('gemini', handlers), 'gemini');
  assert.equal(cloudflareCalls, 1);
  assert.equal(geminiCalls, 1);

  assert.equal(await dispatchImageGeneration('disabled', handlers), null);
  assert.equal(cloudflareCalls, 1);
  assert.equal(geminiCalls, 1);

  await assert.rejects(() => dispatchImageGeneration('other', handlers), /Unsupported image generation provider/);
});

test('provider normalization and steps are bounded safely', () => {
  assert.equal(normaliseImageProvider('CLOUDFLARE'), 'cloudflare');
  assert.equal(normaliseImageProvider(''), 'disabled');
  assert.equal(normaliseCloudflareSteps(undefined), 4);
  assert.equal(normaliseCloudflareSteps(0), 1);
  assert.equal(normaliseCloudflareSteps(99), 8);
  assert.equal(normaliseCloudflareSteps(4.9), 4);
});

test('Cloudflare endpoint uses account and configured model', () => {
  assert.equal(
    cloudflareImageEndpoint('account-123', DEFAULT_CLOUDFLARE_IMAGE_MODEL),
    'https://api.cloudflare.com/client/v4/accounts/account-123/ai/run/@cf/black-forest-labs/flux-1-schnell',
  );
});

test('Cloudflare success forwards prompt/steps, sets authorization and decodes base64', async () => {
  const expected = Buffer.from('fake-jpeg-bytes');
  let capturedUrl = null;
  let capturedOptions = null;
  const fetchImpl = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ success: true, result: { image: expected.toString('base64') } });
      },
    };
  };

  const result = await generateCloudflareImageAsset({
    prompt: 'campfire scouts',
    accountId: 'account-123',
    apiToken: 'secret-token-value',
    steps: 4,
    fetchImpl,
  });

  assert.match(capturedUrl, /accounts\/account-123\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell$/);
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers.Authorization, 'Bearer secret-token-value');
  assert.deepEqual(JSON.parse(capturedOptions.body), { prompt: 'campfire scouts', steps: 4 });
  assert.deepEqual(result.buffer, expected);
  assert.equal(result.provider, 'cloudflare');
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.model, DEFAULT_CLOUDFLARE_IMAGE_MODEL);
});

test('Cloudflare client never logs the API token', async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const messages = [];
  console.log = (...args) => messages.push(args.join(' '));
  console.error = (...args) => messages.push(args.join(' '));
  console.warn = (...args) => messages.push(args.join(' '));
  try {
    await generateCloudflareImageAsset({
      prompt: 'test',
      accountId: 'acct',
      apiToken: 'never-log-this-token',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ result: { image: Buffer.from('x').toString('base64') } }); },
      }),
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.equal(messages.some((message) => message.includes('never-log-this-token')), false);
});

test('base64 response parsing fails closed on missing or malformed data', () => {
  assert.throws(() => decodeCloudflareImagePayload({ result: {} }), /no image data/);
  assert.throws(() => decodeCloudflareImagePayload({ result: { image: 'not-base64***' } }), /invalid base64/);
});

test('provider errors preserve Cloudflare status and internal code', async () => {
  await assert.rejects(
    () => generateCloudflareImageAsset({
      prompt: 'test',
      accountId: 'acct',
      apiToken: 'token',
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        async text() { return JSON.stringify({ success: false, errors: [{ code: 3036, message: 'daily allocation exhausted' }] }); },
      }),
    }),
    (error) => error.status === 429 && error.providerCode === 3036,
  );
});
