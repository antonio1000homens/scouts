import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { processRevisionedApprovalRecords } from './approval-lifecycle-adapter.mjs';
import { lambdaHandler as imageProviderWorkerHandler } from './image-provider-worker.mjs';
import { normalizeLegacyApprovalCards } from './legacy-approval-card-normalizer.mjs';
import {
  buildVisibilityPersistGuard,
  extractVisibilityPersistMutation,
  text,
  verifyVisibilityPersistReadback,
} from './full-enrich-helpers.mjs';

const AWS_REGION = process.env.AWS_REGION || 'eu-west-2';
const TARGET_BUCKET = process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883';
const s3 = new S3Client({ region: AWS_REGION });

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

export { extractVisibilityPersistMutation };

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
  return buildVisibilityPersistGuard(message, agendaSnapshot, eventSnapshot);
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
  const result = verifyVisibilityPersistReadback(guard, agendaSnapshot, eventSnapshot);
  console.log('[VisibilityPersist] Read-back verified', {
    hex: guard.hex,
    isHidden: guard.isHidden,
    beforeETag: guard.beforeETag,
    afterETag: result?.eTag ?? null,
  });
  return result;
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
