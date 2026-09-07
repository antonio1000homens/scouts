#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test-cloudflare-image-client.mjs';
import '../../../../tests/issue-18-cloudflare-image.integration.test.mjs';
import {
  normaliseStage,
  isFullEnrichMessage,
  normaliseImageProvider,
  nextUtcDay,
  classifyCloudflareError,
  buildCallbackResultFromState,
  buildImageGenerationPrompt,
} from '../full-enrich-helpers.mjs';

const fullEnrichAdapter = readFileSync('lambdas/scouts2sqs/function/full-enrich-adapter.mjs', 'utf8');
const scoutsTemplate = readFileSync('lambdas/cloudformation/templates/scouts.yaml', 'utf8');
const scoutsDeploy = readFileSync('lambdas/scouts/deploy.sh', 'utf8');
const runtimeActivity = readFileSync('lambdas/scouts/function/runtime-activity.mjs', 'utf8');

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

test('Cloudflare errors map to quota, retryable, and deterministic categories', () => {
  assert.equal(classifyCloudflareError({ providerCode: 3036, message: 'daily allocation exhausted' }), 'PROVIDER_QUOTA');
  assert.equal(classifyCloudflareError({ providerCode: 3040, status: 429, message: 'capacity' }), 'RATE_LIMIT');
  assert.equal(classifyCloudflareError({ providerCode: 5035, status: 403, message: 'paid plan required' }), 'MODEL_CONFIGURATION');
  assert.equal(classifyCloudflareError({ providerCode: 5007, status: 400, message: 'no such model' }), 'MODEL_CONFIGURATION');
  assert.equal(classifyCloudflareError({ providerCode: 3042, status: 404, message: 'invalid model' }), 'MODEL_CONFIGURATION');
  assert.equal(classifyCloudflareError({ providerCode: 3007, status: 408, message: 'request timeout' }), 'NETWORK_TIMEOUT');
  assert.equal(classifyCloudflareError({ providerCode: 3008, status: 408, message: 'aborted' }), 'NETWORK_TIMEOUT');
  assert.equal(classifyCloudflareError({ status: 400, message: 'invalid request' }), 'INVALID_EVENT_DATA');
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

test('full-enrich preserves the ingress request ID separately from execution name', () => {
  assert.match(fullEnrichAdapter, /requestId: text\(message\?\.requestId\) \|\| name \|\| executionName\(prefix\)/);
  assert.match(fullEnrichAdapter, /executionName: name \|\| null/);
  assert.match(fullEnrichAdapter, /const finalInput = \{ \.\.\.input, executionName: name \}/);
  assert.doesNotMatch(fullEnrichAdapter, /const finalInput = \{ \.\.\.input, requestId: name \}/);
});

test('Scouts status deployment includes both enrichment state machines and activity entrypoint', () => {
  assert.match(scoutsTemplate, /FullEnrichStateMachineArn/);
  assert.match(scoutsTemplate, /FULL_ENRICH_STATE_MACHINE_ARN/);
  assert.match(scoutsTemplate, /Default: scouts-entry\.handler/);
  assert.match(scoutsTemplate, /states:DescribeExecution/);
  assert.match(scoutsTemplate, /states:GetExecutionHistory/);
  assert.equal(scoutsTemplate.includes('execution:*:*'), false);
  assert.equal((scoutsTemplate.match(/execution:\$\{StateMachineName\}:\*/g) || []).length, 2);
  assert.match(scoutsTemplate, /Fn::Select:[\s\S]*- 6[\s\S]*ImageEnrichStateMachineArn/);
  assert.match(scoutsTemplate, /Fn::Select:[\s\S]*- 6[\s\S]*FullEnrichStateMachineArn/);
  assert.match(scoutsDeploy, /scouts-entry\.handler/);
  assert.match(scoutsDeploy, /scouts-entry\.mjs runtime-activity\.mjs/);
  assert.match(scoutsDeploy, /scouts-full-enrich/);
});

test('activity status uses execution history for live stage and bounded recent terminal outcomes', () => {
  assert.match(runtimeActivity, /GetExecutionHistoryCommand/);
  assert.match(runtimeActivity, /reverseOrder:\s*true/);
  assert.match(runtimeActivity, /stateEnteredName/);
  assert.match(runtimeActivity, /MAX_RECENT_FAILURES/);
  assert.match(runtimeActivity, /RECENT_FAILURE_WINDOW_MS/);
  assert.match(runtimeActivity, /terminalExecutionCache/);
  assert.match(runtimeActivity, /statusFilter:\s*'RUNNING'/);
});