import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  CANONICAL_IMAGE_HEIGHT,
  CANONICAL_IMAGE_WIDTH,
  normaliseGeneratedJpeg,
  resolveCanonicalImageDimensions,
  scaledCanonicalImageDimensions,
} from './image-output-contract.mjs';

test('canonical image dimensions default to 1200x900 and reject ratio drift', () => {
  assert.deepEqual(resolveCanonicalImageDimensions({}), { width: 1200, height: 900 });
  assert.deepEqual(resolveCanonicalImageDimensions({ GEMINI_IMAGE_OUTPUT_WIDTH: '800', GEMINI_IMAGE_OUTPUT_HEIGHT: '600' }), { width: 800, height: 600 });
  assert.throws(
    () => resolveCanonicalImageDimensions({ GEMINI_IMAGE_OUTPUT_WIDTH: '1366', GEMINI_IMAGE_OUTPUT_HEIGHT: '768' }),
    /must be 4:3/,
  );
  assert.equal(CANONICAL_IMAGE_WIDTH * 3, CANONICAL_IMAGE_HEIGHT * 4);
});

test('normalisation centre-crops arbitrary source ratios into a canonical JPEG', async () => {
  const source = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 255, g: 120, b: 20 } } }).png().toBuffer();
  const output = await normaliseGeneratedJpeg(source);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 900);
});

test('byte-budget fallback dimensions remain exactly 4:3', () => {
  for (const scale of [0.9, 0.73, 0.51]) {
    const dimensions = scaledCanonicalImageDimensions(scale);
    assert.equal(dimensions.width * 3, dimensions.height * 4);
  }
});
