import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { processRevisionedApprovalRecords } from './approval-lifecycle-adapter.mjs';
import { lambdaHandler as imageProviderWorkerHandler } from './image-provider-worker.mjs';
import { normalizeLegacyApprovalCards } from './legacy-approval-card-normalizer.mjs';

const AWS_REGION = process.env.AWS_REGION || 'eu-west-2';
const TARGET_BUCKET = process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const s3 = new S3Client({ region: AWS_REGION });

function text(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeHex(value) {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && /^[0-9a-f]+$/i.test(normalized) ? normalized : null;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value).trim().toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value).trim().toLowerCase() === 'false') return false;
  return null;
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstBoolean(...values) {
  for (const value of values) {
    const normalized = normalizeBoolean(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function firstHex(...values) {
  for (const value of values) {
    const normalized = normalizeHex(value);
    if (normalized) return normalized;
  }
  return null;
}

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function parseRecord(record) {
  if (!record) return null;
  if (record.body && typeof record.body === 'object') return record.body;
  if (typeof record.body !== 'string') return null;
  try {
    return JSON.parse(record.body);
  } catch {
    return null;
  }
}

function eventHex(event) {
  return normalizeHex(event?.metadata?.hex);
}

function eventHidden(event) {
  return event?.metadata?.status?.isHidden;
}

async function loadJsonFromS3(key) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: TARGET_BUCKET, Key: key }));
    return {
      value: JSON.parse(await response.Body.transformToString()),
      eTag: text(response.ETag),
    };
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.name === 'NotFound' || Number(error?.$metadata?.httpStatusCode) === 404) {
      return { value: null, eTag: null };
    }
    throw error;
  }
}

async function defaultLoadAgenda() {
  return loadJsonFromS3('agenda.json');
}

async function defaultLoadEvent(hex) {
  return loadJsonFromS3(`events/${hex}.json`);
}

export function extractVisibilityPersistMutation(message) {
  if (text(message?.realm) !== 'persist') return null;

  const actionPatch = parseObject(message?.action);
  const subjectPatch = parseObject(message?.subject);
  const patch = actionPatch || subjectPatch || {};
  const subject = message?.subject && typeof message.subject === 'object' && !Array.isArray(message.subject)
    ? message.subject
    : {};

  const isHidden = firstBoolean(
    actionPatch?.metadata?.status?.isHidden,
    actionPatch?.status?.isHidden,
    actionPatch?.isHidden,
    actionPatch?.hidden,
    subject?.metadata?.status?.isHidden,
    subject?.status?.isHidden,
    subject?.isHidden,
    subject?.hidden,
  );
  if (isHidden === null) return null;

  const hex = firstHex(
    typeof message?.subject === 'string' ? message.subject : null,
    message?.hex,
    message?.requestHex,
    actionPatch?.metadata?.hex,
    actionPatch?.hex,
    subject?.metadata?.hex,
    subject?.hex,
    patch?.requestHex,
  );
  if (!hex) {
    throw codedError('VISIBILITY_PERSIST_HEX_MISSING', 'Visibility persistence request is missing a canonical HEX identifier');
  }

  return { hex, isHidden };
}

export async function prepareVisibilityPersistGuard(
  message,
  { loadAgenda = defaultLoadAgenda, loadEvent = defaultLoadEvent } = {},
) {
  const mutation = extractVisibilityPersistMutation(message);
  if (!mutation) return null;

  const [agendaSnapshot, eventSnapshot] = await Promise.all([
    loadAgenda(),
    loadEvent(mutation.hex),
  ]);
  const agenda = agendaSnapshot?.value ?? agendaSnapshot;
  const canonical = eventSnapshot?.value ?? eventSnapshot;
  const beforeETag = text(eventSnapshot?.eTag);
  const matching = Array.isArray(agenda?.events)
    ? agenda.events.filter((event) => eventHex(event) === mutation.hex)
    : [];

  if (matching.length === 0) {
    throw codedError(
      'VISIBILITY_TARGET_NOT_FOUND',
      `Visibility persistence target ${mutation.hex} is not present in agenda.json`,
      { hex: mutation.hex, matched: 0 },
    );
  }

  // Visibility belongs to an occurrence, not to title-derived shared metadata.
  // Until the ingress contract carries an occurrence selector end-to-end, a
  // duplicate HEX must fail before the canonical event file can be mutated.
  if (matching.length > 1) {
    throw codedError(
      'AMBIGUOUS_EVENT_OCCURRENCE',
      `Visibility persistence for HEX ${mutation.hex} matches ${matching.length} agenda occurrences; refusing a shared-title mutation`,
      { hex: mutation.hex, matched: matching.length },
    );
  }

  if (!canonical || typeof canonical !== 'object') {
    throw codedError(
      'VISIBILITY_CANONICAL_EVENT_NOT_FOUND',
      `Canonical event events/${mutation.hex}.json was not found`,
      { hex: mutation.hex },
    );
  }

  return {
    ...mutation,
    beforeETag,
    beforeHidden: eventHidden(canonical),
  };
}

