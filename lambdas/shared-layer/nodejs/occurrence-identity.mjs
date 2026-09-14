import { createHash } from 'crypto';

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function stableOsmIdentity(value) {
  const match = text(value).match(/(?:^|[-:])event-(\d+)(?:[-:]|$)/i);
  return match ? `osm-event:${match[1]}` : '';
}

/** Return the strongest available source identity for one concrete occurrence. */
export function sourceOccurrenceIdentity(event = {}) {
  const source = event.source && typeof event.source === 'object' ? event.source : {};
  const osm = stableOsmIdentity(event.uid ?? event.originalUid ?? source.uid ?? source.id);
  if (osm) return osm;

  const nativeId = text(event.occurrenceSourceId ?? event.sourceEventId ?? event.eventId ?? source.eventId ?? source.id);
  if (nativeId) return `source:${nativeId}`;

  const uid = text(event.uid ?? event.originalUid ?? source.uid ?? event.raw?.UID);
  const recurrence = text(event.recurrenceId ?? event.recurrenceID ?? source.recurrenceId ?? event.raw?.['RECURRENCE-ID']);
  if (uid && recurrence) return `ics:${uid}|recurrence:${recurrence}`;
  if (uid) {
    const start = text(event.start?.sortKey ?? event.start?.raw ?? event.dtstart);
    return start ? `uid:${uid}|start:${start}` : `uid:${uid}`;
  }

  const title = text(event.title ?? event.summary).toLowerCase();
  const start = text(event.start?.sortKey ?? event.start?.raw ?? event.dtstart);
  const location = text(event.location).toLowerCase();
  return title || start || location ? `fallback:${title}|${start}|${location}` : '';
}

/** Stable opaque identity. Clients may carry it but must not construct it. */
export function resolveOccurrenceId(event = {}) {
  const existing = text(event.occurrenceId);
  if (existing) return existing;
  const identity = sourceOccurrenceIdentity(event);
  if (!identity) return null;
  return `occ_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

export function occurrenceStorageKey(occurrenceId) {
  const id = text(occurrenceId);
  if (!/^occ_[a-f0-9]{24,}$/i.test(id)) throw new Error('Invalid occurrenceId');
  return `occurrences/${id}.json`;
}

