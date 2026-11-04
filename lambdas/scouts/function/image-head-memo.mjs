const MAX_POSITIVE_CACHE_ENTRIES = 512;

/**
 * Deduplicate S3 image HEAD checks within an invocation and optionally reuse
 * recent positive checks from a bounded warm-instance cache. Only object
 * existence is cached across invocations; missing objects are rechecked on
 * every later invocation. Failed checks are evicted rather than treated as
 * evidence of a missing image.
 */
export function createImageHeadMemo({
  positiveCache = null,
  positiveCacheTtlMs = 0,
  now = Date.now,
} = {}) {
  const checks = new Map();
  let cacheHits = 0;
  let requests = 0;
  function imageHead(bucket, key, check) {
    const cacheKey = JSON.stringify([bucket, key]);
    if (checks.has(cacheKey)) {
      cacheHits += 1;
      return checks.get(cacheKey);
    }

    if (positiveCache && positiveCacheTtlMs > 0) {
      const cached = positiveCache.get(cacheKey);
      const ageMs = cached ? now() - cached.checkedAt : Number.POSITIVE_INFINITY;
      if (cached && ageMs >= 0 && ageMs < positiveCacheTtlMs && cached.exists === true) {
        // Touch insertion order for bounded LRU eviction without extending the
        // verification deadline.
        positiveCache.delete(cacheKey);
        positiveCache.set(cacheKey, cached);
        cacheHits += 1;
        const resolved = Promise.resolve(true);
        checks.set(cacheKey, resolved);
        return resolved;
      }
      if (cached) positiveCache.delete(cacheKey);
    }

    requests += 1;
    const pending = Promise.resolve()
      .then(check)
      .then((exists) => {
        if (positiveCache) {
          positiveCache.delete(cacheKey);
          if (exists === true && positiveCacheTtlMs > 0) {
            positiveCache.set(cacheKey, { checkedAt: now(), exists: true });
            while (positiveCache.size > MAX_POSITIVE_CACHE_ENTRIES) {
              positiveCache.delete(positiveCache.keys().next().value);
            }
          }
        }
        return exists;
      })
      .catch((error) => {
        checks.delete(cacheKey);
        positiveCache?.delete(cacheKey);
        throw error;
      });
    checks.set(cacheKey, pending);
    return pending;
  }
  imageHead.stats = () => ({ requests, cacheHits });
  return imageHead;
}
