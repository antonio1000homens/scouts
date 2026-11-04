# Issue #174 S3 post-cutover attribution samples

These read-only measurements compare bucket-wide S3 request metrics with
`scouts` Lambda invocations and low-cardinality SDK logs. They are interim
observations from 2026-11-04, not the aligned seven-day acceptance window.

## Partial post-cutover sample (14:05 UTC)

The collector verified account `553490163883` and queried 2026-11-03 19:42 UTC
through 2026-11-04 14:03 UTC. All six CloudWatch metric series returned
`Complete` in one page; neither the SDK-operation search nor the per-refresh
search was truncated. Across 79 populated minute bins, the bucket-wide
`CodexRequestCostAudit` metrics recorded 1,601 GET, 789 HEAD, 92 LIST, and 433
PUT requests. The `scouts` Lambda had 16 invocations and zero errors.

SDK summaries included four `scheduled-refresh` and two `non-scheduled`
invocations. Scheduled summaries recorded 176–178 GET, 38 HEAD, 1–3 PUT, and
2 LIST calls per run. Per-refresh summaries recorded 98–100 reused HEX reads
and 35–36 image HEAD calls with six cache hits. The non-scheduled summaries
recorded 167 and 170 GET calls. SDK call counts are not billable S3 wire
requests.

## Six-hour sample (15:32 UTC)

The collector verified the Scouts account and queried 2026-11-04 09:32–15:32
UTC. All six CloudWatch metric series returned `Complete` in one page, and the
SDK-operation and per-refresh searches were untruncated. Bucket-wide metrics
recorded 726 GET, 376 HEAD, 24 LIST, and 101 PUT requests across 34 populated
minute bins. The `scouts` Lambda had 7 invocations and zero errors. Each log
search returned two aggregate entries.

## Recheck (16:02 UTC)

The collector queried 2026-11-04 10:02–16:02 UTC. All six metric series were
`Complete`; both log searches were untruncated. Totals matched the 15:32
sample: 726 GET, 376 HEAD, 24 LIST, and 101 PUT across 34 populated minute
bins; the `scouts` Lambda had 7 invocations and zero errors. Populated S3
request bins ran from 10:59 through 15:18 UTC. No later populated request
datapoints were visible at collection time. Because S3 metrics may be delayed,
this does not prove there were no requests after 15:18 UTC.

The SDK log search returned one scheduled-refresh and one non-scheduled
aggregate entry. Those invocation summaries do not attribute every
bucket-wide request.

## Limits

Bucket metrics include browser/admin and other S3 callers. The observations do
not attribute every request, establish a full-day or seven-day comparison, or
prove savings or bill reduction. Keep the aligned seven-day collection as the
acceptance gate.
