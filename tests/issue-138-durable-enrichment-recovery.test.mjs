import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scoutsEntry = readFileSync('lambdas/scouts/function/scouts-entry.mjs', 'utf8');
const scoutsTemplate = readFileSync('lambdas/cloudformation/templates/scouts.yaml', 'utf8');
const admin = readFileSync('website/admin/admin-script.js', 'utf8');
const shell = readFileSync('website/admin/admin-simplify.js', 'utf8');
const html = readFileSync('website/admin/index.html', 'utf8');

test('durable enrichment status is exposed independently of request Activity', () => {
  assert.match(scoutsEntry, /BatchGetItemCommand/);
  assert.match(scoutsEntry, /loadDurableEnrichmentStatus/);
  assert.match(scoutsEntry, /command\.subject === 'enrichment' && command\.action === 'status'/);
  assert.match(scoutsEntry, /needsAttention: false/);
  assert.match(scoutsEntry, /state === 'manual_review'/);
  assert.match(scoutsEntry, /lastErrorType/);
  assert.match(scoutsEntry, /lastErrorMessage/);
  assert.match(scoutsTemplate, /dynamodb:BatchGetItem/);
});

test('manual-review retry accepts durable HEX and stage without an Activity ID', () => {
  assert.match(scoutsEntry, /hex = normalizePrivateEventHex\(command\.body\?\.hex\)/);
  assert.match(scoutsEntry, /stage = normaliseEnrichmentStage\(command\.body\?\.stage\)/);
  assert.match(scoutsEntry, /rootRequestId = crypto\.randomUUID\(\)/);
  assert.match(scoutsEntry, /retryManualReviewEnrichment\(/);
  assert.match(scoutsEntry, /recordRequestActivity\(\{/);
  assert.match(scoutsEntry, /source: 'admin-manual-review-retry'/);
  assert.match(scoutsEntry, /restoreManualReviewAfterEnqueueFailure/);
});

test('admin surfaces durable manual-review state directly on event cards', () => {
  assert.match(admin, /hydrateDurableEnrichmentState/);
  assert.match(admin, /subject: 'enrichment',[\s\S]*action: 'status'/);
  assert.match(admin, /renderDurableEnrichmentRecoveryMarkup/);
  assert.match(admin, /event-enrichment-recovery/);
  assert.match(admin, /Retry .* enrichment/);
  assert.match(admin, /retryEventEnrichment/);
  assert.match(admin, /subject: 'enrichment',[\s\S]*action: 'retry',[\s\S]*hex,[\s\S]*stage/);
  assert.match(admin, /failure\.type/);
  assert.match(admin, /failure\.message/);
});

test('needs-attention is a first-class event filter and blocks synthetic Generate Full recovery', () => {
  assert.match(html, /filter-btn-attention/);
  assert.match(html, /Needs Attention/);
  assert.match(admin, /case 'attention':[\s\S]*isEntryNeedsAttention/);
  assert.match(admin, /attention: uniqueEventEntries\.filter/);
  assert.match(admin, /missingFields\.length > 0 && manualReviewStages\.length === 0/);
});

test('agenda and stored-event views hydrate the same durable recovery state', () => {
  assert.match(admin, /applyVisibilityOverrides\(uniqueEventEntries\);\n\s*await hydrateDurableEnrichmentState\(uniqueEventEntries\)/);
  assert.match(shell, /await hydrateDurableEnrichmentState\(uniqueEventEntries\)/);
  assert.match(shell, /await replaceAdminEventDataset\(result\.events\)/);
});
