#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseStage,
  isFullEnrichMessage,
  normaliseImageProvider,
  nextUtcDay,
  classifyCloudflareError,
  buildCallbackResultFromState,
  buildImageGenerationPrompt,
} from '../full-enrich-helpers.mjs';

test('normaliseStage maps external imageUrl to logical image', () => {
  assert.equal(normaliseStage('tagline'), 'tagline');
  assert.equal(normaliseStage('imageTheme'), 'imageTheme');
  assert.equal(normaliseStage('imageUrl'), 'image');
  assert.equal(normaliseStage('image'), 'image');
  assert.equal(normaliseStage('other'), null);
});

test('isFullEnrichMessage requires callback token and fullEnrich contract', () => {
  assert.equal(isFullEnrichMessage({ orchestrationType: 'fullEnrich', orchestrationStep: 'image', taskToken: 'token' }), true);
  assert.equal(isFullEnrichMessage({ orchestrationType: 'imageEnrich', orchestrationStep: 'image', taskToken: 'token' }), false);
  assert.equal(isFullEnrichMessage({ orchestrationType: 'fullEnrich', orchestrationStep: 'image' }), false);
});

test('image provider normalization has no automatic fallback', () => {
  assert.equal(normaliseImageProvider('cloudflare'), 'cloudflare');
  assert.equal(normaliseImageProvider('GEMINI'), 'gemini');
  assert.equal(normaliseImageProvider('invalid'), null);
});

test('nextUtcDay returns the next UTC midnight', () => {
  assert.equal(nextUtcDay(new Date('2026-09-07T23:59:00Z')), '2026-09-08T00:00:00.000Z');
});

test('Cloudflare free allocation exhaustion is a provider quota, not a per-event failure', () => {
  assert.equal(classifyCloudflareError({ providerCode: 3036, message: 'daily allocation exhausted' }), 'PROVIDER_QUOTA');
  assert.equal(classifyCloudflareError({ providerCode: 3040, message: 'capacity' }), 'RATE_LIMIT');
  assert.equal(classifyCloudflareError({ providerCode: 5035, message: 'paid plan required' }), 'MODEL_CONFIGURATION');
  assert.equal(classifyCloudflareError({ status: 503, message: 'unavailable' }), 'PROVIDER_5XX');
});

test('callback result exposes retry and manual-review state explicitly', () => {
  const retry = buildCallbackResultFromState({
    state: { state: 'retry_wait', attemptCount: 2, nextRetryAt: '2026-09-08T10:00:00Z', lastErrorType: 'RATE_LIMIT' },
    stage: 'image',
    hex: 'abcd',
    provider: 'cloudflare',
    generationId: 'gen',
  });
  assert.equal(retry.status, 'retry_wait');
  assert.equal(retry.attemptCount, 2);
  assert.equal(retry.failureCategory, 'RATE_LIMIT');

  const manual = buildCallbackResultFromState({
    state: { state: 'manual_review', attemptCount: 3, lastErrorType: 'AUTH_FAILURE' },
    stage: 'image',
    hex: 'abcd',
    provider: 'cloudflare',
  });
  assert.equal(manual.status, 'manual_review');
  assert.equal(manual.failureCategory, 'AUTH_FAILURE');
});

test('in-progress duplicate keeps callback ownership with the reserved delivery', () => {
  const result = buildCallbackResultFromState({
    state: { state: 'in_progress', attemptCount: 1, generationId: 'gen' },
    stage: 'image',
    hex: 'abcd',
    provider: 'cloudflare',
  });
  assert.equal(result.status, 'duplicate_in_progress');
  assert.equal(result.reason, 'stage_reservation_owned_elsewhere');
});

test('persistence pending returns deferred so Step Functions does not regenerate', () => {
  const result = buildCallbackResultFromState({
    state: { state: 'persist_pending', attemptCount: 1, generationId: 'gen' },
    stage: 'image',
    hex: 'abcd',
    provider: 'gemini',
  });
  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, 'persistence_pending');
});

test('image prompt uses the same scouts.conf placeholders', () => {
  assert.equal(buildImageGenerationPrompt('campfire', {
    imageGenerationPromptTemplate: 'Draw {{IMAGE_THEME}}. {{IMAGE_PROMPT_SPECIFICATIONS}}',
    imageGenerationPromptSpecifications: ['16:9', 'no text'],
  }), 'Draw campfire. 16:9, no text');
});
