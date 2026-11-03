/**
 * Deduplicate S3 image HEAD checks within one calendar refresh invocation.
 * This cache is intentionally not shared across invocations: a previously
 * present object may have been deleted, and later refreshes must detect it.
 *
 * Rejected checks are evicted so transient AWS errors can be retried. A 404
 * should be represented by `false` by the caller and can be cached for the
 * remainder of this invocation.
 */
export function createImageHeadMemo() {
  const checks = new Map();
  return function imageHead(bucket, key, check) {
    const cacheKey = JSON.stringify([bucket, key]);
    if (checks.has(cacheKey)) return checks.get(cacheKey);
    const pending = Promise.resolve()
      .then(check)
      .catch((error) => {
        checks.delete(cacheKey);
        throw error;
      });
    checks.set(cacheKey, pending);
    return pending;
  };
}
