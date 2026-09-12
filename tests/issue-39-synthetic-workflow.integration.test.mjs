import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../lambdas/sqs2scouts/function/tests/test-cloudflare-image-client.mjs';
import {
  assertCanonicalAgendaEvent,
  assertCanonicalEventDocument,
  buildCanonicalEventDocument,
  canonicalEventShapeSummary,
} from '../lambdas/shared-layer/nodejs/canonical-event.mjs';
import {
  normalizeAgendaDocument,
  normalizeEventDocument,
} from '../lambdas/tools/cleanup-event-shape.mjs';
import { createFakeScoutsProvider, isValidPng } from './helpers/fake-scouts-provider.mjs';
import {
  applySyntheticAdminAction,
  enrichSyntheticEvent,
  isSyntheticPubliclyVisible,
  persistSyntheticEvent,
  removeSyntheticEvent,
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
  return buildCanonicalEventDocument({
    title: 'Synthetic Workflow Event',
    hex: TEST_HEX,
    tagline: null,
    imageTheme: null,
    imageUrl: null,
    isApproved: false,
    isHidden: false,
    requests: [],
  });
}

test('canonical persisted event schema is exact and rejects compatibility fields', () => {
  const event = syntheticEvent();
  assertCanonicalEventDocument(event, { expectedHex: TEST_HEX });
  assert.deepEqual(canonicalEventShapeSummary(event), {
    topLevel: ['metadata', 'requests', 'title'],
    metadata: ['hex', 'image', 'status', 'tagline'],
    image: ['theme', 'url'],
    status: ['isApproved', 'isHidden'],
  });

  for (const legacyMutation of [
    (copy) => { copy.hex = TEST_HEX; },
    (copy) => { copy.hexId = TEST_HEX; },
    (copy) => { copy.tagline = 'legacy'; },
    (copy) => { copy.AI = 'legacy'; },
    (copy) => { copy.image = { url: 'legacy.png' }; },
    (copy) => { copy.isHidden = true; },
    (copy) => { copy.approved = true; },
    (copy) => { copy.metadata.hexId = TEST_HEX; },
    (copy) => { copy.metadata.image.src = 'legacy.png'; },
  ]) {
    const dirty = structuredClone(event);
    legacyMutation(dirty);
    assert.throws(() => assertCanonicalEventDocument(dirty), /unsupported fields/);
  }
});

test('one-off migration converts a legacy HEX document exactly once', () => {
  const legacy = {
    title: 'Synthetic Workflow Event',
    hexId: TEST_HEX.toUpperCase(),
    AI: 'Migrated tagline',
    image: {
      theme: 'migrated theme',
      src: 'website/eventImages/test/migrated.png',
      isApproved: true,
    },
    hidden: 'false',
    requestIds: ['old-id'],
    metadata: {
      requestIds: ['old-id'],
    },
    requests: [{ requestId: 'req-1', timestamp: '2026-09-12T10:00:00.000Z' }],
  };

  const first = normalizeEventDocument(legacy, { expectedHex: TEST_HEX });
  assert.equal(first.changed, true);
  assertCanonicalEventDocument(first.value, { expectedHex: TEST_HEX, requireComplete: true });
  assert.deepEqual(first.value, {
    title: 'Synthetic Workflow Event',
    metadata: {
      hex: TEST_HEX,
      tagline: 'Migrated tagline',
      image: {
        theme: 'migrated theme',
        url: 'website/eventImages/test/migrated.png',
      },
      status: {
        isHidden: false,
        isApproved: true,
      },
    },
    requests: [{ requestId: 'req-1', timestamp: '2026-09-12T10:00:00.000Z' }],
  });

  const second = normalizeEventDocument(first.value, { expectedHex: TEST_HEX });
  assert.equal(second.changed, false, 'canonical migration must be idempotent');
  assert.deepEqual(second.value, first.value);
});

test('agenda migration removes enrichment compatibility fields but preserves calendar data', () => {
  const agenda = {
    generatedAt: '2026-09-12T10:00:00.000Z',
    events: [{
      uid: 'dummy-uid',
      title: 'Synthetic Workflow Event',
      description: 'calendar description',
      start: { raw: '20260912T180000' },
      hex: TEST_HEX,
      tagline: 'Legacy agenda tagline',
      image: { theme: 'agenda theme', url: 'website/eventImages/test/agenda.png' },
      approved: true,
      isHidden: false,
    }],
  };

  const migrated = normalizeAgendaDocument(agenda);
  assert.equal(migrated.changed, true);
  const [event] = migrated.value.events;
  assert.equal(event.uid, 'dummy-uid');
  assert.equal(event.description, 'calendar description');
  assert.deepEqual(event.start, { raw: '20260912T180000' });
  assert.equal('hex' in event, false);
  assert.equal('tagline' in event, false);
  assert.equal('image' in event, false);
  assert.equal('approved' in event, false);
  assert.equal('isHidden' in event, false);
  assertCanonicalAgendaEvent(event, { requireComplete: true });
});

