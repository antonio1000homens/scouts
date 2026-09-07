import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENRICHMENT_STAGES,
  ENRICHMENT_STATES,
  buildGenerationId,
  normaliseEnrichmentStage,
  evaluateEnrichmentEligibility,
  classifyGeminiError,
  retryDelaySeconds,
} from './enrichment-state.mjs';

test('supported stages and states are explicit', () => {
  assert.deepEqual(ENRICHMENT_STAGES, ['tagline', 'imageTheme', 'image']);
  assert.deepEqual(ENRICHMENT_STATES, ['pending', 'in_progress', 'retry_wait', 'succeeded', 'persist_pending', 'manual_review']);
  assert.equal(normaliseEnrichmentStage('imageUrl'), 'image');
  assert.equal(normaliseEnrichmentStage('unsupported'), null);
});

test('generation IDs are stable, normalized and stage-specific', () => {
  const event = { title: 'Camp', start: { raw: '2026-09-01T10:00:00Z' } };
  assert.equal(buildGenerationId('ABC', 'tagline', event), buildGenerationId('abc', 'tagline', event));
  assert.notEqual(buildGenerationId('abc', 'tagline', event), buildGenerationId('abc', 'imageTheme', event));
  assert.notEqual(buildGenerationId('abc', 'tagline', event, '1'), buildGenerationId('abc', 'tagline', event, '2'));
  assert.notEqual(buildGenerationId('abc', 'tagline', event), buildGenerationId('abc', 'tagline', { ...event, title: 'Changed camp' }));
});

test('later generated image theme does not invalidate earlier stage IDs', () => {
  const before = { title: 'Camp', start: { raw: '2026-09-01T10:00:00Z' }, metadata: { image: { theme: null } } };
  const after = { title: 'Camp', start: { raw: '2026-09-01T10:00:00Z' }, metadata: { image: { theme: 'campfire under stars' } } };

  assert.equal(buildGenerationId('abc', 'tagline', before), buildGenerationId('abc', 'tagline', after));
  assert.equal(buildGenerationId('abc', 'imageTheme', before), buildGenerationId('abc', 'imageTheme', after));
  assert.notEqual(buildGenerationId('abc', 'image', before), buildGenerationId('abc', 'image', after));
});

test('eligibility enforces cooldown, quarantine, max attempts, active lease and success reuse', () => {
  const now = new Date('2026-09-02T12:00:00Z');
  assert.equal(evaluateEnrichmentEligibility(null, now).eligible, true);
  assert.equal(evaluateEnrichmentEligibility({ state: 'retry_wait', nextRetryAt: '2026-09-02T13:00:00Z', attemptCount: 1 }, now).reason, 'cooldown_active');
  assert.equal(evaluateEnrichmentEligibility({ state: 'retry_wait', nextRetryAt: '2026-09-02T11:00:00Z', attemptCount: 1 }, now).eligible, true);
  assert.equal(evaluateEnrichmentEligibility({ state: 'manual_review', attemptCount: 3 }, now).reason, 'manual_review');
  assert.equal(evaluateEnrichmentEligibility({ state: 'retry_wait', attemptCount: 3 }, now).reason, 'max_attempts_reached');
  assert.equal(evaluateEnrichmentEligibility({ state: 'in_progress', attemptCount: 1, inProgressExpiresAt: now.getTime() + 1000 }, now).reason, 'in_progress');
  assert.equal(evaluateEnrichmentEligibility({ state: 'in_progress', attemptCount: 1, inProgressExpiresAt: now.getTime() - 1 }, now).eligible, true);
  assert.equal(evaluateEnrichmentEligibility({ state: 'succeeded', geminiSucceeded: true, generationId: 'g1' }, now, 'g1').reason, 'already_succeeded');
  assert.equal(evaluateEnrichmentEligibility({ state: 'succeeded', geminiSucceeded: true, generationId: 'g1' }, now, 'g2').eligible, true);
});

test('failure classification distinguishes retryable and terminal categories', () => {
  assert.equal(classifyGeminiError({ status: 429 }), 'RATE_LIMIT');
  for (const status of [500, 502, 503, 504]) assert.equal(classifyGeminiError({ status }), 'PROVIDER_5XX');
  assert.equal(classifyGeminiError(new Error('socket timeout')), 'NETWORK_TIMEOUT');
  assert.equal(classifyGeminiError(new Error('ECONNRESET from upstream')), 'NETWORK_TIMEOUT');
  assert.equal(classifyGeminiError({ status: 401 }), 'AUTH_FAILURE');
  assert.equal(classifyGeminiError({ status: 403 }), 'AUTH_FAILURE');
  assert.equal(classifyGeminiError({ status: 404, message: 'model not found' }), 'MODEL_CONFIGURATION');
  assert.equal(classifyGeminiError(new Error('missing required event metadata')), 'INVALID_EVENT_DATA');
  assert.equal(classifyGeminiError(new Error('unexpected provider response')), 'UNKNOWN');
});

test('retry delays implement the 1 hour then 6 hour policy', () => {
  assert.equal(retryDelaySeconds(1), 3600);
  assert.equal(retryDelaySeconds(2), 21600);
  assert.equal(retryDelaySeconds(3), 21600);
});
