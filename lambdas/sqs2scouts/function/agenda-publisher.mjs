function clone(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

function text(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result || null;
}

function titleHex(event) {
  const title = text(event?.summary ?? event?.title ?? event?.name);
  return title ? Buffer.from(title, 'utf8').toString('hex') : null;
}

function eventHex(event) {
  return text(event?.metadata?.hex ?? event?.metadata?.hexId ?? event?.hex ?? event?.hexId)?.toLowerCase()
    ?? titleHex(event)?.toLowerCase()
    ?? null;
}

function metadataForAgenda(event, hex) {
  const source = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const image = source.image && typeof source.image === 'object'
    ? source.image
    : (event?.image && typeof event.image === 'object' ? event.image : {});
  const status = source.status && typeof source.status === 'object'
    ? source.status
    : (event?.status && typeof event.status === 'object' ? event.status : {});
  const metadata = clone(source) || {};
  metadata.hex = hex;
  metadata.tagline = text(source.tagline ?? event?.tagline ?? event?.AI ?? event?.ai);
  metadata.image = {
    theme: text(image.theme ?? event?.imageTheme),
    url: text(image.url ?? image.src ?? event?.imageUrl),
  };
  metadata.status = {
    isHidden: status.isHidden === true || event?.isHidden === true || event?.status === 'hidden',
    isApproved: status.isApproved === true || event?.isApproved === true || event?.approved === true,
  };
  delete metadata.requests;
  delete metadata.requestIds;
  return metadata;
}

export function mergeCanonicalEventIntoAgenda(agenda, canonicalEvent, hex) {
  if (!agenda || typeof agenda !== 'object' || !Array.isArray(agenda.events)) {
    throw new Error('agenda.json is missing its events array');
  }
  const normalisedHex = text(hex)?.toLowerCase();
  if (!normalisedHex) throw new Error('Agenda publication requires a HEX identifier');

  let matched = 0;
  const events = agenda.events.map((event) => {
    if (eventHex(event) !== normalisedHex) return event;
    matched += 1;
    return {
      ...event,
      metadata: metadataForAgenda(canonicalEvent, normalisedHex),
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
