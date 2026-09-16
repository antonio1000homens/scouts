function clone(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

function text(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result || null;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, allowed, label) {
  const extras = Object.keys(value || {}).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains unsupported fields: ${extras.sort().join(', ')}`);
}

function canonicalHex(value, label = 'metadata.hex') {
  const normalized = text(value)?.toLowerCase() ?? null;
  if (!normalized || !/^[0-9a-f]+$/.test(normalized)) {
    throw new Error(`${label} must be a lowercase hexadecimal string`);
  }
  return normalized;
}

function eventHex(event) {
  if (!isObject(event?.metadata)) return null;
  const candidate = text(event.metadata.hex)?.toLowerCase() ?? null;
  return candidate && /^[0-9a-f]+$/.test(candidate) ? candidate : null;
}

function metadataForAgenda(event, expectedHex) {
  if (!isObject(event?.metadata)) throw new Error('Canonical event is missing metadata');
  const source = event.metadata;
  assertExactKeys(source, ['hex', 'tagline', 'image', 'status'], 'metadata');

  const hex = canonicalHex(source.hex);
  if (hex !== expectedHex) throw new Error(`Canonical event HEX ${hex} does not match ${expectedHex}`);

  const tagline = source.tagline === null ? null : text(source.tagline);
  if (source.tagline !== null && !tagline) throw new Error('metadata.tagline must be a non-empty string or null');

  if (!isObject(source.image)) throw new Error('metadata.image must be an object');
  assertExactKeys(source.image, ['theme', 'url'], 'metadata.image');
  const theme = source.image.theme === null ? null : text(source.image.theme);
  const url = source.image.url === null ? null : text(source.image.url);
  if (source.image.theme !== null && !theme) throw new Error('metadata.image.theme must be a non-empty string or null');
  if (source.image.url !== null && !url) throw new Error('metadata.image.url must be a non-empty string or null');

  if (!isObject(source.status)) throw new Error('metadata.status must be an object');
  assertExactKeys(source.status, ['isHidden', 'isApproved'], 'metadata.status');
  if (typeof source.status.isHidden !== 'boolean') throw new Error('metadata.status.isHidden must be boolean');
  if (typeof source.status.isApproved !== 'boolean') throw new Error('metadata.status.isApproved must be boolean');

  return {
    hex,
    tagline,
    image: { theme, url },
    status: {
      isHidden: source.status.isHidden,
      isApproved: source.status.isApproved,
    },
  };
}

export function mergeCanonicalEventIntoAgenda(agenda, canonicalEvent, hex) {
  if (!agenda || typeof agenda !== 'object' || !Array.isArray(agenda.events)) {
    throw new Error('agenda.json is missing its events array');
  }
  const normalisedHex = canonicalHex(hex, 'Agenda publication HEX');
  const canonicalMetadata = metadataForAgenda(canonicalEvent, normalisedHex);

  let matched = 0;
  const events = agenda.events.map((event) => {
    if (eventHex(event) !== normalisedHex) return event;
    matched += 1;
    return {
      ...event,
      metadata: clone(canonicalMetadata),
    };
  });

  if (matched === 0) {
    const error = new Error(`No agenda event matches HEX ${normalisedHex}`);
    error.code = 'AGENDA_EVENT_NOT_FOUND';
    throw error;
  }
  return {
    agenda: {
      ...agenda,
      generatedAt: new Date().toISOString(),
      events,
    },
    matched,
  };
}

export async function publishCanonicalEventToAgenda({ loadAgenda, writeAgenda, hex, event }) {
  if (typeof loadAgenda !== 'function' || typeof writeAgenda !== 'function') {
    throw new Error('Agenda publication requires loadAgenda and writeAgenda functions');
  }
  const agenda = await loadAgenda();
  const merged = mergeCanonicalEventIntoAgenda(agenda, event, hex);
  const put = await writeAgenda(merged.agenda);
  return {
    matched: merged.matched,
    eTag: put?.ETag || null,
    publishedAt: merged.agenda.generatedAt,
  };
}
