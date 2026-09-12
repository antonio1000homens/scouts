const HEX_PATTERN = /^[0-9a-f]+$/;

export const CANONICAL_EVENT_TOP_LEVEL_KEYS = Object.freeze(['title', 'metadata', 'requests']);
export const CANONICAL_METADATA_KEYS = Object.freeze(['hex', 'tagline', 'image', 'status']);
export const CANONICAL_IMAGE_KEYS = Object.freeze(['theme', 'url']);
export const CANONICAL_STATUS_KEYS = Object.freeze(['isHidden', 'isApproved']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sortedKeys(value) {
  return Object.keys(value || {}).sort();
}

function assertExactKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  const extras = Object.keys(value || {}).filter((key) => !allowed.has(key));
  if (extras.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${extras.sort().join(', ')}`);
  }
}

function nullableText(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label} must be a string or null`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be blank`);
  return trimmed;
}

export function normalizeCanonicalHex(value, label = 'metadata.hex') {
  if (typeof value !== 'string') throw new Error(`${label} must be a lowercase hexadecimal string`);
  const normalized = value.trim().toLowerCase();
  if (!normalized || !HEX_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a lowercase hexadecimal string`);
  }
  return normalized;
}

export function titleToHex(title) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('title must be a non-empty string');
  return Buffer.from(title.trim().toLowerCase(), 'utf8').toString('hex');
}

export function buildCanonicalMetadata({
  hex,
  tagline = null,
  imageTheme = null,
  imageUrl = null,
  isHidden = false,
  isApproved = false,
} = {}) {
  return {
    hex: normalizeCanonicalHex(hex),
    tagline: tagline == null ? null : nullableText(tagline, 'metadata.tagline'),
    image: {
      theme: imageTheme == null ? null : nullableText(imageTheme, 'metadata.image.theme'),
      url: imageUrl == null ? null : nullableText(imageUrl, 'metadata.image.url'),
    },
    status: {
      isHidden: isHidden === true,
      isApproved: isApproved === true,
    },
  };
}

export function buildCanonicalEventDocument({
  title,
  hex,
  tagline = null,
  imageTheme = null,
  imageUrl = null,
  isHidden = false,
  isApproved = false,
  requests = [],
} = {}) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('title must be a non-empty string');
  if (!Array.isArray(requests)) throw new Error('requests must be an array');
  return {
    title: title.trim(),
    metadata: buildCanonicalMetadata({
      hex,
      tagline,
      imageTheme,
      imageUrl,
      isHidden,
      isApproved,
    }),
    requests: structuredClone(requests),
  };
}

export function assertCanonicalMetadata(input, { expectedHex = null, requireComplete = false } = {}) {
  if (!isObject(input)) throw new Error('metadata must be an object');
  assertExactKeys(input, CANONICAL_METADATA_KEYS, 'metadata');

  const hex = normalizeCanonicalHex(input.hex);
  if (expectedHex && hex !== normalizeCanonicalHex(expectedHex, 'expectedHex')) {
    throw new Error(`metadata.hex ${hex} does not match expected HEX ${String(expectedHex).trim().toLowerCase()}`);
  }

  const tagline = input.tagline === null ? null : nullableText(input.tagline, 'metadata.tagline');

  if (!isObject(input.image)) throw new Error('metadata.image must be an object');
  assertExactKeys(input.image, CANONICAL_IMAGE_KEYS, 'metadata.image');
  const imageTheme = input.image.theme === null ? null : nullableText(input.image.theme, 'metadata.image.theme');
  const imageUrl = input.image.url === null ? null : nullableText(input.image.url, 'metadata.image.url');

  if (!isObject(input.status)) throw new Error('metadata.status must be an object');
  assertExactKeys(input.status, CANONICAL_STATUS_KEYS, 'metadata.status');
  if (typeof input.status.isHidden !== 'boolean') throw new Error('metadata.status.isHidden must be boolean');
  if (typeof input.status.isApproved !== 'boolean') throw new Error('metadata.status.isApproved must be boolean');

  if (requireComplete) {
    if (!tagline) throw new Error('canonical event is incomplete: metadata.tagline is missing');
    if (!imageTheme) throw new Error('canonical event is incomplete: metadata.image.theme is missing');
    if (!imageUrl) throw new Error('canonical event is incomplete: metadata.image.url is missing');
  }

  return {
    hex,
    tagline,
    image: { theme: imageTheme, url: imageUrl },
    status: {
      isHidden: input.status.isHidden,
      isApproved: input.status.isApproved,
    },
  };
}

export function assertCanonicalEventDocument(input, { expectedHex = null, requireComplete = false } = {}) {
  if (!isObject(input)) throw new Error('event document must be an object');
  assertExactKeys(input, CANONICAL_EVENT_TOP_LEVEL_KEYS, 'event document');
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('title must be a non-empty string');
  if (!Array.isArray(input.requests)) throw new Error('requests must be an array');
  for (const [index, request] of input.requests.entries()) {
    if (!isObject(request)) throw new Error(`requests[${index}] must be an object`);
  }
  assertCanonicalMetadata(input.metadata, { expectedHex, requireComplete });
  return input;
}

export function assertCanonicalAgendaEvent(input, { requireComplete = false } = {}) {
  if (!isObject(input)) throw new Error('agenda event must be an object');
  const metadata = assertCanonicalMetadata(input.metadata, { requireComplete });
  return { event: input, metadata };
}

export function canonicalEventShapeSummary(input) {
  assertCanonicalEventDocument(input);
  return {
    topLevel: sortedKeys(input),
    metadata: sortedKeys(input.metadata),
    image: sortedKeys(input.metadata.image),
    status: sortedKeys(input.metadata.status),
  };
}
