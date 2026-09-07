import test from 'node:test';
import assert from 'node:assert/strict';
import {
  determineStartStage,
  normaliseImageProvider,
  isFullEnrichStartRequest,
  isFullEnrichStageRequest,
  translateFullEnrichStageRequest,
  buildFullEnrichExecutionInput,
} from '../full-enrich-adapter.mjs';

test('determineStartStage skips already-complete enrichment stages', () => {
  assert.equal(determineStartStage({ metadata: {} }), 'tagline');
  assert.equal(determineStartStage({ metadata: { tagline: 'Join us' } }), 'imageTheme');
  assert.equal(determineStartStage({ metadata: { tagline: 'Join us', image: { theme: 'campfire' } } }), 'image');
  assert.equal(determineStartStage({ metadata: { tagline: 'Join us', image: { theme: 'campfire', url: 'website/eventImages/a.jpg' } } }), 'complete');
});

test('normaliseImageProvider is fail-closed', () => {
  assert.equal(normaliseImageProvider('cloudflare'), 'cloudflare');
  assert.equal(normaliseImageProvider('GEMINI'), 'gemini');
  assert.equal(normaliseImageProvider('unknown-provider'), 'disabled');
  assert.equal(normaliseImageProvider(null), 'disabled');
});

test('legacy start actions are aliases for the full orchestration cutover', () => {
  for (const action of ['new', 'retry', 'imageEnrich', 'fullEnrich']) {
    assert.equal(isFullEnrichStartRequest({ realm: 'scoutsRequest', action }), true, action);
  }
  assert.equal(isFullEnrichStartRequest({ realm: 'scoutsRequest', action: 'request' }), false);
});

test('full-enrich callback stage requests are recognized separately from starts', () => {
  const message = {
    realm: 'scoutsRequest',
    action: 'request',
    orchestrationType: 'fullEnrich',
    subject: 'imageUrl',
    subjectLabel: 'imageUrl',
    requestHex: 'abcd',
    taskToken: 'token',
    imageProvider: 'cloudflare',
  };
  assert.equal(isFullEnrichStageRequest(message), true);
  assert.equal(isFullEnrichStartRequest(message), false);
});

test('translateFullEnrichStageRequest preserves callback and image provider metadata', () => {
  const result = translateFullEnrichStageRequest({
    realm: 'scoutsRequest',
    action: 'request',
    subject: 'imageUrl',
    subjectLabel: 'imageUrl',
    requestHex: 'ABCD',
    requestId: 'req-1',
    taskToken: 'task-token',
    orchestrationType: 'fullEnrich',
    orchestrationStep: 'image',
    imageProvider: 'cloudflare',
  });
  assert.deepEqual(result, {
    realm: 'image',
    action: 'request',
    subject: 'abcd',
    subjectLabel: 'imageUrl',
    hex: 'abcd',
    requestHex: 'ABCD',
    requestId: 'req-1',
    taskToken: 'task-token',
    orchestrationType: 'fullEnrich',
    orchestrationStep: 'image',
    source: 'scouts-full-enrich',
    requestMode: 'auto',
    approvalMode: 'auto',
    imageProvider: 'cloudflare',
  });
});

test('buildFullEnrichExecutionInput captures provider and resumes from next missing stage', () => {
  const input = buildFullEnrichExecutionInput(
    {
      realm: 'scoutsRequest',
      action: 'new',
      subject: { metadata: { hex: 'abcd' } },
      imageProvider: 'gemini',
      source: 'test',
    },
    { metadata: { hex: 'abcd', tagline: 'Tag', image: { theme: 'theme', url: null } } },
    'execution-name',
  );
  assert.equal(input.requestId, 'execution-name');
  assert.equal(input.orchestrationType, 'fullEnrich');
  assert.equal(input.startStage, 'image');
  assert.equal(input.imageProvider, 'gemini');
  assert.equal(input.hex, 'abcd');
  assert.match(input.generationKey, /^[a-f0-9]{12}$/);
});
