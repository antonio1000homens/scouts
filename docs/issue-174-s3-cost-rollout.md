# Issue #174 — staged Scouts S3/SQS cost optimisation

The staged implementation is in [PR #175](https://github.com/antonio1000homens/scouts/pull/175),
[PR #176](https://github.com/antonio1000homens/scouts/pull/176), and
[PR #177](https://github.com/antonio1000homens/scouts/pull/177). This document
tracks the rollout and outstanding acceptance evidence; the merged PRs do not
by themselves prove issue closure.

## Read-only baseline (from issue #174, 2026-11-03)

Account **553490163883**, region **eu-west-2**. Reverify using
`aws sts get-caller-identity` before collecting follow-up measurements,
running the Scouts deployment, or changing a production resource.

- October S3: **$0.34493** including about **477,611 Tier-2 requests**
  ($0.20060), **7,961 Tier-1 requests** ($0.04219) and storage ($0.10197).
- Recent full days: about **13,600 GET**, **2,112 HEAD**, **96 LIST**,
  **146 PUT** daily in the website bucket. The correlation of these totals
  to scheduled execution is **not proven**; CDN/browser/S3 callers may contribute.
- EventBridge scheduled refreshes: **48/day** (`rate(30 minutes)`).
- Scouts SQS: about **25,914 empty receives/day** across three Lambda
  event-source mappings; **no SQS charges** in the recorded baseline.
  Idle receives are Lambda-managed, not a custom polling loop.

## Initial read-only production recheck (2026-11-03)

AWS Core `GetCallerIdentity` verified account `553490163883` before these
reads. These earlier observations are superseded for schedule and runtime
state by the supplemental check below:

- The deployed `scouts-lambda-ScoutsScheduledRefreshRule-…` remained enabled
  at `rate(30 minutes)`. The local six-hour default has not been deployed.
- The deployed `scouts` Lambda configuration matched that cadence and had
  `SCOUTS_SCHEDULED_REFRESH_MAX_EVENTS=0` (discovery-only scheduled refresh),
  `SCOUTS_SCHEDULED_REFRESH_DEFAULT_ENABLED=true`, and the activity table
  configured. Its code SHA and last-modified time were read for state
  identification; no code was updated.
- The seven daily datapoints for `CodexRequestCostAudit` totalled **95,570
  GET**, **14,793 HEAD**, **702 LIST**, and **1,180 PUT** requests. Traffic is
  confirmed; attribution to scheduled refresh is still unproven.
- `ListTrails` returned no CloudTrail trails and `GetBucketLogging` returned
  no S3 server access logging configuration. Historical bucket request metrics
  therefore do not identify callers. At this initial recheck, the pending
  follow-up code added low-cardinality S3 SDK operation counts for the complete
  Scouts invocation, with scheduled refresh separated; the later live check is
  recorded below.
- Three enabled Lambda event-source mappings remained attached to
  `scoutsRequests`, `scoutsProcessing`, and `scoutsProcessingDLQ`. Their
  `NumberOfEmptyReceives` totals were **60,468**, **60,467**, and **60,468**
  across those seven datapoints; `NumberOfMessagesReceived` was zero for each.
  All five Scouts queues currently had zero visible, in-flight, and delayed
  messages. No queue or mapping was changed.
- All three DynamoDB tables remained `PAY_PER_REQUEST`. Four days of
  one-minute CloudWatch data showed **927.5 consumed read units** in the
  largest minute for `scouts-enrichment-state` (2026-11-01 23:06 UTC), with
  no `ReadThrottleEvents` datapoints. This is a one-minute sum, not a
  per-second peak or a safe provisioned-capacity recommendation. The activity
  table and GSI contained zero items and the bounded activity query returned
  zero rows.
- Bounded S3 reads found `scoutsQueued.json` at 184 bytes, updated
  2026-11-03 17:34 UTC, with zero requests; `scoutsProcessing.json` was 680
  bytes with one processing request, last updated 2026-09-08; and
  `scoutsComplete.json` was 1,762 bytes with one completed request, last
  updated 2026-09-08. The old processing/completed request objects include
  `taskToken`, which is absent from the activity ledger. `ListExecutions`
  returned no running executions for the three Scouts enrichment state
  machines at sample time.
- A single bounded first page of the enrichment-state table returned 16 rows
  (13 succeeded and 3 manual-review) at **132.5 consumed capacity units** and
  indicated more rows. The scan stopped there; it is not a full manual-review
  inventory. Avoid a full-table scan for parity without a measured read plan.

These reads show the old S3 objects contain historical state the empty
activity ledger cannot reproduce. Keep the private admin snapshot API enabled
until task-token dependencies, historical coverage, and manual-review
compatibility have a verified migration contract. The calendar-refresh
diagnostic reads are separately removed in source because they do not drive
request processing; the old objects and admin viewer are retained.

## Read-only snapshot replacement recheck (2026-11-03 19:26 UTC)

AWS Core verified the Scouts account before this read-only sample. The queued
snapshot remained empty (184 bytes, updated 18:04 UTC); the processing
snapshot still contained one September `processing` row (680 bytes), and the
completed snapshot one September `completed` row (1,762 bytes). The records
exposed the legacy field set, including `taskToken`; one completed record had
a nonempty token. The `scouts-request-activity/activity-feed` query returned
zero rows. Five Scouts SQS queues each reported zero visible, in-flight and
delayed messages, and all three Scouts enrichment state machines reported no
running executions. Queue counts are approximate; this is a point-in-time
sample and does not establish historical parity or manual-review compatibility.

The processing/completed snapshot records are therefore stale relative to all
three live sources sampled. The agenda refresh previously read and pruned these
snapshots for a diagnostic summary; that path did not determine SQS publication
eligibility or active Step Functions state. PR #179 removed those refresh-path
reads and the queued-snapshot write. The private `subject=snapshot` admin API
remains feature-gated and the old objects remain untouched for manual review
and rollback. The production rollout is recorded below.

## Snapshot refresh-read cutover verification (2026-11-03 19:29–19:33 UTC)

PR #179 merged as `517ae801`. Deployment workflow `41703666341` completed
successfully; CloudFormation `scouts-lambda` reached `UPDATE_COMPLETE` at
19:30:15 UTC and the `scouts` Lambda was `Active` with
`LastUpdateStatus=Successful` at 19:30:20 UTC. The six-hour schedule and
zero-event publication cap remain unchanged. `LegacyRuntimeSnapshotsEnabled`
is still `true`, preserving the admin viewer.

A controlled scheduled-refresh invocation returned Lambda and HTTP status
200, read 56 events, modified zero events, and reported
`runtimeQueueSnapshots.source=retired`. Its 19:32:09 UTC aggregate SDK log
recorded 177 `GetObject`, 38 `HeadObject`, 2 `ListObjectsV2`, and 1
`PutObject`. The prior comparable controlled sample recorded 180 GETs with
the same other operation counts. The three-request GET reduction matches the
three removed snapshot reads for this one refresh; this is measured SDK-call
reduction, not yet a full-day or bill-level comparison. S3 bucket metrics for
the 19:32 minute became available by 19:35 UTC: 145 GET, 27 HEAD, 1 LIST and
1 PUT, alongside one Lambda invocation and zero Lambda errors. These bucket
counts do not match the 177/38/2/1 aggregate SDK counts. The request-metrics
configuration covers the whole bucket with no prefix filter, while the Lambda
counter aggregates calls without bucket or response-status dimensions; the
discrepancy remains unexplained, so this is not yet bucket-level attribution
for the controlled run.

## Bucket-role attribution deployment (2026-11-03 19:41–19:45 UTC)

PR #181 deployed the low-cardinality bucket-role breakdown. The Lambda update
completed at 19:42:59 UTC. A controlled refresh returned status 200 with 56
events, zero modifications and zero enrichment requests. Its aggregate log
at 19:44:29 UTC recorded 177 GET, 38 HEAD, 2 LIST and 1 PUT, and classified
all of them as `data`; there were no `other` or `unknown` calls. The S3
`CodexRequestCostAudit` configuration has no prefix filter. The 19:45 UTC
query had no S3 points; by 19:47 UTC, the 19:44 bucket metric showed 82 GET,
17 HEAD, 1 LIST and no PUT. This still does not reconcile to the 177/38/2/1
SDK totals. AWS describes S3 request metrics as best-effort, with completeness
and timeliness not guaranteed and not intended as complete request accounting
([AWS documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/cloudwatch-monitoring.html)).
Keep the operation log as the invocation-level evidence and bucket metrics as
an approximate trend; the present samples cannot establish bill-level savings.

After the invocation, `HeadObject` readbacks showed the queued, processing and
completed snapshot sizes and `LastModified` timestamps unchanged from the
19:26 UTC sample. No snapshot object was written or deleted. The activity
ledger remains empty and the stale historical snapshots remain available via
the admin API. Historical/manual-review parity is not established.

## Preliminary Cost Explorer check (2026-11-03 19:51 UTC)

AWS STS verified account `553490163883` before the Cost Explorer query. The
query marks every returned day as estimated. On Nov 1 and Nov 2, before the
six-hour schedule deployment on Nov 3, S3 request usage was 16,092 and 16,028
requests respectively (Tier 1 + Tier 2), at estimated request charges of
about $0.00843 and $0.00791 per day. Total S3 service estimates were $0.00857
and $0.00805 per day, including non-request usage. The Nov 3 estimate was
still partial: 9,996 S3 requests and $0.00509 total S3 service cost at query
time. These preliminary totals are not a post-change daily comparison and
must not be extrapolated as savings.

SQS usage was 27,542 and 27,540 requests on Nov 1 and Nov 2, with estimated
SQS cost of $0 on both days; the partial Nov 3 estimate showed 17,224 requests
and $0. This is total SQS request usage, not a ReceiveMessage-only count. It
supports retaining the existing mappings while SQS remains free in this
estimate, but it does not replace the CloudWatch empty-receive evidence or
prove that the configured free allocation will always cover future traffic.

At 19:56 UTC, a read-only queue recheck verified all five Scouts queue
attributes directly. Visible, in-flight and delayed counts were zero on every
queue; configured message retention was 14 days. CloudWatch's latest hourly
point (18:56 UTC) also showed zero oldest-message age. In the preceding
24-hour query, each of the three enabled Lambda event-source mappings
(`scoutsRequests`, `scoutsProcessing` and `scoutsProcessingDLQ`) recorded
8,638 empty receives and zero messages received. All three mappings remain
enabled. The two DLQs (`scoutsRequestsDLQ` and `scoutsProcessingDLQ`) were
empty. The primary queues retain their configured redrive thresholds of five
receives (`scoutsRequests`) and three receives (`scoutsProcessing`). This is
a quiet-window readback; it does not exercise message delivery, retries,
redrive or manual recovery.

## Supplemental live recheck (2026-11-03 18:36 UTC)

AWS Core again verified account `553490163883` before read-only calls. The
production state changed after the initial recheck:

- `scouts-lambda` reached `UPDATE_COMPLETE` at 18:19:40 UTC. Its scheduled
  rule is enabled at `rate(6 hours)`, and the `scouts` Lambda last-modified
  time is 18:19:51 UTC. `SCOUTS_SCHEDULED_REFRESH_MAX_EVENTS=0` remains in
  effect. The local CLI SSO profile was expired, so this check used the
  connected AWS Core account and verified identity first.
- A refresh log at 18:20:34 UTC reported
  `reusedHexReads=98`, `imageHead.requests=36`, and `imageHead.cacheHits=6`.
  This is per-invocation avoided-request telemetry from the deployed refresh
  path, not a full before/after billing comparison.
- The `CodexRequestCostAudit` S3 datapoint for the 18:15 15-minute interval
  was 180 GET, 38 HEAD, 2 LIST and 1 PUT. One-minute metrics placed 72 GET /
  21 HEAD in 18:20 and 108 GET / 17 HEAD plus 2 LIST / 1 PUT in 18:21. The
  Lambda metric showed one `scouts` invocation at 18:20 and no error; its log
  shows a 7.8-second run from 18:20:26 to 18:20:34. The 18:21 bucket counts
  are not explained by that observed invocation unless metric publication
  latency shifts their timestamps. Bucket metrics do not identify callers,
  so this is correlation, not full request attribution or a clean before/after
  window.
- A second minute-level query through 18:44 UTC found S3 GETs at 18:39 (1),
  18:40 (4), and 18:41 (1), while the `scouts` Lambda had no invocation
  datapoints from 18:22 through 18:44. This confirms bucket GET traffic exists
  outside the scheduled Scouts invocation window (or has delayed metric
  timestamps); its specific caller remains unknown. Keep CloudFront/browser
  and other AWS callers separate from Lambda SDK counts.
- No `[S3 Request Reduction] SDK calls by operation` log appeared between
  18:15 and 18:36 UTC. That per-invocation operation counter exists in this
  follow-up PR but is not deployed yet.
- `SCOUTS_LEGACY_RUNTIME_SNAPSHOTS` and the deferred-outbox environment
  variables are unset on the live Lambda. The deployed code defaults legacy
  reads to enabled and deferred writes to disabled. The queued snapshot was
  still 184 bytes with zero requests, last modified at 18:04 UTC; processing
  and completed snapshots remained at 680/1,762 bytes from 2026-09-08 and each
  still contained a `taskToken` field. No S3 objects were changed by this
  recheck.
- All three existing DynamoDB tables remain `PAY_PER_REQUEST`, with TTL
  enabled on `expiresAt`; the request-activity table still has zero items and
  a bounded `activity-feed` query returned zero rows at 0.5 read capacity
  units. `scouts-deferred-refresh` is not present, so the outbox remains off.
- Because legacy snapshot objects remain needed and the activity ledger is
  empty, production parity and safe legacy-read retirement are still unproven.

## Post-follow-up deployment check (2026-11-03 19:06–19:17 UTC)

AWS Core verified account `553490163883` before these calls. PR #176's first
master deployment was cancelled after the Scouts function step completed and
before the Slack handler step. After PR #177 merged, the full deployment run
`41699914320` completed successfully.

- CloudFormation `scouts-lambda` reached `UPDATE_COMPLETE` at 19:06:17 UTC;
  the `scouts` Lambda was `Active`, with `LastUpdateStatus=Successful` and
  `LastModified=19:06:22 UTC`. The stack remains at `rate(6 hours)` with
  `ScheduledRefreshMaxEvents=0`. `LegacyRuntimeSnapshotsEnabled=true` and
  `DeferredRefreshOutboxEnabled=false`; the deferred table is not created.
- One controlled scheduled-refresh invocation at 19:08:51 UTC returned HTTP
  200 with no Lambda `FunctionError`. It read 56 events, reported zero
  modified events and zero enrichment requests started, and reported five
  expired hidden-event cleanup records. It exercised the deployed S3 wrapper.
  The response still identified `runtimeQueueSnapshots.source=legacy-s3`, so
  the compatibility path is active and snapshot parity is not established.
- Its aggregate logs reported `reusedHexReads=98`,
  `imageHead.requests=36`, `imageHead.cacheHits=6`, and SDK calls by operation:
  180 `GetObject`, 38 `HeadObject`, 2 `ListObjectsV2`, and 1 `PutObject`, tagged
  `source=scheduled-refresh`. This attributes those logical SDK calls to one
  scheduled-refresh execution; SDK retries and other bucket callers remain
  outside that count.
- One-minute CloudWatch metrics showed one `scouts` invocation and zero Lambda
  errors at 19:08. S3 request metrics reported 20 `GetRequests` in that minute
  and 160 `GetRequests`, 38 `HeadRequests`, 2 `ListRequests`, and 1 `PutRequests`
  in the 19:09 minute. The combined two-minute totals exactly match the
  invocation's 180/38/2/1 SDK counts. This is direct attribution for that
  single scheduled run, with S3 metrics reporting most of its requests in the
  following minute; it does not attribute the rest of the bucket's traffic or
  establish a full-day savings trend.
- No SQS mappings or DynamoDB billing modes were changed. A single controlled
  invocation does not establish a full-day post-change trend, queue capacity,
  or snapshot/activity parity.

## Cache behavior review (2026-11-03)

The live CloudFront distribution uses `Managed-CachingOptimized` for its
default behavior (minimum TTL 1 second) and `Managed-CachingDisabled` (all TTLs
zero) for `/agenda.json`, `/runtime/*`, and `/events/*`. S3 metadata for
`agenda.json` is `no-store`; `index.html` and `website/styles.css` are
`max-age=0, no-cache, no-store, must-revalidate`; the queued runtime object is
also `no-store`. The event loader requests data with `cache: 'no-store'`.
These paths retain freshness. At the time of this review, no cache-header
changes were made: shared HTML, CSS, and JavaScript names are not
content-versioned. Public image routing and the live image-key cache behavior
were assessed separately below.

## Public event-image CDN routing assessment (2026-11-03)

The public event loader previously converted canonical
`website/eventImages/*` paths directly to the S3 REST hostname, bypassing the
existing CloudFront distribution. The public loader and admin viewer now
resolve relative paths and legacy URLs from the exact Scouts S3 bucket host to
the current page origin, which is Cloudflare in front of CloudFront in
production. Other absolute image URLs remain unchanged. Agenda JSON continues
to use `cache: 'no-store'`, including its direct S3 fallback; no runtime or
private path is redirected.

Before the source change, the verified CloudFront distribution was enabled
with alias `2ndtolworth.org.uk`, the S3 website endpoint as origin, and
`Managed-CachingOptimized` as its default behavior (MinTTL 1 second,
DefaultTTL 86,400 seconds, MaxTTL 31,536,000 seconds). `/agenda.json`,
`/runtime/*`, and `/events/*` retain the caching-disabled policy. A bounded
production request to a public `website/eventImages/*` object returned HTTP
200 from the CloudFront distribution domain; a first request was `Miss from
cloudfront`, and an immediate repeat was `Hit from cloudfront`. The public
alias `2ndtolworth.org.uk` also returned HTTP 200 through Cloudflare and
CloudFront; the first viewer request was a Cloudflare cache miss and the repeat
was a Cloudflare cache hit. The sampled old image had no S3 `Cache-Control`
metadata, so its CloudFront freshness used the configured 24-hour default TTL.
Generated images are stored with a one-year `Cache-Control` header and
timestamped keys; manual image edits to an overwritten object can remain stale
at CloudFront for up to the applicable TTL.

Seven daily CloudFront datapoints from Oct 27 21:45 to Nov 3 21:45 totaled
4,512 requests and 9,037,605 downloaded bytes (8.62 MiB). The same S3 request
metrics filter recorded 145,649,289 downloaded bytes (138.90 MiB) during that
window, across all bucket callers and prefixes. The latest 24-hour bucket
sample had 12,681 GETs. These totals do not identify which S3 reads are browser
image requests. AWS currently documents a CloudFront Free Tier allowance of
10 million HTTP/HTTPS requests and 1 TB transfer per month across the account
([CloudFront pricing FAQ](https://aws.amazon.com/cloudfront/faqs/)). The
observed request and byte volumes are well below those allowances, including
an upper-bound estimate that routes all currently measured bucket downloads
through CloudFront. S3 GET request rates are listed at $0.0004 per 1,000 for
S3 Standard in AWS pricing examples; even eliminating every GET in the latest
daily sample would save at most about $0.15/month at that rate, and only the
repeated browser image portion is affected. Treat savings as conditional, and
recheck request metrics and Cost Explorer after deployment; do not claim
bucket-wide attribution or a guaranteed bill reduction from this routing
change.

## Event-image CDN deployment readback (2026-11-03 21:48–21:51 UTC)

PR #194 merged as `20be92efe0bbe1308911c922a284cea84b02984c`. Master workflow
[`41725139862`](https://github.com/antonio1000homens/scouts/actions/runs/41725139862)
completed successfully: plan-and-test passed, `deploy-web` uploaded the site
and completed its cache-invalidation step, and `deploy-aws` was skipped. The
SHA-256 of the deployed `/website/scripts/event-loader.js` fetched through the
public hostname exactly matched the source file in the merged commit
(`242259b9c6080e83d6b170572fa3d676c9ebbb5210607be96b0109116209753e`). This
confirms the browser loader change is live.

After rollout, a request to the public hostname for a canonical
`website/eventImages/*` object returned HTTP 200 through Cloudflare and
CloudFront, with `cf-cache-status: HIT`. This verifies delivery and a cached
viewer response for that object; it does not measure how many production
browser reads now avoid S3. The pre-change seven-day request and byte samples
remain the baseline. Collect a mature post-deployment daily and seven-day S3
request trend and posted S3/CloudFront charges before quantifying savings.

## Admin event-image CDN deployment readback (2026-11-03 22:00–22:16 UTC)

PR #196 merged as `31f1b0a7d2a77fcc3dbff7859bfc932995d2f218`. Master workflow
[`41726938753`](https://github.com/antonio1000homens/scouts/actions/runs/41726938753)
completed successfully: plan-and-test passed, `deploy-web` uploaded the site
and completed its CloudFront invalidation, and `deploy-aws` was skipped. This
change routes legacy absolute event-image URLs from the exact Scouts S3
hostname through the admin page origin, while preserving unrelated absolute
URLs and relative paths.

The deployed S3 object `website/admin/admin-script.js` and the source file
have the same SHA-256:
`8b8719f4077825478cb22932c1fa550761ead0689f4b94c34d9dac9569f68430`. A
request to the underlying CloudFront distribution URL returned HTTP 200 and
the same hash, with the source object's `no-store` cache policy. The public
hostname redirected an unauthenticated request to Cloudflare Access, so this
readback proves the deployed static asset is available from CloudFront but does
not exercise the rewrite inside an authenticated admin session. It also does
not measure a change in bucket-wide S3 requests or charges.

## Merged implementation

1. **Four refreshes/day**: CloudFormation and runtime defaults move to
   `rate(6 hours)`. The live stack now reports this cadence (see supplemental
   recheck). The deploy script **explicitly passes** the cadence so
   preexisting CloudFormation stacks do not silently retain
   `rate(30 minutes)`. Admin **Run refresh now** and independently
   invoked workflows remain available. Existing 24-hour ICS freshness
   behaviour is unchanged. The cadence is live in the stack. The follow-up
   refresh optimizations and operation counters were deployed in the later
   rollout recorded above.
2. **Retire refresh-path snapshot reads**: the start/finally paths previously
   read queued, processing, completed and wrote queued (up to six GET + two
   PUT per normal execution). The dead append/touch writers, snapshot-derived
   active-processing index, and refresh-path snapshot reads/pruning are now
   removed in source. The private `subject=snapshot` admin API remains behind
   `LEGACY_RUNTIME_SNAPSHOTS_ENABLED`, defaulting to true until historical and
   manual-review compatibility is accepted. Setting it false returns HTTP 410
   from that API; setting it true restores the viewer. No snapshot objects are
   deleted. Active Step Functions executions remain authoritative; stage
   labels are enriched from at most 100 active DynamoDB activity rows.
3. **Add on-demand live queue status**: Operations can request approximate
   visible, in-flight and delayed counts from SQS `GetQueueAttributes`, plus
   oldest-message age from the `AWS/SQS` CloudWatch metric. Age can be absent
   when CloudWatch has no datapoint. The status read does not sample, receive,
   or change messages. Existing explicit DLQ inspect/redrive behavior remains
   separate.
4. **Deduplicate per-invocation image HEAD checks** across agenda and
   canonical HEX verification. Failed checks are never cached; 404 means
   missing, while permission/throttle/service failures now propagate
   rather than deleting potentially valid image URLs. A future refresh
   still checks every referenced image, preserving deleted-image recovery.
5. **Reuse canonical HEX JSON within the same refresh**: orphan cleanup's
   successful reads are reused by the subsequent HEX verification pass,
   with a **500-entry upper bound** and invalidation on deletion.
   The image verifier is create-only and canonical event objects are not
   removed or replaced by DynamoDB.
6. Emit **one aggregate log per refresh** for `reusedHexReads`,
   `imageHead.requests` and `imageHead.cacheHits`. No custom
   CloudWatch metrics, high-cardinality object-key logging, or new
   paid monitoring were added.
7. Emit low-cardinality per-invocation S3 SDK call counts by operation, with
   scheduled refresh tagged separately from other invocations. This gives
   direct code-path attribution without logging object keys. One live sample
   is recorded above. Counts represent SDK `send()` calls; SDK-internal
   retries may cause more wire requests, so correlate them with bucket
   metrics over longer windows. PR #181 adds fixed `data`, `other`, and
   `unknown` bucket-role counts without logging bucket names or object keys.
   One post-deploy sample classified all calls as `data`; reconcile that
   sample with delayed S3 bucket metrics before relying on it for billing.
8. Implement an opt-in DynamoDB outbox for excess scheduled enrichment work.
   Work keys include HEX, stage and generation; writes coalesce source feed
   identifiers; the dispatcher claims leases and sends at most 10 items each
   15-minute invocation through the existing `scoutsRequests` queue. Failed
   work retries with bounded backoff and becomes visible as `needs_attention`
   or `expired`. The table defaults to on-demand capacity and is retained; the
   feature flag defaults off, while Operations exposes bounded read-only
   queue-age/status samples.
   See [`issue-174-deferred-refresh-design.md`](issue-174-deferred-refresh-design.md).
   The stack supports opt-in provisioned throughput for the outbox table and
   GSI, with each capacity parameter capped at 10; the outbox alone is
   therefore limited to 20 RCUs and 20 WCUs across both resources. The mode
   still defaults to PAY_PER_REQUEST, and all runtime permissions/schedules
   plus table creation are conditioned on the outbox flag. A normal stack
   deployment leaves the table uncreated. Benchmarking and the shared #172
   capacity/eligibility review are still required before enabling the table
   or selecting provisioned capacity. The deployment workflow reads these
   settings from `DEFERRED_REFRESH_OUTBOX_*` repository variables; changes to
   those variables affect subsequent Scouts deployments.
   PR #198 deployed the new parameters with the feature still disabled and
   billing mode `PAY_PER_REQUEST`; AWS readback found no outbox table and no
   change to the three existing table modes. See the detailed readback in
   [`issue-174-deferred-refresh-design.md`](issue-174-deferred-refresh-design.md).
9. **Remove a duplicate canonical read-back**: persistence already GETs the
   just-written HEX object and parses it for verification. Two enrichment
   paths now reuse that verified body for their generated-field checks instead
   of issuing a second GET. The PUT and one GET remain; this does not make the
   read conditional on an ETag or remove read-after-write integrity checking.

## Expected impact and limits

The schedule change is a **91.7% reduction in scheduled invocations**
(48 → 4/day), but post-change billing savings are still unmeasured. One
comparable controlled refresh fell from 180 to 177 logical GET calls after
the three legacy snapshot reads were removed; HEAD, LIST and PUT counts were
unchanged. These are individual SDK samples, not a daily average or a bill
comparison. The post-#181 controlled invocation logged 177 GET, 38 HEAD,
2 LIST and 1 PUT, all attributed by the SDK bucket-role counter to `data`.
The delayed bucket metric for that minute showed only 82 GET, 17 HEAD, 1 LIST
and no PUT, so the role counter does not reconcile the SDK-to-bucket gap. It
establishes the SDK client's configured bucket role for its calls, not a
complete count of billable S3 requests. Continue collecting full-day and
seven-day windows and compare them with posted usage before claiming savings.
The earlier touch-path removals and aggregate logs also quantify HEX read
reuse and duplicate image HEAD checks per run.

For cost scale, October's observed Tier-2 charge implies an effective rate of
about **$0.000420 per 1,000 GET/HEAD requests**. An earlier conditional
sensitivity case used rough old counts (327 GET+HEAD per run) and a single
post-phase-one bucket window (218 GET+HEAD). It estimated about
**$0.198/month** at 48 runs/day versus **$0.011/month** at 4 runs/day, a
**$0.187/month** difference if both samples were entirely scheduled traffic
and representative. Direct SDK samples counted 218 GET+HEAD before
snapshot-read retirement and 215 GET+HEAD in each of the two recorded
post-retirement controlled refreshes. The delayed bucket metrics for those
post-change minutes did not match either SDK count. Neither calculation is
measured savings; both exclude Tier-1 requests and monitoring cost.

An initial comparison can use the existing bucket request monitoring
(`CodexRequestCostAudit`) by operation and 5–15-minute intervals.
Account for the cost of that temporary monitoring and remove it once
the benchmark is complete, subject to its own approval. Distinguish
Edge/CloudFront requests and browser/admin traffic from Lambda work.

Repeatable read-only collection is available with:

```sh
AWS_PROFILE=scouts node scripts/scouts-s3-request-attribution.mjs --hours 24
```

The command verifies account `553490163883`, reads the existing S3 metrics
configuration, and returns 1-minute S3 request counts beside `scouts` Lambda
invocations/errors and the low-cardinality SDK/per-refresh summary logs. It
accepts timezone-qualified `--start`/`--end` timestamps, caps the range at
seven days, and does not create metrics, alarms, or log queries. CloudWatch S3
metrics can be delayed and remain bucket-wide. The recorded controlled samples
did not match SDK operation counts: the 19:32 sample's bucket metric was
145/27/1/1 versus SDK 177/38/2/1, and the 19:44 sample's was 82/17/1/0
versus SDK 177/38/2/1 (GET/HEAD/LIST/PUT). AWS documents these metrics as
best-effort and unsuitable for complete request accounting. Use them as
approximate trends only; full-day and seven-day post-change totals and posted
S3 charges remain unverified.

The collector partitions CloudWatch Logs searches into one-hour windows so a
busy log group cannot consume the full query's bounded page budget before the
scheduled-refresh summaries are reached. A 24-hour read-only recheck on
2026-11-03 verified the Scouts account and returned complete metric query
statuses with no S3 metric pagination. The request window was
2026-11-02 21:09:46 through 2026-11-03 21:09:46 UTC; nonzero S3 minute bins
covered 21:34 through 20:50 UTC, showing about 19 minutes of metric delay at
the query end. Bucket totals were 12,681 GET, 2,081 HEAD, 135 LIST and 360 PUT.
The same run recovered three SDK summaries and four per-refresh summaries with
neither log query truncated. The three SDK samples (GET/HEAD/LIST/PUT) were
180/38/2/1 at 19:08, then 177/38/2/1 at 19:32 and 19:44. The 19:44 sample
classified all SDK requests to the data bucket; earlier summaries predate the
bucket-role logging deployment. Each per-refresh summary recorded 98 reused
HEX reads and 36 image HEAD requests with 6 cache hits. These are individual
invocation and bucket-wide trend samples, not a clean before/after bill
comparison or proof that the scheduled refresh caused all bucket requests.

## Rollout and rollback

1. **Completed:** PRs #175–#182 are merged. PR #179 deployment run
   `41703666341` completed successfully; PR #181 subsequently deployed the
   bucket-role counter at 19:42:59 UTC. PR #182 records the resulting
   attribution evidence and metric limitations. The live stack, Lambda,
   controlled invocations and request-count readbacks are recorded above.
2. **Verified in two controlled samples:** after snapshot-read retirement,
   the SDK log showed 177 GETs versus 180 in the comparable pre-cutover
   sample, with HEAD, LIST and PUT unchanged. The post-#181 sample classified
   all SDK calls as `data`, but bucket request metrics still did not reconcile.
   The six-hour schedule and zero-event cap remain active. These samples do
   not establish full-day savings.
3. **Still required:** reconcile delayed S3 metric bins, collect a full
   seven-day post-change request trend, compare daily operation totals and
   S3/CloudWatch charges, and verify image repair, queue age, failure/DLQ
   behavior and admin manual refresh through representative production
   traffic. Keep the admin legacy snapshot viewer enabled and the deferred
   outbox disabled until their separate parity/capacity gates pass.
4. **Rollback cadence**: set
   `SCHEDULED_REFRESH_EXPRESSION='rate(30 minutes)'` for the
   subsequent Scouts CloudFormation deployment (or restore the previous
   parameter in a controlled stack update). **Rollback code** by
   reverting the implementation PRs if required. Historical S3 objects are
   untouched.

## Follow-on PRs required for issue closure

- Snapshot/Activity parity: the agenda refresh no longer reads the legacy
  snapshots in the current source. The private admin snapshot API still reads
  them behind `SCOUTS_LEGACY_RUNTIME_SNAPSHOTS`, default `true`, until
  historical and manual-review compatibility is accepted. The source mapping
  and known gaps are recorded below. Old snapshot arrays and point-in-time
  aggregates cannot be reconstructed from queue counts or a bounded activity
  query. Preserve old S3 objects until the audit and production acceptance
  are complete.
- S3 canonical persistence integrity: PR #191 merged as
  `95fbd71e68536a636ef9fb6e7135e009413dce00` and deployed. It replaces the
  trailing GET in `saveHexEventToS3()` with a validated S3 SHA-256 full-object
  checksum and fails closed on a mismatch. Caller field checks and separate
  revisioned approval ETag guards remain in place. The post-deployment request
  measurement is recorded below and still needs a full seven-day window.
- Approval idempotency currently uses S3 conditional PUT (`If-None-Match` for
  first claim, `If-Match` for stale-claim takeover and completion) plus GET to
  arbitrate conflicts and read the winning result. This preserves a durable
  cross-invocation claim and compare-and-swap behavior. The existing
  `scouts-request-activity` table can host these records without a new table or
  GSI: use `requestId=approval-idempotency#<idempotencyKey>` and
  `feed=approval-idempotency`, which keeps them out of the Activity Centre's
  `feed=activity` query. The table is currently PAY_PER_REQUEST and its TTL is
  seven days. The S3 claim objects have no expiry, so setting `expiresAt` on
  migrated claims would weaken replay protection; omitting it preserves that
  protection but retains records indefinitely. A safe cutover also needs to
  backfill or lazily import existing S3 claims before accepting DDB misses,
  preserve ETag-equivalent ownership with a conditional `claimToken`/version
  update, and test takeover, concurrent conflict, queue-published/marker-failed
  recovery, and backfill races. A dual-read fallback retains an S3 GET on each
  DDB miss and therefore delays request savings. Keep S3 as the active store
  until request attribution shows material savings, #172 settles capacity and
  retention, and a tested migration/import plan preserves the current
  indefinite replay contract. No migration is included here.
- Deferred refresh production acceptance: the outbox implementation is
  present but disabled by default. Benchmark its read/write peaks and GSI
  traffic with #172, choose whether on-demand or a separately approved
  provisioned allocation is safe, then enable it under a measured rollout.
  The stack now accepts explicit provisioned RCU/WCU values for the outbox
  table and GSI, each capped at 10, while the default remains PAY_PER_REQUEST.
  Verify backlog age, expiry, retry recovery and throttling under live load.
  No continuously polling SQS mapping is added. See
  [`issue-174-deferred-refresh-design.md`](issue-174-deferred-refresh-design.md).
- Capacity planning belongs with **#172**. Benchmark provisioned RCU/WCU
  peaks, shared free allocation, burst behaviour, GSI usage and throttle
  retries before any on-demand-to-provisioned mode change.
- SQS options: keep two processing mappings unless cost evidence proves
  another approach; separately evaluate replacing only the idle DLQ
  activity mapping with queue-depth alarms plus safe manual diagnostics.
  The live seven-day sample showed about 60,468 empty receives per mapped
  queue and zero messages received, but the current DLQ mapping records each
  exhausted processing delivery as terminal DynamoDB activity. Queue counts
  in the Admin UI are on-demand diagnostics, not a proactive notification
  replacement. With no SQS charge in the recorded baseline, retain all three
  mappings until an alarm/notification and failure-activity replacement is
  tested. No live Lambda event-source mapping is changed in this PR.

**Cost guarantee:** none. Savings are conditional on actual invocation
attribution and traffic distribution. S3 object storage, API calls,
CloudWatch and any use above free allocations can still incur charges.

## Snapshot replacement contract and remaining parity gaps

| Legacy snapshot information | Current source | Coverage and limit |
| --- | --- | --- |
| Request identity, root request ID, HEX, action, state, stage and update time | DynamoDB request activity rows | Activity Centre reads its ledger. Runtime stage labels query at most 100 active rows; a missing or older row leaves the execution stage unknown. |
| Current active execution and start time | Step Functions `ListExecutions` | This is authoritative for running executions. Request ID/root ID is preferred for matching; HEX is a display-only fallback when IDs are absent. Activity older than two minutes before an execution start is rejected. |
| Visible, in-flight and delayed counts | SQS `GetQueueAttributes` | Approximate queue-level values only; they do not identify or enumerate requests and may lag. Read is on demand. |
| Oldest message age | CloudWatch `AWS/SQS` / `ApproximateAgeOfOldestMessage` | Metric may have no datapoint when no active messages are present; it is sampled separately from SQS counts. |
| Per-request pending/completed arrays and aggregate counts | No one-to-one replacement | The old materialized snapshot may include historical or stale members not represented by active activity rows or current queue depth. Consumers requiring these arrays need an explicit query contract before retirement is accepted. |
| Durable enrichment state, retries, cooldowns and manual-review status | Enrichment state table and activity records | These sources represent enrichment workflow state, not the old S3 queue snapshot. Legacy manual-review records need a production compatibility audit. |
| Step Functions task token | Not exposed by replacement views | Tokens remain workflow-internal and are not stored in the activity index; do not infer or recreate them from execution metadata. |

The merged code and hermetic tests establish the intended read routing and
cutover flag. The flag remains enabled, so legacy reads are still active. The
production rechecks confirm parity is not established: activity has no rows,
historical snapshots contain task tokens, and manual-review item-level
reachability remains unverified. Do not disable the flag, delete historical
snapshot objects, or claim full migration acceptance until the required
comparison is recorded.

## Full manual-review count and current-state comparison (2026-11-03 20:29–20:32 UTC)

AWS profile `scouts` again verified account `553490163883` in `eu-west-2`.
The enrichment table remained `PAY_PER_REQUEST`, with 158 items and 7,575,114
bytes reported by `DescribeTable`. A sequential, count-only scan evaluated two
items per request and completed all 158 items: 27 had `state=manual_review`.
It reported 950.5 total consumed read capacity units. The per-minute
`ConsumedReadCapacityUnits` datapoints during that scan were 355, 334.5 and
260.5; `ReadThrottleEvents` had no datapoints in the queried interval. This
provides the full manual-review count without returning item contents, but it
does not identify which events or stages those rows represent, nor prove that
each is reachable in Admin.

A second paced scan projected only HEX, stage, state, update time and TTL from
manual-review rows. It again evaluated 158 items in 80 two-item requests and
reported 950.5 consumed read capacity units. All 27 rows had valid HEX values
and no `expiresAt`; their update times ranged from 2026-09-08 through
2026-09-13. Stage counts were 19 `tagline`, 3 `imageTheme`, and 5 `image`.
That pass issued one `HeadObject` for each of the 27 rows, including a
duplicate HEX, and found 14 successes and 13 nonzero outcomes. A third scan
deduplicated the 27 rows to 26 unique HEX values and classified their canonical
`events/{HEX}.json` keys: 14 exist and 12 returned HTTP 404. No access-denied or
other errors occurred. The 12 corresponding manual-review records are
orphaned from current canonical event objects. Their states date from
2026-09-08 through 2026-09-13 and have no TTL; keep them for owner review, and
do not treat them as active enrichment work or delete them automatically.

Each of the three complete two-item-page scans consumed 950.5 read capacity
units (2,851.5 total for this audit). The second scan's minute datapoints were
134.5, 155, 210.5, 172.5, 232.5 and 45.5. For the third scan, available
20:46–20:50 datapoints were 151, 158.5, 248, 229.5 and 144; the 20:51 minute
was not yet complete. The highest observed scan minute was 355 units, below
the earlier 927.5-unit minute from 2026-11-01. `ReadThrottleEvents` had no
datapoints during either scan window. Do not repeat a full-table scan for this
inventory; use the recorded item-level result for further parity work.

At the same recheck, the activity-feed GSI query returned zero rows; all five
SQS queues had zero visible, in-flight and delayed messages; and the three
enrichment state machines had zero running executions. The queued legacy
snapshot was empty and last updated at 18:04 UTC. The processing and completed
snapshots were unchanged since September and each still contained a historical
request row with a `taskToken`. These are stale relative to current queue and
execution state. `LegacyRuntimeSnapshotsEnabled` remains `true`; no snapshot
was modified or deleted. Keep the compatibility viewer enabled until the 27
manual-review rows receive an item-level reachability audit and the legacy
task-token/history contract is resolved.

## Canonical event PUT integrity without a follow-up GET

`saveHexEventToS3()` now serializes the normalized canonical event once and
requests S3 `SHA256` full-object checksum validation on the `PutObject`. It
compares the returned checksum with a locally calculated SHA-256 digest and
fails closed on a mismatch. The saved payload is returned from that exact
serialization; existing caller-side field checks remain in place. This removes
the unconditional `GetObject` that previously followed each canonical event
PUT. The revisioned approval flow and its ETag-based stale-review checks were
not changed.

The hermetic persistence regression verifies a normal sparse save performs one
event GET to load the current canonical document and one event PUT, rejects a
checksum mismatch before agenda publication, and preserves event fields. The
full suite passed 593 tests before merge. This source and test evidence did not
by itself establish a production request reduction; deployment and the
short-window readback are recorded in the following section. A successful
canonical event save and a mature daily/seven-day request comparison are still
needed. No S3 objects were modified for the deployment readback.

## Canonical event checksum deployment readback (2026-11-03 21:20–21:32 UTC)

Before the readback, `AWS_PROFILE=scouts aws sts get-caller-identity` verified
account `553490163883` and the expected account role. Master deployment run
[`41720523063`](https://github.com/antonio1000homens/scouts/actions/runs/41720523063)
completed successfully for commit `95fbd71e68536a636ef9fb6e7135e009413dce00`.
CloudFormation stack `sqs2scouts-lambda` reported `UPDATE_COMPLETE` at
21:20:49 UTC. Lambda `sqs2scouts` was `Active`, with
`LastUpdateStatus=Successful`, `LastModified=21:20:54 UTC`, and
`CodeSha256=l25Ae/PNMXr1LkaN39yjPEHu2i3F4i+z+PQtJXhmXrI=`. This confirms the
deployment control plane updated; a real canonical event save has not yet
exercised the checksum path.

The pre-deployment 24-hour bucket sample at 21:09 UTC recorded 12,681 GET,
2,081 HEAD, 135 LIST, and 360 PUT requests. It is an approximate bucket-wide
baseline, not a per-save attribution. In the first 12 minutes after deployment,
the one-minute S3 request-metric query returned one GET at 21:26, no PUT data,
and the `sqs2scouts` invocation metric had no datapoints. The single GET has no
known caller and does not establish a post-change comparison. Allow the metric
window to mature, capture a successful persistence event, then compare daily
and seven-day operation totals and posted S3 charges. Keep web/admin traffic
separate from Lambda SDK counts; no S3 objects were modified for this readback.
