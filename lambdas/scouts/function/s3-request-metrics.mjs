import { AsyncLocalStorage } from 'node:async_hooks';

const requestContext = new AsyncLocalStorage();

/** Group S3 SDK calls made across the Scouts handler and its helper modules. */
export async function runWithS3RequestMetrics(source, callback) {
  if (requestContext.getStore()) return callback();

  const context = { source: String(source || 'unknown'), operationCounts: {} };
  return requestContext.run(context, async () => {
    try {
      return await callback();
    } finally {
      if (Object.keys(context.operationCounts).length > 0) {
        console.log('[S3 Request Reduction] SDK calls by operation', {
          source: context.source,
          operationCounts: context.operationCounts,
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
  }
  return client.send(command);
}
