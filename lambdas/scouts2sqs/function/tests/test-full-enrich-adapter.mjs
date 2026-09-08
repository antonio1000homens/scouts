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
  buildDownstreamPersistMessage,
  translateFullEnrichStageRequest,
  shouldReuseActiveExecution,
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

test('manual image requests never reuse an older execution lifecycle', () => {
  assert.equal(shouldReuseActiveExecution({
    realm: 'scoutsRequest',
    action: 'request',
    subject: 'imageUrl',
    subjectLabel: 'imageUrl',
    hex: 'abcd',
    requestId: 'req-new-image',
  }), false);

  assert.equal(shouldReuseActiveExecution({
    realm: 'scoutsRequest',
    action: 'new',
    subject: { metadata: { hex: 'abcd' } },
    requestId: 'req-auto',
  }), true);
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

test('downstream persist handoff remains sparse and lets worker merge latest durable state', () => {
  const payload = buildDownstreamPersistMessage({
    realm: 'persist',
    action: 'persist',
    subject: { hex: 'ABCD', isHidden: true },
    requestId: 'req-hide',
  });

  assert.equal(payload.realm, 'persist');
  assert.equal(payload.subject, 'abcd', 'string HEX bypasses legacy subject normalization');
  assert.equal(payload.hex, 'abcd');
  assert.equal(payload.operation, 'persist');
  assert.deepEqual(JSON.parse(payload.action), {
    metadata: {
      hex: 'abcd',
      status: { isHidden: true },
    },
  });
  assert.equal(payload.action.includes('tagline'), false);
  assert.equal(payload.action.includes('image'), false);
});

test('independent compact patches do not contain stale values from each other', () => {
  const hide = buildDownstreamPersistMessage({
    realm: 'persist',
    action: 'persist',
    subject: { hex: 'abcd', isHidden: true },
  });
  const approve = buildDownstreamPersistMessage({
    realm: 'persist',
    action: 'persist',
    subject: { hex: 'abcd', isApproved: true },
  });

  assert.deepEqual(JSON.parse(hide.action).metadata.status, { isHidden: true });
  assert.deepEqual(JSON.parse(approve.action).metadata.status, { isApproved: true });
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