test('production sources retain the contracts exercised by the synthetic journey', () => {
  for (const token of ['generatetagline', 'generateimagetheme', 'generateimage', 'generatefull']) {
    assert.match(scoutsSource, new RegExp(`token === '${token}'`), `missing scouts admin translation for ${token}`);
  }
  assert.match(scoutsSource, /metadata\.status/);
  assert.match(scoutsSource, /commandActionToken === 'unhide'/);
  assert.match(scouts2sqsSource, /requestedField === 'tagline'/);
  assert.match(scouts2sqsSource, /requestedField === 'imageTheme'/);
  assert.match(scouts2sqsSource, /requestedField === 'imageUrl'/);
  assert.match(requestRouterSource, /buildDownstreamPersistMessage/);
  assert.match(imageAdapterSource, /imageProviderWorkerHandler/);
  assert.match(imageWorkerSource, /loadReusableGeneration/);
});

test('dummy event starts clean, crosses every enrichment/action boundary, and is removed', async () => {
  const provider = createFakeScoutsProvider();
  const original = syntheticEvent();
  assertCanonicalEventDocument(original, { expectedHex: TEST_HEX });
  assert.equal(original.metadata.tagline, null);
  assert.equal(original.metadata.image.theme, null);
  assert.equal(original.metadata.image.url, null);

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
  assert.deepEqual(enriched.snapshots.map(({ stage }) => stage), ['tagline', 'imageTheme', 'image']);
  for (const { stage, event } of enriched.snapshots) {
    assertCanonicalEventDocument(event, { expectedHex: TEST_HEX });
    if (stage === 'tagline') {
      assert.equal(typeof event.metadata.tagline, 'string');
      assert.equal(event.metadata.image.theme, null);
      assert.equal(event.metadata.image.url, null);
    } else if (stage === 'imageTheme') {
      assert.equal(typeof event.metadata.tagline, 'string');
      assert.equal(typeof event.metadata.image.theme, 'string');
      assert.equal(event.metadata.image.url, null);
    } else if (stage === 'image') {
      assertCanonicalEventDocument(event, { expectedHex: TEST_HEX, requireComplete: true });
    }
  }

  assert.equal(enriched.event.metadata.tagline, 'Automated test tagline');
  assert.equal(enriched.event.metadata.image.theme, 'friendly scouts outdoors illustration');
  assert.match(enriched.event.metadata.image.url, new RegExp(`^website/eventImages/test/${TEST_HEX}-`));
  assert.equal(isValidPng(enriched.artifacts.image.buffer), true);
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
  let actionSnapshot = persistSyntheticEvent(enriched.state, actionEvent, 'approve');
  assertCanonicalEventDocument(actionSnapshot.event, { expectedHex: TEST_HEX, requireComplete: true });
  assert.equal(isSyntheticPubliclyVisible(actionEvent), true, 'approved event should become public');

  actionEvent = applySyntheticAdminAction(actionEvent, {
    realm: 'scouts',
    action: 'hide',
    subject: { hex: TEST_HEX, isHidden: true },
  });
  actionSnapshot = persistSyntheticEvent(enriched.state, actionEvent, 'hide');
  assert.equal(actionSnapshot.event.metadata.status.isHidden, true, 'hide must be durable');
  assert.equal(isSyntheticPubliclyVisible(actionEvent), false, 'hidden event must not be public');

  actionEvent = applySyntheticAdminAction(actionEvent, {
    realm: 'scouts',
    action: 'unhide',
    subject: { hex: TEST_HEX, isHidden: false },
  });
  actionSnapshot = persistSyntheticEvent(enriched.state, actionEvent, 'unhide');
  assert.equal(actionSnapshot.event.metadata.status.isHidden, false, 'unhide must be durable');
  assert.equal(isSyntheticPubliclyVisible(actionEvent), true, 'unhide should restore approved event visibility');

  assert.equal(removeSyntheticEvent(enriched.state, TEST_HEX), true, 'cleanup must remove dummy persisted event');
  assert.equal(enriched.state.persisted.has(TEST_HEX), false);
});

test('image persistence retry reuses cached fake provider output instead of regenerating', async () => {
  const provider = createFakeScoutsProvider();
  const first = await enrichSyntheticEvent(syntheticEvent(), provider);
  assert.equal(provider.calls.image, 1);

  const persistenceRetry = structuredClone(first.event);
  persistenceRetry.metadata.image.url = null;

  const retried = await enrichSyntheticEvent(persistenceRetry, provider, first.state);
  assert.equal(provider.calls.image, 1, 'cached image must prevent a second provider call');
  assert.equal(
    retried.trace.some((entry) => entry.boundary === 'provider' && entry.stage === 'image' && entry.status === 'reused'),
    true,
  );
  assertCanonicalEventDocument(retried.event, { expectedHex: TEST_HEX, requireComplete: true });
});

test('tampered actions and cross-event HEX changes fail at the action boundary', () => {
  const event = syntheticEvent();
  event.metadata.status.isApproved = true;

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
