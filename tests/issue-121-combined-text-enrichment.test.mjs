import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateGeminiTextResponse } from '../lambdas/sqs2scouts/function/gemini-text-models.mjs';
import { createFakeScoutsProvider } from './helpers/fake-scouts-provider.mjs';
import {
  determineSyntheticStage,
  enrichSyntheticEvent,
  translateAdminGenerationRequest,
} from './helpers/scouts-workflow-harness.mjs';

const TEST_HEX = '6973737565313231';

function eventWith({ tagline = null, imageTheme = null, imageUrl = null } = {}) {
  return {
    title: 'Issue 121 synthetic event',
    metadata: {
      hex: TEST_HEX,
      tagline,
      image: {
        theme: imageTheme,
        url: imageUrl,
      },
      status: {
        isApproved: false,
        isHidden: false,
      },
    },
    requests: [],
  };
}

test('new event uses exactly one combined text provider call and persists both fields together', async () => {
  const provider = createFakeScoutsProvider();
  const enriched = await enrichSyntheticEvent(eventWith(), provider);

  assert.deepEqual(provider.calls, {
    taglineTheme: 1,
    tagline: 0,
    imageTheme: 0,
    image: 1,
  });
  assert.equal(enriched.event.metadata.tagline, 'Automated test tagline');
  assert.equal(enriched.event.metadata.image.theme, 'friendly scouts outdoors illustration');
  assert.deepEqual(
    enriched.snapshots.map(({ stage }) => stage),
    ['taglineTheme', 'image'],
  );
  const combinedSnapshot = enriched.snapshots[0].event;
  assert.equal(combinedSnapshot.metadata.tagline, 'Automated test tagline');
  assert.equal(combinedSnapshot.metadata.image.theme, 'friendly scouts outdoors illustration');
});

test('tagline-only automatic work preserves an existing image theme', async () => {
  const provider = createFakeScoutsProvider();
  const event = eventWith({
    imageTheme: 'existing theme',
    imageUrl: 'website/eventImages/existing.png',
  });

  assert.equal(determineSyntheticStage(event), 'tagline');
  const enriched = await enrichSyntheticEvent(event, provider);

  assert.equal(enriched.event.metadata.tagline, 'Automated test tagline');
  assert.equal(enriched.event.metadata.image.theme, 'existing theme');
  assert.deepEqual(provider.calls, {
    taglineTheme: 0,
    tagline: 1,
    imageTheme: 0,
    image: 0,
  });
});

test('image-theme-only automatic work preserves an existing tagline', async () => {
  const provider = createFakeScoutsProvider();
  const event = eventWith({
    tagline: 'Existing tagline',
    imageUrl: 'website/eventImages/existing.png',
  });

  assert.equal(determineSyntheticStage(event), 'imageTheme');
  const enriched = await enrichSyntheticEvent(event, provider);

  assert.equal(enriched.event.metadata.tagline, 'Existing tagline');
  assert.equal(enriched.event.metadata.image.theme, 'friendly scouts outdoors illustration');
  assert.deepEqual(provider.calls, {
    taglineTheme: 0,
    tagline: 0,
    imageTheme: 1,
    image: 0,
  });
});

test('complete text skips Gemini text work before image generation', async () => {
  const provider = createFakeScoutsProvider();
  const enriched = await enrichSyntheticEvent(eventWith({
    tagline: 'Existing tagline',
    imageTheme: 'existing theme',
  }), provider);

  assert.deepEqual(provider.calls, {
    taglineTheme: 0,
    tagline: 0,
    imageTheme: 0,
    image: 1,
  });
  assert.deepEqual(enriched.snapshots.map(({ stage }) => stage), ['image']);
});

test('invalid combined response commits neither text field', async () => {
  const provider = createFakeScoutsProvider();
  provider.generateTaglineTheme = async () => {
    provider.calls.taglineTheme += 1;
    return { tagline: 'Only half a response', imageTheme: '' };
  };
  const state = { persisted: new Map(), imageCache: new Map() };

  await assert.rejects(
    enrichSyntheticEvent(eventWith(), provider, state),
    /incomplete text enrichment/,
  );
  assert.equal(state.persisted.size, 0);
  assert.equal(provider.calls.taglineTheme, 1);
  assert.equal(provider.calls.tagline, 0);
  assert.equal(provider.calls.imageTheme, 0);
});

test('structured response validation distinguishes combined and individual modes', () => {
  assert.equal(validateGeminiTextResponse({
    tagline: 'A valid short tagline',
    imageTag: 'forest camp',
  }, 'taglineTheme').valid, true);

  assert.equal(validateGeminiTextResponse({
    imageTag: 'forest camp',
  }, 'taglineTheme').valid, false, 'combined mode requires tagline');

  assert.equal(validateGeminiTextResponse({
    tagline: 'A valid short tagline',
  }, 'taglineTheme').valid, false, 'combined mode requires image tag');

  assert.equal(validateGeminiTextResponse({
    tagline: 'A valid short tagline',
  }, 'tagline').valid, true, 'tagline-only mode must not require image tag');

  assert.equal(validateGeminiTextResponse({
    imageTag: 'forest camp',
  }, 'imageTheme').valid, true, 'theme-only mode must not require tagline');
});

