import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../lambdas/sqs2scouts/function/tests/test-cloudflare-image-client.mjs';
import { createFakeScoutsProvider, isValidPng } from './helpers/fake-scouts-provider.mjs';
import {
  applySyntheticAdminAction,
  enrichSyntheticEvent,
  isSyntheticPubliclyVisible,
  translateAdminGenerationRequest,
  translateQueueStage,
} from './helpers/scouts-workflow-harness.mjs';

const scoutsSource = readFileSync('lambdas/scouts/function/scouts-service.mjs', 'utf8');
const scouts2sqsSource = readFileSync('lambdas/scouts2sqs/function/request-processor.mjs', 'utf8');
const requestRouterSource = readFileSync('lambdas/scouts2sqs/function/request-router.mjs', 'utf8');
const imageAdapterSource = readFileSync('lambdas/sqs2scouts/function/image-provider-adapter.mjs', 'utf8');
const imageWorkerSource = readFileSync('lambdas/sqs2scouts/function/image-provider-worker.mjs', 'utf8');

const TEST_HEX = '746573742d776f726b666c6f77';

function syntheticEvent() {
  return {
    title: 'Synthetic Workflow Event',
    description: 'No production data',
    metadata: {
      hex: TEST_HEX,
      status: { isApproved: false, isHidden: false },
      image: {},
    },
  };
}

test('production sources retain the contracts exercised by the synthetic journey', () => {
  for (const token of ['generatetagline', 'generateimagetheme', 'generateimage', 'generatefull']) {
    assert.match(scoutsSource, new RegExp(`token === '${token}'`), `missing scouts admin translation for ${token}`);
  }
  assert.match(scoutsSource, /isHidden\s*===\s*true/);
  assert.match(scoutsSource, /isApproved\s*===\s*true/);
  assert.match(scoutsSource, /commandActionToken === 'unhide'/);
  assert.match(scouts2sqsSource, /requestedField === 'tagline'/);
  assert.match(scouts2sqsSource, /requestedField === 'imageTheme'/);
  assert.match(scouts2sqsSource, /requestedField === 'imageUrl'/);
  assert.match(requestRouterSource, /new Set\(\['new', 'retry', 'imageEnrich', 'fullEnrich'\]\)/);
  assert.match(imageAdapterSource, /imageProviderWorkerHandler/);
  assert.match(imageWorkerSource, /loadReusableGeneration/);
});

test('synthetic event crosses admin, queue, provider, persistence, approval and visibility boundaries', async () => {
  const provider = createFakeScoutsProvider();
  const original = syntheticEvent();

  const adminPayload = {
    realm: 'scouts',
    subject: { hex: TEST_HEX },
    action: 'generateFull',
  };
  const queued = translateAdminGenerationRequest(adminPayload);
  assert.deepEqual(queued, {
    realm: 'scoutsRequest',
    action: 'fullEnrich',
    subject: 'all',
    hex: TEST_HEX,
  });

  const firstStage = translateQueueStage(queued, original);
  assert.deepEqual(firstStage, {
    realm: 'tagline',
    action: 'request',
    subject: TEST_HEX,
    stage: 'tagline',
  });

  const enriched = await enrichSyntheticEvent(original, provider);
  assert.equal(enriched.event.metadata.tagline, 'Automated test tagline');
  assert.equal(enriched.event.metadata.image.theme, 'friendly scouts outdoors illustration');
  assert.match(enriched.event.metadata.image.url, new RegExp(`^website/eventImages/test/${TEST_HEX}-`));
  assert.equal(isValidPng(enriched.event.__testImage.buffer), true);
  assert.deepEqual(provider.calls, { tagline: 1, imageTheme: 1, image: 1 });
  assert.deepEqual(
    enriched.trace.filter((entry) => entry.boundary === 'persistence').map((entry) => entry.stage),
    ['tagline', 'imageTheme', 'image'],
  );
  assert.equal(enriched.state.persisted.has(TEST_HEX), true);

  let actionEvent = applySyntheticAdminAction(enriched.event, {
    realm: 'scouts',
    action: 'approve',
    subject: { hex: TEST_HEX, isApproved: true },
  });
  assert.equal(isSyntheticPubliclyVisible(actionEvent), true, 'approved event should become public');

  actionEvent = applySyntheticAdminAction(actionEvent, {
    realm: 'scouts',
    action: 'hide',
    subject: { hex: TEST_HEX, isHidden: true },
  });
  assert.equal(isSyntheticPubliclyVisible(actionEvent), false, 'hidden event must not be public');

  actionEvent = applySyntheticAdminAction(actionEvent, {
    realm: 'scouts',
    action: 'unhide',
    subject: { hex: TEST_HEX, isHidden: false },
  });
  assert.equal(isSyntheticPubliclyVisible(actionEvent), true, 'unhide should restore approved event visibility');
});

test('image persistence retry reuses cached fake provider output instead of regenerating', async () => {
  const provider = createFakeScoutsProvider();
  const first = await enrichSyntheticEvent(syntheticEvent(), provider);
  assert.equal(provider.calls.image, 1);

  const persistenceRetry = structuredClone(first.event);
  delete persistenceRetry.__testImage;
  persistenceRetry.metadata.image.url = null;

  const retried = await enrichSyntheticEvent(persistenceRetry, provider, first.state);
  assert.equal(provider.calls.image, 1, 'cached image must prevent a second provider call');
  assert.equal(
    retried.trace.some((entry) => entry.boundary === 'provider' && entry.stage === 'image' && entry.status === 'reused'),
    true,
  );
});

test('tampered actions and cross-event HEX changes fail at the action boundary', () => {
  const event = {
    ...syntheticEvent(),
    metadata: {
      ...syntheticEvent().metadata,
      status: { isApproved: true, isHidden: false },
    },
  };

  assert.throws(() => applySyntheticAdminAction(event, {
    realm: 'scouts',
    action: 'hide',
    subject: { hex: 'deadbeef', isHidden: true },
  }), /HEX mismatch/);

  assert.throws(() => applySyntheticAdminAction(event, {
    realm: 'scouts',
    action: 'deleteEverything',
    subject: { hex: TEST_HEX },
  }), /unsupported action/);
});

test('fake provider is test-only and production provider allowlists cannot select it', () => {
  const cloudflareClient = readFileSync('lambdas/sqs2scouts/function/cloudflare-image-client.mjs', 'utf8');
  const requestRouter = readFileSync('lambdas/scouts2sqs/function/request-router.mjs', 'utf8');
  assert.doesNotMatch(cloudflareClient, /['"]fake['"]/);
  assert.doesNotMatch(requestRouter, /['"]fake['"]/);
  assert.match(requestRouter, /\['cloudflare', 'gemini', 'disabled'\]/);
});
