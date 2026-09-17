import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const TARGET_BUCKET = process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const AGENDA_KEY = process.env.SCOUTS_AGENDA_KEY || 'agenda.json';
const CALENDAR_CACHE_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const s3 = new S3Client({ region: REGION });

const CALENDAR_FEEDS = Object.freeze([
  { key: 'calendar/cubs-events.ics', url: process.env.CUBS_EVENTS_CALENDAR_URL || '' },
  { key: 'calendar/cubs-programme.ics', url: process.env.CUBS_PROGRAMME_CALENDAR_URL || '' },
  { key: 'calendar/scouts-events.ics', url: process.env.SCOUTS_EVENTS_CALENDAR_URL || '' },
  { key: 'calendar/scouts-programme.ics', url: process.env.SCOUTS_PROGRAMME_CALENDAR_URL || '' },
  { key: 'calendar/beavers-events.ics', url: process.env.BEAVERS_EVENTS_CALENDAR_URL || '' },
  { key: 'calendar/beavers-programme.ics', url: process.env.BEAVERS_PROGRAMME_CALENDAR_URL || '' },
]);

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeComparableText(value) {
  return text(value)
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function titleToHex(title) {
  const normalized = text(title).toLowerCase();
  if (!normalized) return null;
  return Buffer.from(normalized, 'utf8').toString('hex');
}

export function sanitizeEventUid(uid) {
  if (uid === undefined || uid === null) return null;
  let candidate = String(uid).trim();
  if (!candidate) return null;
  candidate = candidate.split(/[\/\\]/)[0] || candidate;
  candidate = candidate.replace(/\s+/g, '-');
  candidate = candidate.replace(/[^a-zA-Z0-9._-]/g, '-');
  candidate = candidate.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const digitPrefixMatch = candidate.match(/^(.*?\d+)/);
  if (digitPrefixMatch) candidate = digitPrefixMatch[1];
  return candidate || null;
}

function cleanIcsValue(value) {
  return text(value)
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

export function parseCalendarFeedEvents(icsText) {
  const unfolded = String(icsText || '').replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1);
  const events = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.split('END:VEVENT')[0];
    let uid = null;
    let summary = null;
    let dtstart = null;
    let lastModified = null;

    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const separatorIndex = line.indexOf(':');
      if (separatorIndex <= 0) continue;
      const property = line.slice(0, separatorIndex).split(';')[0].toUpperCase();
      const value = cleanIcsValue(line.slice(separatorIndex + 1));

      if (property === 'UID') uid = sanitizeEventUid(value);
      else if (property === 'SUMMARY') summary = value;
      else if (property === 'DTSTART') dtstart = value;
      else if (property === 'LAST-MODIFIED' || property === 'DTSTAMP') lastModified = value;
    }

    if (uid && summary && dtstart) {
      events.push({ uid, summary, dtstart, lastModified });
    }
  }

  return events;
}

