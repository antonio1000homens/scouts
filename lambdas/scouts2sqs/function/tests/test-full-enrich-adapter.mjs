import test from 'node:test';
import assert from 'node:assert/strict';
import {
  determineStartStage,
  normaliseImageProvider,
  isFullEnrichStartRequest,
  isFullEnrichStageRequest,
  isDirectImageEnrichRequest,
  isCompactPersistRequest,
  translateCompactPersistRequest,
  applyCanonicalPersistPatch,
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

test('direct admin image request is routed into full-enrich', () => {
  const request = {
    realm: 'scoutsRequest',
    action: 'request',
    subject: 'imageUrl',
    subjectLabel: 'imageUrl',
    hex: 'abcd',
  };
  assert.equal(isDirectImageEnrichRequest(request), true);
  assert.equal(isFullEnrichStageRequest(request), false);

  const input = buildFullEnrichExecutionInput(
    request,
    { metadata: { hex: 'abcd', tagline: 'Tag', image: { theme: 'theme', url: 'old.jpg' } } },
    'execution-name',
  );
  assert.equal(input.startStage, 'image');
  assert.equal(input.requestId, 'execution-name');
  assert.equal(input.orchestrationType, 'fullEnrich');
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
  assert.equal(isDirectImageEnrichRequest(message), false);
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

test('compact hide persist is canonicalized without losing HEX', () => {
  const request = {
    realm: 'persist',
    action: 'persist',
    subject: { hex: 'ABCD', isHidden: true },
    requestId: 'req-hide',
  };
  assert.equal(isCompactPersistRequest(request), true);
  assert.deepEqual(translateCompactPersistRequest(request), {
    realm: 'persist',
    action: 'persist',
    subject: {
      metadata: {
        hex: 'abcd',
        status: { isHidden: true },
      },
    },
    hex: 'abcd',
    requestHex: 'abcd',
    requestId: 'req-hide',
    source: 'scouts2sqs',
  });
});

test('sparse hide patch preserves existing enrichment when merged before persistence', () => {
  const existing = {
    metadata: {
      hex: 'abcd',
      tagline: 'Keep this tagline',
      image: {
        theme: 'Keep this theme',
        url: 'website/eventImages/existing.jpg',
      },
      status: {
        isApproved: true,
        isHidden: false,
      },
    },
    requests: [{ requestId: 'older-request', status: 'completed' }],
  };
  const patch = translateCompactPersistRequest({
    realm: 'persist',
    action: 'persist',
    subject: { hex: 'abcd', isHidden: true },
  }).subject;

  const merged = applyCanonicalPersistPatch(existing, patch);
  assert.equal(merged.metadata.status.isHidden, true);
  assert.equal(merged.metadata.status.isApproved, true);
  assert.equal(merged.metadata.tagline, 'Keep this tagline');
  assert.equal(merged.metadata.image.theme, 'Keep this theme');
  assert.equal(merged.metadata.image.url, 'website/eventImages/existing.jpg');
  assert.deepEqual(merged.requests, existing.requests);
  assert.equal(existing.metadata.status.isHidden, false, 'merge must not mutate the loaded event object');
});

test('compact generated-field persist is canonicalized', () => {
  const result = translateCompactPersistRequest({
    realm: 'persist',
    action: 'persist',
    subject: {
      hex: 'ABCD',
      tagline: 'Join us',
      imageTheme: 'campfire',
      imageUrl: 'website/eventImages/a.png',
      isApproved: true,
    },
  });
  assert.deepEqual(result.subject.metadata, {
    hex: 'abcd',
    tagline: 'Join us',
    image: {
      theme: 'campfire',
      url: 'website/eventImages/a.png',
    },
    status: { isApproved: true },
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
