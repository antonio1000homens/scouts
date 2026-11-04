import { AsyncLocalStorage } from 'node:async_hooks';

const requestContext = new AsyncLocalStorage();
const DATA_BUCKET = String(process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883').trim();
const OPERATION_CATEGORIES = new Set([
  'agenda',
  'canonical-event',
  'calendar-cache',
  'event-image',
  'runtime',
  'other',
]);

export function s3ObjectCategory(key) {
  const value = typeof key === 'string' ? key : '';
  if (/(^|\/)agenda\.json$/i.test(value)) return 'agenda';
  if (value.startsWith('events/')) return 'canonical-event';
  if (value.startsWith('website/eventImages/')) return 'event-image';
  if (/\.ics$/i.test(value) || value.startsWith('calendar/')) return 'calendar-cache';
  if (value.startsWith('runtime/')) return 'runtime';
  return 'other';
}

function bucketClass(command) {
  const bucket = String(command?.input?.Bucket || '').trim();
  if (!bucket) return 'unknown';
  return bucket === DATA_BUCKET ? 'data' : 'other';
}

/** Group S3 SDK calls made across the Scouts handler and its helper modules. */
export async function runWithS3RequestMetrics(source, callback) {
  if (requestContext.getStore()) return callback();

  const context = {
    source: String(source || 'unknown'),
    operationCounts: {},
    bucketOperationCounts: {},
    categoryOperationCounts: {},
  };
  return requestContext.run(context, async () => {
    try {
      return await callback();
    } finally {
      if (Object.keys(context.operationCounts).length > 0) {
        console.log('[S3 Request Reduction] SDK calls by operation', {
          source: context.source,
          operationCounts: context.operationCounts,
          bucketOperationCounts: context.bucketOperationCounts,
          categoryOperationCounts: context.categoryOperationCounts,
        });
      }
    }
  });
}

export async function sendS3Command(client, command, category = 'other') {
  const context = requestContext.getStore();
  if (context) {
    const operation = command?.constructor?.name?.replace(/Command$/, '') || 'Unknown';
    context.operationCounts[operation] = (context.operationCounts[operation] || 0) + 1;
    const role = bucketClass(command);
    const roleCounts = context.bucketOperationCounts[role] || (context.bucketOperationCounts[role] = {});
    roleCounts[operation] = (roleCounts[operation] || 0) + 1;
    const safeCategory = OPERATION_CATEGORIES.has(category) ? category : 'other';
    const categoryCounts = context.categoryOperationCounts[safeCategory]
      || (context.categoryOperationCounts[safeCategory] = {});
    categoryCounts[operation] = (categoryCounts[operation] || 0) + 1;
  }
  return client.send(command);
}