function compactDateToMillis(value) {
  const raw = text(value).toUpperCase();
  if (!raw) return null;
  if (/^\d{8}$/.test(raw)) {
    const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (/^\d{8}T\d{6}Z?$/.test(raw)) {
    const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function agendaEventTime(event) {
  return compactDateToMillis(event?.dtstart ?? event?.start?.raw ?? null);
}

function lastModifiedRaw(event) {
  return text(event?.lastModified?.raw ?? event?.lastModified ?? '');
}

function candidateScore(event, sourceEvent) {
  let score = 0;
  if (normalizeComparableText(event?.summary ?? event?.title) === normalizeComparableText(sourceEvent?.summary)) score += 100;
  if (text(event?.dtstart ?? event?.start?.raw) === text(sourceEvent?.dtstart)) score += 10;
  if (text(event?.metadata?.hex).toLowerCase() === text(titleToHex(sourceEvent?.summary)).toLowerCase()) score += 1;
  return score;
}

function chooseSourceCandidate(candidates, sourceEvent) {
  let best = candidates[0];
  let bestScore = candidateScore(best, sourceEvent);
  let bestModified = lastModifiedRaw(best);

  for (const candidate of candidates.slice(1)) {
    const score = candidateScore(candidate, sourceEvent);
    const modified = lastModifiedRaw(candidate);
    if (score > bestScore || (score === bestScore && modified > bestModified)) {
      best = candidate;
      bestScore = score;
      bestModified = modified;
    }
  }

  return best;
}

function resetTitleKeyedMetadata(event, summary) {
  event.metadata = {
    hex: titleToHex(summary),
    tagline: null,
    image: {
      theme: null,
      url: null,
    },
    status: {
      isHidden: false,
      isApproved: false,
    },
  };
}

export function ensureAgendaEventHex(event) {
  if (!event || typeof event !== 'object') {
    return { changed: false, hex: null };
  }

  const metadata = event.metadata && typeof event.metadata === 'object'
    ? event.metadata
    : {};
  const currentHex = text(metadata.hex || event.hex || event.hexId).toLowerCase();
  const derivedHex = titleToHex(event.summary ?? event.title ?? null) || currentHex;

  if (!derivedHex) {
    return { changed: false, hex: null };
  }

  const metadataHex = text(metadata.hex).toLowerCase();
  if (metadataHex === derivedHex && event.metadata === metadata) {
    return { changed: false, hex: derivedHex };
  }

  event.metadata = {
    ...metadata,
    hex: derivedHex,
  };

  return { changed: true, hex: derivedHex };
}

export function reconcileAgendaDocument(agenda, calendarEvents = [], { authoritative = false, now = Date.now() } = {}) {
  if (!agenda || typeof agenda !== 'object' || !Array.isArray(agenda.events)) {
    return {
      agenda,
      changed: false,
      prunedCount: 0,
      deduplicatedCount: 0,
      renamedCount: 0,
      movedCount: 0,
    };
  }

  const currentByUid = new Map();
  for (const sourceEvent of Array.isArray(calendarEvents) ? calendarEvents : []) {
    const uid = sanitizeEventUid(sourceEvent?.uid);
    if (!uid) continue;
    currentByUid.set(uid, { ...sourceEvent, uid });
  }

  const groups = new Map();
  const withoutUid = [];
  for (const event of agenda.events) {
    const uid = sanitizeEventUid(event?.uid);
    if (!uid) {
      withoutUid.push(event);
      continue;
    }
    if (!groups.has(uid)) groups.set(uid, []);
    groups.get(uid).push(event);
  }

  const reconciled = [];
  let prunedCount = 0;
  let deduplicatedCount = 0;
  let renamedCount = 0;
  let movedCount = 0;

  for (const [uid, candidates] of groups.entries()) {
    const sourceEvent = currentByUid.get(uid);
    if (sourceEvent) {
      const selected = chooseSourceCandidate(candidates, sourceEvent);
      deduplicatedCount += Math.max(0, candidates.length - 1);

      const selectedSummary = selected.summary ?? selected.title ?? null;
      const summaryChanged = normalizeComparableText(selectedSummary) !== normalizeComparableText(sourceEvent.summary);
      const dtstartChanged = text(selected.dtstart ?? selected.start?.raw) !== text(sourceEvent.dtstart);

      if (summaryChanged) {
        selected.summary = sourceEvent.summary;
        if ('title' in selected) selected.title = sourceEvent.summary;
        resetTitleKeyedMetadata(selected, sourceEvent.summary);
        renamedCount += 1;
      }
      if (dtstartChanged) {
        selected.dtstart = sourceEvent.dtstart;
        movedCount += 1;
      }
      if (sourceEvent.lastModified) {
        selected.lastModified = { raw: sourceEvent.lastModified };
      }
      selected.uid = uid;
      reconciled.push(selected);
      continue;
    }

    for (const candidate of candidates) {
      const eventTime = agendaEventTime(candidate);
      if (authoritative && eventTime !== null && eventTime > now) {
        prunedCount += 1;
        continue;
      }
      reconciled.push(candidate);
    }
  }

  reconciled.push(...withoutUid);
  agenda.events = reconciled;

  return {
    agenda,
    changed: prunedCount > 0 || deduplicatedCount > 0 || renamedCount > 0 || movedCount > 0,
    prunedCount,
    deduplicatedCount,
    renamedCount,
    movedCount,
  };
}

export function repairAgendaDocument(agenda) {
  if (!agenda || typeof agenda !== 'object' || !Array.isArray(agenda.events)) {
    return { agenda, changed: false, repairedCount: 0, missingCount: 0 };
  }

  let repairedCount = 0;
  let missingCount = 0;

  for (const event of agenda.events) {
    const result = ensureAgendaEventHex(event);
    if (result.changed) repairedCount += 1;
    if (!result.hex) missingCount += 1;
  }

  return {
    agenda,
    changed: repairedCount > 0,
    repairedCount,
    missingCount,
  };
}

async function loadFreshCalendarSnapshot(now = Date.now()) {
  const configuredFeeds = CALENDAR_FEEDS.filter((feed) => text(feed.url));
  const events = [];
  const feedStatus = [];

  for (const feed of configuredFeeds) {
    try {
      const response = await s3.send(new GetObjectCommand({
        Bucket: TARGET_BUCKET,
        Key: feed.key,
      }));
      const modifiedAt = response?.LastModified ? new Date(response.LastModified).getTime() : NaN;
      const fresh = Number.isFinite(modifiedAt) && (now - modifiedAt) <= CALENDAR_CACHE_FRESHNESS_MS;
      if (!fresh) {
        feedStatus.push({ key: feed.key, fresh: false, reason: 'stale-cache' });
        continue;
      }

      const raw = await response.Body.transformToString();
      const parsed = parseCalendarFeedEvents(raw);
      events.push(...parsed);
      feedStatus.push({ key: feed.key, fresh: true, events: parsed.length });
    } catch (error) {
      feedStatus.push({ key: feed.key, fresh: false, reason: error?.name || error?.message || 'read-failed' });
    }
  }

  const authoritative = configuredFeeds.length > 0
    && feedStatus.length === configuredFeeds.length
    && feedStatus.every((feed) => feed.fresh === true);

  return { events, authoritative, feedStatus, configuredFeedCount: configuredFeeds.length };
}

export async function repairAgendaHexMetadata() {
  const response = await s3.send(new GetObjectCommand({
    Bucket: TARGET_BUCKET,
    Key: AGENDA_KEY,
  }));
  const raw = await response.Body.transformToString();
  const agenda = JSON.parse(raw);
  const calendarSnapshot = await loadFreshCalendarSnapshot();
  const reconciliation = reconcileAgendaDocument(agenda, calendarSnapshot.events, {
    authoritative: calendarSnapshot.authoritative,
  });
  const repair = repairAgendaDocument(reconciliation.agenda);
  const changed = reconciliation.changed || repair.changed;

  if (!changed) {
    return {
      repairedCount: 0,
      missingCount: repair.missingCount,
      prunedCount: 0,
      deduplicatedCount: 0,
      renamedCount: 0,
      movedCount: 0,
      authoritative: calendarSnapshot.authoritative,
      feedStatus: calendarSnapshot.feedStatus,
      bucket: TARGET_BUCKET,
      key: AGENDA_KEY,
    };
  }

  await s3.send(new PutObjectCommand({
    Bucket: TARGET_BUCKET,
    Key: AGENDA_KEY,
    Body: JSON.stringify(repair.agenda, null, 2),
    ContentType: 'application/json',
    CacheControl: 'no-store',
  }));

  console.log('[AgendaReconciliation] Reconciled agenda against fresh calendar caches.', {
    repairedCount: repair.repairedCount,
    missingCount: repair.missingCount,
    prunedCount: reconciliation.prunedCount,
    deduplicatedCount: reconciliation.deduplicatedCount,
    renamedCount: reconciliation.renamedCount,
    movedCount: reconciliation.movedCount,
    authoritative: calendarSnapshot.authoritative,
    feedStatus: calendarSnapshot.feedStatus,
    bucket: TARGET_BUCKET,
    key: AGENDA_KEY,
  });

  return {
    repairedCount: repair.repairedCount,
    missingCount: repair.missingCount,
    prunedCount: reconciliation.prunedCount,
    deduplicatedCount: reconciliation.deduplicatedCount,
    renamedCount: reconciliation.renamedCount,
    movedCount: reconciliation.movedCount,
    authoritative: calendarSnapshot.authoritative,
    feedStatus: calendarSnapshot.feedStatus,
    bucket: TARGET_BUCKET,
    key: AGENDA_KEY,
  };
}
