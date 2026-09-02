import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGenerationId,
  evaluateEnrichmentEligibility,
  classifyGeminiError,
  retryDelaySeconds,
} from './enrichment-state.mjs';

test('generation IDs are stable and stage-specific', () => {
  const event = { title: 'Camp', start: { raw: '2026-09-01T10:00:00Z' } };
  assert.equal(buildGenerationId('ABC', 'tagline', event), buildGenerationId('abc', 'tagline', event));
  assert.notEqual(buildGenerationId('abc', 'tagline', event), buildGenerationId('abc', 'imageTheme', event));
});

test('eligibility enforces cooldown, quarantine and success reuse', () => {
  const now = new Date('2026-09-02T12:00:00Z');
  assert.equal(evaluateEnrichmentEligibility(null, now).eligible, true);
  assert.equal(evaluateEnrichmentEligibility({ state: 'retry_wait', nextRetryAt: '2026-09-02T13:00:00Z', attemptCount: 1 }, now).reason, 'cooldown_active');
  assert.equal(evaluateEnrichmentEligibility({ state: 'retry_wait', nextRetryAt: '2026-09-02T11:00:00Z', attemptCount: 1 }, now).eligible, true);
  assert.equal(evaluateEnrichmentEligibility({ state: 'manual_review', attemptCount: 3 }, now).reason, 'manual_review');
  assert.equal(evaluateEnrichmentEligibility({ state: 'succeeded', geminiSucceeded: true }, now).reason, 'already_succeeded');
});

test('failure classification and delays are explicit', () => {
  assert.equal(classifyGeminiError({ status: 429 }), 'RATE_LIMIT');
  assert.equal(classifyGeminiError({ status: 503 }), 'PROVIDER_5XX');
  assert.equal(classifyGeminiError({ status: 401 }), 'AUTH_FAILURE');
  assert.equal(classifyGeminiError(new Error('socket timeout')), 'NETWORK_TIMEOUT');
  assert.equal(retryDelaySeconds(1), 3600);
  assert.equal(retryDelaySeconds(2), 21600);
});
