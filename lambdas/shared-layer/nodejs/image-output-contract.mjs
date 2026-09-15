import sharp from 'sharp';

export const CANONICAL_IMAGE_WIDTH = 1200;
export const CANONICAL_IMAGE_HEIGHT = 900;
export const CANONICAL_IMAGE_ASPECT_RATIO = 4 / 3;

function configuredDimension(value, fallback, minimum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.floor(number)) : fallback;
}

export function resolveCanonicalImageDimensions(env = process.env) {
  const width = configuredDimension(env.GEMINI_IMAGE_OUTPUT_WIDTH, CANONICAL_IMAGE_WIDTH, 320);
  const height = configuredDimension(env.GEMINI_IMAGE_OUTPUT_HEIGHT, CANONICAL_IMAGE_HEIGHT, 240);
  if (width * 3 !== height * 4) {
    throw new Error(`Generated image dimensions must be 4:3; received ${width}x${height}`);
  }
  return { width, height };
}

export function scaledCanonicalImageDimensions(scale = 1) {
  const scaled = Math.round(CANONICAL_IMAGE_WIDTH * Number(scale));
  const width = Math.max(640, Math.round(scaled / 4) * 4);
  return { width, height: width * 3 / 4 };
}

export async function normaliseGeneratedJpeg(buffer, {
  width,
  height,
  quality = 85,
} = {}) {
  const dimensions = width && height ? { width, height } : resolveCanonicalImageDimensions();
  return sharp(buffer)
    .rotate()
    .trim()
    .resize({
      width: dimensions.width,
      height: dimensions.height,
      fit: 'cover',
      position: 'centre',
    })
    .jpeg({ mozjpeg: true, quality })
    .toBuffer();
}
