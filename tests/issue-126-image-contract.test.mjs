import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('lambdas/sqs2scouts/scouts.conf', 'utf8'));
const loader = readFileSync('website/scripts/event-loader.js', 'utf8');
const adminStyles = readFileSync('website/admin/admin-styles.css', 'utf8');
const publicStyles = readFileSync('website/styles.css', 'utf8');
const viewportStyles = readFileSync('website/homepage-viewport.css', 'utf8');
const processing = readFileSync('lambdas/sqs2scouts/function/persistence-processor.mjs', 'utf8');
const provider = readFileSync('lambdas/sqs2scouts/function/image-provider-worker.mjs', 'utf8');
const core = readFileSync('lambdas/sqs2scouts/function/full-enrich-core.mjs', 'utf8');

test('issue 126 defines 4:3 generation guidance and shared server normalisation', () => {
  const specifications = config.imageGenerationPromptSpecifications.join(' ').toLowerCase();
  assert.match(specifications, /4:3/);
  assert.match(specifications, /edge-to-edge/);
  assert.match(specifications, /square corners/);
  assert.match(specifications, /centered/);
  assert.match(core, /normaliseGeneratedJpeg/);
  assert.match(provider, /normaliseGeneratedJpeg/);
  assert.match(processing, /normaliseGeneratedJpeg/);
});

test('issue 126 keeps all generated image processing on the centre-crop contract', () => {
  const contract = readFileSync('lambdas/shared-layer/nodejs/image-output-contract.mjs', 'utf8');
  assert.match(contract, /CANONICAL_IMAGE_WIDTH = 1200/);
  assert.match(contract, /CANONICAL_IMAGE_HEIGHT = 900/);
  assert.match(contract, /fit: 'cover'/);
  assert.match(contract, /position: 'centre'/);
  assert.doesNotMatch(processing, /fit:\s*['"]inside['"]/);
  assert.doesNotMatch(provider, /fit:\s*['"]inside['"]/);
  assert.doesNotMatch(core, /fit:\s*['"]inside['"]/);
});

test('issue 126 uses matching 4:3 non-distorting presentation frames', () => {
  assert.match(loader, /class="event-card-image-frame"/);
  assert.match(publicStyles, /\.event-card-image-frame\s*\{[\s\S]*aspect-ratio:\s*4 \/ 3/);
  assert.match(publicStyles, /\.event-card-image-frame img\s*\{[\s\S]*object-fit:\s*cover/);
  assert.match(adminStyles, /\.event-image\s*\{[\s\S]*object-fit:\s*cover/);
  assert.match(adminStyles, /\.modal-image-frame img\s*\{[\s\S]*object-fit:\s*cover/);
  assert.doesNotMatch(viewportStyles, /\.home-page \.event-card img\s*\{/);
});
