import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const TARGET_BUCKET = process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const AGENDA_KEY = process.env.SCOUTS_AGENDA_KEY || 'agenda.json';
const s3 = new S3Client({ region: REGION });

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

export function titleToHex(title) {
  const normalized = text(title).toLowerCase();
  if (!normalized) return null;
  return Buffer.from(normalized, 'utf8').toString('hex');
}

export function ensureAgendaEventHex(event) {
  if (!event || typeof event !== 'object') {
    return { changed: false, hex: null };
  }

  const metadata = event.metadata && typeof event.metadata === 'object'
    ? event.metadata
    : {};
  const currentHex = text(metadata.hex || event.hex || event.hexId).toLowerCase();
  const derivedHex = currentHex || titleToHex(event.summary ?? event.title ?? null);

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

export async function repairAgendaHexMetadata() {
  const response = await s3.send(new GetObjectCommand({
    Bucket: TARGET_BUCKET,
    Key: AGENDA_KEY,
  }));
  const raw = await response.Body.transformToString();
  const agenda = JSON.parse(raw);
  const result = repairAgendaDocument(agenda);

  if (!result.changed) {
    return {
      repairedCount: 0,
      missingCount: result.missingCount,
      bucket: TARGET_BUCKET,
      key: AGENDA_KEY,
    };
  }

  await s3.send(new PutObjectCommand({
    Bucket: TARGET_BUCKET,
    Key: AGENDA_KEY,
    Body: JSON.stringify(result.agenda, null, 2),
    ContentType: 'application/json',
    CacheControl: 'no-store',
  }));

  console.log('[AgendaHexRepair] Backfilled canonical HEX metadata.', {
    repairedCount: result.repairedCount,
    missingCount: result.missingCount,
    bucket: TARGET_BUCKET,
    key: AGENDA_KEY,
  });

  return {
    repairedCount: result.repairedCount,
    missingCount: result.missingCount,
    bucket: TARGET_BUCKET,
    key: AGENDA_KEY,
  };
}
