# Issue #174 S3 post-cutover attribution samples

These read-only measurements compare bucket-wide S3 request metrics with
`scouts` Lambda invocations and low-cardinality SDK logs. They are interim
observations from 2026-11-04, not the aligned seven-day acceptance window.

## Exact seven-day pre-cutover baseline

The read-only collector verified account `553490163883` and queried 2026-10-27
19:42–2026-11-03 19:42 UTC, the exact seven days immediately before the
production cutover. All six CloudWatch series returned `Complete` in one page;
the SDK-operation and per-refresh log searches were untruncated. Across 721
populated minute bins, `CodexRequestCostAudit` recorded 95,288 GET, 14,782
HEAD, 716 LIST, and 1,250 PUT requests (112,036 total). `scouts` had 336
invocations and zero errors. The collector found two SDK-operation and three
per-refresh aggregate log entries.

## Partial post-cutover sample (17:24 UTC)

The collector queried 2026-11-03 19:42–2026-11-04 17:24 UTC. All six metric
series returned `Complete` in one page, and both log searches were untruncated.
Across 88 populated minute bins, the bucket-wide metrics recorded 1,675 GET,
789 HEAD, 106 LIST, and 509 PUT requests (3,079 total). `scouts` had 16
invocations and zero errors. Each log search returned six aggregate entries.
The latest populated S3 request bin was 16:36 UTC, so the newest activity may
not yet be reflected in the metric totals.

This partial interval is shorter than a full day and is not directly comparable
to the seven-day baseline. It cannot establish savings. Continue collection
through 2026-11-10 19:42 UTC for the matching seven-day post-cutover interval.

## Earlier partial post-cutover sample (14:05 UTC)

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

## One-hour sample (16:32 UTC)

The read-only collector verified account `553490163883` and queried
2026-11-04 15:32–16:32 UTC. All six CloudWatch metric series returned
`Complete`; the SDK-operation and per-refresh searches were untruncated and
returned no aggregate entries. The only observed S3 request metric was 24 GET
requests across two populated minute bins, at 16:20 and 16:21 UTC. No later
request bins were visible at collection time; the latest observed GET bin was
11 minutes before the query ended. This single sample does not establish a
general delivery-latency bound or identify the caller.

## Extended post-cutover sample (16:39 UTC)

The collector queried the full post-cutover interval, 2026-11-03 19:42 UTC
through 2026-11-04 16:37 UTC. All six CloudWatch metric series returned
`Complete` in one page. The SDK-operation and per-refresh log searches were
not truncated. The metrics showed 16 `scouts` Lambda invocations and zero
errors. Six aggregate SDK summaries were returned: four tagged
`scheduled-refresh` and two `non-scheduled`.

The four scheduled summaries each recorded 177–178 GET, 38 HEAD, 1–3 PUT,
and 2 LIST SDK calls. Their totals matched the corresponding S3 metric counts
across adjacent minute bins for the 19:44, 00:20, 06:20 and 12:20 UTC runs.
At 12:20 UTC, the summary attributed 168 GET calls to canonical-event reads,
six GET calls to calendar-cache reads, and 36 HEAD calls to event-image
checks. Per-refresh summaries recorded 98–101 reused HEX reads and 35–36
image HEAD requests with six or seven cache hits. These are observed avoided
SDK calls within those invocations, not a bill reduction estimate.

The two `non-scheduled` summaries recorded 167 and 170 GET calls. The
CloudWatch S3 bins around those summaries include additional requests beyond
the logged call totals, so they do not support attributing every request to
the corresponding invocation. After the 14:03 UTC endpoint of the earlier
sample, nine additional S3 metric bins appeared: 74 GET, zero HEAD, 14 LIST,
and 76 PUT requests. No `scouts` Lambda invocation or SDK aggregate log was
present in those later bins. In particular, the 16:35 and 16:36 bins contain
14 LIST and 76 PUT requests combined and were only about three minutes old at
collection time. Their caller is unknown; metric delay and other bucket
callers remain possible.

This readback strengthens per-run SDK attribution for the scheduled refreshes
and confirms the logged HEX-read reuse and image-HEAD cache hits. It still
does not identify all bucket callers, establish request-metric delivery
latency, or replace the aligned seven-day comparison.

## Illustrative monthly value of per-run reuse

Across the four scheduled summaries, the per-refresh counter reported 98, 99,
99 and 99 reused HEX reads, plus six image HEAD cache hits in each run. If
four runs/day continue for 30 days, that projects to about 11,850 avoided HEX
GET calls and 720 avoided image HEAD calls per month. Applying the October
effective Tier-2 rate recorded in the rollout notes ($0.20060 / 477,611
requests, about $0.00042 per 1,000 requests) gives an illustrative total of
about **$0.0053/month** if each avoided SDK call maps to one billable request.

This is a sub-cent projection from four observed scheduled runs, not a
measured bill reduction. It excludes other S3 request changes and must not be
used as evidence of a month-over-month saving; compare the complete aligned
seven-day request window and posted charges before making that claim.

The rollout's Cost Explorer attribution recorded **$0.20363** in October for
the `CodexRequestCostAudit` CloudWatch S3 request metrics. That historical
charge is about 38 times this illustrative monthly request saving. It is an
audit cost, not a permanent application cost; retain the metrics only long
enough to complete the aligned seven-day comparison, then remove the temporary
configuration if the data is no longer needed and verify the resulting bill
change. The two figures are not a net monthly comparison because one is an
October posted charge and the other is a four-run projection.

## Limits

Bucket metrics include browser/admin and other S3 callers. The observations do
not attribute every request, establish a full-day or seven-day comparison, or
prove savings or bill reduction. Keep the aligned seven-day collection as the
acceptance gate.