test('replaying an already complete event does not invoke providers again', async () => {
  const provider = createFakeScoutsProvider();
  const first = await enrichSyntheticEvent(eventWith(), provider);
  const callsAfterFirst = structuredClone(provider.calls);

  const replay = await enrichSyntheticEvent(first.event, provider, first.state);

  assert.deepEqual(provider.calls, callsAfterFirst);
  assert.deepEqual(replay.snapshots, []);
});

test('Details generation actions retain independent external contracts', () => {
  assert.deepEqual(translateAdminGenerationRequest({
    realm: 'scouts',
    subject: { hex: TEST_HEX },
    action: 'generateTagline',
  }), {
    realm: 'scoutsRequest',
    action: 'request',
    subject: 'tagline',
    hex: TEST_HEX,
  });

  assert.deepEqual(translateAdminGenerationRequest({
    realm: 'scouts',
    subject: { hex: TEST_HEX },
    action: 'generateImageTheme',
  }), {
    realm: 'scoutsRequest',
    action: 'request',
    subject: 'imageTheme',
    hex: TEST_HEX,
  });
});

test('production orchestration routes direct text buttons through the state machine and stops after that field', () => {
  const router = readFileSync('lambdas/scouts2sqs/function/request-router.mjs', 'utf8');
  const stateMachine = readFileSync('lambdas/cloudformation/templates/scouts-full-enrich.yaml', 'utf8');

  assert.match(router, /function isDirectFieldEnrichRequest/);
  assert.match(router, /\['tagline', 'imageTheme', 'image'\]\.includes\(requestedStartStage\(message\)\)/);
  assert.match(router, /continueAfterStage: !directFieldRequest/);
  assert.match(router, /directFieldRequest \? 'manual' : 'auto'/);

  assert.match(stateMachine, /"GenerateTaglineAndTheme"/);
  assert.match(stateMachine, /"subject": "taglineTheme"/);
  assert.match(stateMachine, /"\\$\\.taglineThemeResult\\.status"[\\s\\S]*"Next": "SelectImageProvider"/);
  assert.match(stateMachine, /"\\$\\.taglineResult\\.status"[\\s\\S]*"BooleanEquals": false[\\s\\S]*"Next": "Complete"/);
  assert.match(stateMachine, /"\\$\\.imageThemeResult\\.status"[\\s\\S]*"BooleanEquals": false[\\s\\S]*"Next": "Complete"/);
  assert.doesNotMatch(
    stateMachine,
    /"\\$\\.taglineResult\\.status"\\s*,?\\s*\\n\\s*"StringEquals": "succeeded"[\\s\\S]{0,120}"Next": "GenerateImageTheme"/,
  );
});

test('field saves are canonicalized before persistence and legacy aliases remain compatible', () => {
  const requestProcessor = readFileSync('lambdas/scouts2sqs/function/request-processor.mjs', 'utf8');
  const worker = readFileSync('lambdas/sqs2scouts/function/persistence-processor.mjs', 'utf8');

  assert.match(requestProcessor, /subject:\s*\{\s*metadata:\s*\{\s*hex,/);
  assert.match(requestProcessor, /requestedField === 'tagline' \? \{ tagline: fieldValue \}/);
  assert.match(requestProcessor, /requestedField === 'imageTheme' \? \{ theme: fieldValue \}/);
  assert.match(requestProcessor, /requestedField === 'imageUrl' \? \{ url: fieldValue \}/);
  assert.match(worker, /function applyLegacyPersistFieldAliases/);
  assert.match(worker, /target\.metadata\.tagline = patch\.tagline/);
  assert.match(worker, /target\.metadata\.image\.theme = patch\.imageTheme/);
  assert.match(worker, /target\.metadata\.image\.url = patch\.imageUrl/);
});

test('production worker enforces atomic read-back, manual regeneration, state satisfaction and observability', () => {
  const worker = readFileSync('lambdas/sqs2scouts/function/persistence-processor.mjs', 'utf8');

  assert.match(worker, /realm === 'taglineTheme' \|\| realm === 'tagline'/);
  assert.match(worker, /requestedTextMode: mode === 'taglineTheme' \? 'combined' : mode/);
  assert.match(worker, /providerCallCount,/);
  assert.match(worker, /inputTokens:/);
  assert.match(worker, /outputTokens:/);
  assert.match(worker, /totalTokens:/);
  assert.match(worker, /both_fields_already_present/);
  assert.match(worker, /manualRegeneration/);
  assert.match(worker, /manual:\$\{requestContext\.requestId\}/);
  assert.match(worker, /Tagline-only enrichment modified the existing image theme/);
  assert.match(worker, /Image-theme-only enrichment modified the existing tagline/);
  assert.match(worker, /markEnrichmentSucceeded\(\{ hex: hexValue, stage: 'tagline'/);
  assert.match(worker, /markEnrichmentSucceeded\(\{ hex: hexValue, stage: 'imageTheme'/);
});