export async function verifyVisibilityPersistGuard(
  guard,
  { loadAgenda = defaultLoadAgenda, loadEvent = defaultLoadEvent } = {},
) {
  if (!guard) return null;

  const [agendaSnapshot, eventSnapshot] = await Promise.all([
    loadAgenda(),
    loadEvent(guard.hex),
  ]);
  const agenda = agendaSnapshot?.value ?? agendaSnapshot;
  const canonical = eventSnapshot?.value ?? eventSnapshot;
  const afterETag = text(eventSnapshot?.eTag);

  const actualHidden = eventHidden(canonical);
  if (actualHidden !== guard.isHidden) {
    throw codedError(
      'PERSISTENCE_READ_BACK_MISMATCH',
      `Canonical event ${guard.hex} read-back has metadata.status.isHidden=${String(actualHidden)}; expected ${guard.isHidden}`,
      { hex: guard.hex, expected: guard.isHidden, actual: actualHidden },
    );
  }

  if (guard.beforeHidden !== guard.isHidden && guard.beforeETag && afterETag === guard.beforeETag) {
    throw codedError(
      'PERSISTENCE_ETAG_UNCHANGED',
      `Canonical event ${guard.hex} changed visibility but its S3 ETag did not change`,
      { hex: guard.hex, eTag: afterETag },
    );
  }

  const matching = Array.isArray(agenda?.events)
    ? agenda.events.filter((event) => eventHex(event) === guard.hex)
    : [];
  if (matching.length !== 1) {
    throw codedError(
      'PERSISTENCE_AGENDA_IDENTITY_MISMATCH',
      `Visibility persistence read-back for ${guard.hex} resolved ${matching.length} agenda occurrences; expected exactly one`,
      { hex: guard.hex, matched: matching.length },
    );
  }

  const agendaHidden = eventHidden(matching[0]);
  if (agendaHidden !== guard.isHidden) {
    throw codedError(
      'PERSISTENCE_AGENDA_READ_BACK_MISMATCH',
      `Agenda occurrence ${guard.hex} read-back has metadata.status.isHidden=${String(agendaHidden)}; expected ${guard.isHidden}`,
      { hex: guard.hex, expected: guard.isHidden, actual: agendaHidden },
    );
  }

  console.log('[VisibilityPersist] Read-back verified', {
    hex: guard.hex,
    isHidden: guard.isHidden,
    beforeETag: guard.beforeETag,
    afterETag,
  });
  return { hex: guard.hex, isHidden: guard.isHidden, eTag: afterETag };
}

function successfulResult(result) {
  const statusCode = Number(result?.statusCode ?? 200);
  return Number.isFinite(statusCode) && statusCode < 400;
}

export async function lambdaHandler(event) {
  const records = Array.isArray(event?.Records) ? event.Records : [];
  if (records.length === 0) return imageProviderWorkerHandler(event);

  const delegated = await processRevisionedApprovalRecords(records);
  if (delegated.length === 0) {
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Revisioned approval persistence processed' }),
    };
  }

  // Guard visibility writes before the persistence worker runs. This prevents a
  // title-derived HEX shared by multiple occurrences from mutating all of them.
  const visibilityGuards = [];
  for (const record of delegated) {
    const message = parseRecord(record);
    const guard = await prepareVisibilityPersistGuard(message);
    if (guard) visibilityGuards.push(guard);
  }

  const result = await imageProviderWorkerHandler({ ...event, Records: delegated });
  if (successfulResult(result)) {
    for (const guard of visibilityGuards) {
      await verifyVisibilityPersistGuard(guard);
    }
  }
  await normalizeLegacyApprovalCards(delegated);
  return result;
}
