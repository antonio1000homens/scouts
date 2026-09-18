import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const admin = readFileSync('website/admin/admin-script.js', 'utf8');
const html = readFileSync('website/admin/index.html', 'utf8');
const scouts = readFileSync('lambdas/scouts/function/scouts-service.mjs', 'utf8');
const router = readFileSync('lambdas/scouts2sqs/function/request-router.mjs', 'utf8');
const processor = readFileSync('lambdas/sqs2scouts/function/persistence-processor.mjs', 'utf8');
const enrichment = readFileSync('lambdas/shared-layer/nodejs/enrichment-state.mjs', 'utf8');
const sqsConfig = JSON.parse(readFileSync('lambdas/sqs2scouts/scouts.conf', 'utf8'));
const scoutsConfig = JSON.parse(readFileSync('lambdas/scouts/scouts.conf', 'utf8'));

function assertSyntax(path) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path} syntax failed: ${result.stderr || result.stdout}`);
}

test('hidden events take precedence over durable manual-review presentation', () => {
  assert.match(admin, /function isEntryNeedsAttention\(entry\) \{\n\s*if \(isEntryHidden\(entry\)\) return false;/);
  assert.match(admin, /function renderDurableEnrichmentRecoveryMarkup\(entry, index\) \{\n\s*if \(isEntryHidden\(entry\)\) return '';/);
  assert.match(admin, /Hidden events do not require enrichment recovery/);
  assert.match(admin, /attention: uniqueEventEntries\.filter\(\(entry\) => isEntryNeedsAttention\(entry\)\)/);
});

test('hidden cards do not expose generation actions after destructive cleanup', () => {
  assert.match(admin, /if \(!hidden && missingFields\.length === 1/);
  assert.match(admin, /else if \(!hidden && missingFields\.length > 0 && manualReviewStages\.length === 0\)/);
});

test('normal hide remains non-destructive and destructive hide is explicit', () => {
  assert.match(admin, /async function hideEvent\(eventIndex, fromModal = false, action = 'hide', button = null, purgeGeneratedData = false\)/);
  assert.match(admin, /Hide & clear generated data/);
  assert.match(admin, /hideAndClearEvent/);
  assert.match(admin, /purgeGeneratedData \? \{ purgeGeneratedData: true \} : \{\}/);
  assert.match(html, /modal-hide-clear-button/);
  assert.match(html, /Hide &amp; clear generated data/);
});

test('destructive hide intent is carried through API and queue routing', () => {
  assert.match(scouts, /const purgeGeneratedData = isHideOperation && bodyParams\?\.purgeGeneratedData === true/);
  assert.match(scouts, /purgeGeneratedData \? \{ purgeGeneratedData: true \} : \{\}/);
  assert.match(router, /message\?\.purgeGeneratedData === true \|\| subject\.purgeGeneratedData === true/);
  assert.match(router, /translated\.purgeGeneratedData \? \{ purgeGeneratedData: true \} : \{\}/);
});

test('destructive hide clears generated metadata but preserves canonical hidden identity', () => {
  assert.match(processor, /function clearGeneratedEventDataForHide/);
  assert.match(processor, /delete event\.AI/);
  assert.match(processor, /delete event\.tagline/);
  assert.match(processor, /delete event\.sourceImg/);
  assert.match(processor, /event\.metadata\.tagline = null/);
  assert.match(processor, /event\.metadata\.image = \{ theme: null, url: null \}/);
  assert.match(processor, /isApproved: false/);
  assert.match(processor, /isHidden: true/);
  assert.doesNotMatch(processor, /delete event\.title/);
  assert.doesNotMatch(processor, /delete event\.summary/);
  assert.doesNotMatch(processor, /delete event\.location/);
});

test('generated image deletion is HEX scoped and protects prefix collisions', () => {
  assert.match(processor, /function deleteGeneratedImageArtifactsForHex/);
  assert.match(processor, /const prefix = `\$\{EVENT_IMAGE_PREFIX\}\$\{sanitizedHex\}`/);
  assert.match(processor, /if \(!\/\^\(\?:\\\\\.|-\)\/\.test\(suffix\)\) continue/);
  assert.match(processor, /new DeleteObjectCommand/);
});

test('destructive hide resets all durable enrichment stages and stale manual-review fields', () => {
  assert.match(processor, /clearDurableEnrichmentForHiddenEvent/);
  assert.match(processor, /\['tagline', 'imageTheme', 'image'\]/);
  assert.match(processor, /clearEnrichmentState\(hexValue, stage\)/);
  assert.match(enrichment, /export async function clearEnrichmentState/);
  for (const field of [
    'lastErrorType',
    'lastErrorMessage',
    'generatedValue',
    'generationId',
    'manualReviewRetryCount',
    'previousManualReviewErrorType',
  ]) {
    assert.match(enrichment, new RegExp(`#${field}`));
  }
});

test('metadata regeneration and manual retry replace the displayed value with a processing placeholder', () => {
  assert.match(admin, /METADATA_PROCESSING_LABEL = 'Processing, please wait'/);
  assert.match(admin, /function markMetadataProcessing/);
  assert.match(admin, /markMetadataProcessing\(entry, processingFields\)/);
  assert.match(admin, /markMetadataProcessing\(entry, \[stage\]\)/);
  assert.match(admin, /clearMetadataProcessing\(hex, processingFields\)/);
  assert.match(admin, /processingFields,/);
  assert.match(admin, /isMetadataFieldProcessing\(event, 'imageUrl'\) \? METADATA_PROCESSING_LABEL/);
});

test('image generation boilerplate explicitly requests diverse Cubs and Scouts from different heritages', () => {
  for (const config of [sqsConfig, scoutsConfig]) {
    const specifications = config.imageGenerationPromptSpecifications.join(' ').toLowerCase();
    assert.match(specifications, /diverse/);
    assert.match(specifications, /cubs/);
    assert.match(specifications, /scouts/);
    assert.match(specifications, /different ethnic and cultural heritages/);
  }
});

test('follow-up implementation files are syntactically valid', () => {
  for (const path of [
    'website/admin/admin-script.js',
    'lambdas/scouts/function/scouts-service.mjs',
    'lambdas/scouts2sqs/function/request-router.mjs',
    'lambdas/sqs2scouts/function/persistence-processor.mjs',
    'lambdas/shared-layer/nodejs/enrichment-state.mjs',
  ]) assertSyntax(path);
});
