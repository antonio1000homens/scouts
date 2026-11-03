import { AsyncLocalStorage } from 'node:async_hooks';

const requestContext = new AsyncLocalStorage();
const DATA_BUCKET = String(process.env.TARGET_BUCKET || 'scouts-2ndtolworth-prod-553490163883').trim();

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
        });
      }
    }
  });
}

export async function sendS3Command(client, command) {
  const context = requestContext.getStore();
  if (context) {
    const operation = command?.constructor?.name?.replace(/Command$/, '') || 'Unknown';
    context.operationCounts[operation] = (context.operationCounts[operation] || 0) + 1;
    const role = bucketClass(command);
    const roleCounts = context.bucketOperationCounts[role] || (context.bucketOperationCounts[role] = {});
    roleCounts[operation] = (roleCounts[operation] || 0) + 1;
  }
  return client.send(command);
}
