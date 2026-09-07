const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nVQAAAAASUVORK5CYII=',
  'base64',
);

export function createFakeScoutsProvider() {
  const calls = { tagline: 0, imageTheme: 0, image: 0 };

  return {
    calls,
    async generateTagline() {
      calls.tagline += 1;
      return 'Automated test tagline';
    },
    async generateImageTheme() {
      calls.imageTheme += 1;
      return 'friendly scouts outdoors illustration';
    },
    async generateImage() {
      calls.image += 1;
      return {
        provider: 'fake',
        contentType: 'image/png',
        buffer: Buffer.from(ONE_PIXEL_PNG),
      };
    },
  };
}

export function isValidPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false;
  return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}
