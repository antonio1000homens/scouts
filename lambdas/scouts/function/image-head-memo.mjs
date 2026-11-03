/**
 * Deduplicate S3 image HEAD checks within one calendar refresh invocation.
 * A subsequent invocation always rechecks: objects may have been deleted or
 * restored. A resolved false (404) is safe to reuse only within this run.
 *
 * Failed checks are evicted; do not mistake transient AWS errors for missing
 * images. The aggregate counters are bounded and contain no S3 object keys.
 */
export function createImageHeadMemo() {
  const checks = new Map();
  let cacheHits = 0;
  let requests = 0;
  function imageHead(bucket, key, check) {
    const cacheKey = JSON.stringify([bucket, key]);
    if (checks.has(cacheKey)) {
      cacheHits += 1;
      return checks.get(cacheKey);
    }
    requests += 1;
    const pending = Promise.resolve()
      .then(check)
      .catch((error) => {
        checks.delete(cacheKey);
        throw error;
      });
    checks.set(cacheKey, pending);
    return pending;
  }
  imageHead.stats = () => ({ requests, cacheHits });
  return imageHead;
}
