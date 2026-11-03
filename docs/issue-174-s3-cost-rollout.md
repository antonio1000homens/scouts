# Issue #174 — staged Scouts S3/SQS cost optimisation

This local follow-up branch builds on the open [phase 1 PR #175](https://github.com/antonio1000homens/scouts/pull/175).
It is not issue closure or permission to deploy production infrastructure
without review.

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

## Read-only production recheck (2026-11-03)

AWS Core `GetCallerIdentity` verified account `553490163883` before these
reads. This current state is independent of the uncommitted local branch:

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
  therefore do not identify callers. The local code now logs low-cardinality
  S3 SDK operation counts for the complete Scouts invocation, with scheduled
  refresh separated; compare those logical calls against bucket metrics after
  deployment and account for SDK retries.
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
activity ledger cannot reproduce. The snapshot retirement flag therefore
defaults to enabled. Do not opt into retirement until task-token dependencies,
historical coverage, and manual-review compatibility have a verified
migration contract.

## Code changes on the local follow-up branch

1. **Proposed four refreshes/day**: CloudFormation and runtime defaults
   move to `rate(6 hours)`. The deploy script **explicitly passes** the
   cadence so preexisting CloudFormation stacks do not silently retain
   `rate(30 minutes)`. Admin **Run refresh now** and independently
   invoked workflows remain available. Existing 24-hour ICS freshness
   behaviour is unchanged. The change takes effect only if the stack
   is actually deployed after review.
2. **Prepare runtime snapshot lifecycle retirement**: the start/finally paths
   previously read queued, processing, completed and wrote queued (up to
   six GET + two PUT per normal execution). The dead append/touch writers
   and snapshot-derived active-processing index are removed. Legacy S3
   snapshot reads in reconciliation and the private `subject=snapshot`
   API are behind `LEGACY_RUNTIME_SNAPSHOTS_ENABLED`. It defaults to true
   until production parity is verified. After that audit, setting it to
   false disables the reads and makes the API return HTTP 410; setting it
   back to true is the rollback. No snapshot objects are deleted.
   Active Step Functions executions remain authoritative; stage labels
   are enriched from at most 100 active DynamoDB activity rows.
3. **Add on-demand live queue status**: Operations can request approximate
   visible, in-flight, delayed and oldest-message-age attributes for the
   two primary queues and their DLQs. This uses SQS `GetQueueAttributes`
   and does not sample, receive, or change messages. Existing explicit DLQ
   inspect/redrive behavior remains separate.
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
   direct code-path attribution without logging object keys. Counts represent
   SDK `send()` calls; SDK-internal retries may cause more wire requests, so
   correlate these with the existing bucket request metrics after deployment.
8. Implement an opt-in DynamoDB outbox for excess scheduled enrichment work.
   Work keys include HEX, stage and generation; writes coalesce source feed
   identifiers; the dispatcher claims leases and sends at most 10 items each
   15-minute invocation through the existing `scoutsRequests` queue. Failed
   work retries with bounded backoff and becomes visible as `needs_attention`
   or `expired`. The table is on-demand and retained; the feature flag defaults
   off, while Operations exposes bounded read-only queue-age/status samples.
   See [`issue-174-deferred-refresh-design.md`](issue-174-deferred-refresh-design.md).
   The retained PAY_PER_REQUEST table and all runtime permissions/schedules
   are conditioned on the opt-in flag. A normal stack deployment leaves the
   table uncreated. Enabling it still requires the #172 capacity review.
9. **Remove a duplicate canonical read-back**: persistence already GETs the
   just-written HEX object and parses it for verification. Two enrichment
   paths now reuse that verified body for their generated-field checks instead
   of issuing a second GET. The PUT and one GET remain; this does not make the
   read conditional on an ETag or remove read-after-write integrity checking.

## Expected impact and limits

The scheduling change is a **91.7% reduction in scheduled invocations**
(48 → 4/day), *not* a proven 91.7% reduction in S3 billing.
Using an **unverified** rough attribution of 283 GET and 44 HEAD per old
refresh, removing 44 executions/day could avoid around 12,452 GET and
1,936 HEAD/day; record real per-operation before/after traffic before
claiming these savings. The removed legacy touches avoid additional
reads/writes per actual Scouts execution; the new aggregate logs quantify
HEX reread and duplicate image HEAD savings per invocation.

An initial comparison can use the existing bucket request monitoring
(`CodexRequestCostAudit`) by operation and 5–15-minute intervals.
Account for the cost of that temporary monitoring and remove it once
the benchmark is complete, subject to its own approval. Distinguish
Edge/CloudFront requests and browser/admin traffic from Lambda work.

## Rollout and rollback

1. Review the PR and synthetic tests. Confirm the deployed
   EventBridge rule, selected CloudFormation parameter and absence of
   latency-critical consumers of scheduled discovery. Record a 7-day
   request baseline and an acceptable 6-hour calendar freshness SLA.
2. Before deployment, check account identity and region explicitly.
   Deploy via the existing verified Scouts deployment path; do not
   disable any SQS mappings, delete S3 objects or alter DynamoDB billing
   mode as part of this PR.
3. Compare per-refresh S3 calls, queue age, reconciled event counts,
   image repair, failure/DLQ behaviour and admin manual refresh.
   Inspect logs for `[S3 Request Reduction]`.
4. **Rollback cadence**: set
   `SCHEDULED_REFRESH_EXPRESSION='rate(30 minutes)'` for the
   subsequent Scouts CloudFormation deployment (or restore the previous
   parameter in a controlled stack update). **Rollback code** by
   reverting this PR if required. Historical S3 objects are untouched.

## Follow-on PRs required for issue closure

- Snapshot/Activity parity: the local code removes snapshot-derived
  enrichment stage checks and gates the remaining legacy reads/API behind
  `SCOUTS_LEGACY_RUNTIME_SNAPSHOTS`; the flag defaults to `true`, so existing
  behavior remains active unless explicitly changed. A production parity
  audit is still required before disabling those reads or calling migration
  complete. The source mapping and known gaps are recorded below. Old snapshot
  arrays and point-in-time aggregates cannot be reconstructed from queue
  counts or a bounded activity query. Preserve old S3 objects until the audit
  and production acceptance are complete.
- S3 canonical persistence integrity: review unconditional PUT+GET
  verification and duplicate caller readbacks; do **not** remove these
  until conditional revision/ETag contracts and failure tests pass. The two
  redundant caller GETs have now been removed by reusing the verified response;
  the remaining unconditional PUT and single GET are unchanged.
- Approval idempotency currently uses S3 conditional PUT (`If-None-Match` for
  first claim, `If-Match` for stale-claim takeover and completion) plus GET to
  arbitrate conflicts and read the winning result. This preserves a durable
  cross-invocation claim and compare-and-swap behavior. A DynamoDB migration
  might reduce S3 requests but would add a table/index and another on-demand
  request workload; it also needs parity for takeover, TTL, conflict, and
  queue-published/marker-failed cases. Keep the S3 contract until measured
  request attribution shows material savings and a dedicated migration test
  covers those races. No migration is included here.
- Deferred refresh production acceptance: the outbox implementation is
  present but disabled by default. Benchmark its read/write peaks and GSI
  traffic with #172, choose whether on-demand or a separately approved
  provisioned allocation is safe, then enable it under a measured rollout.
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
| Visible, in-flight, delayed counts and oldest message age | SQS `GetQueueAttributes` | Approximate queue-level values only; they do not identify or enumerate requests and may lag. Read is on demand. |
| Per-request pending/completed arrays and aggregate counts | No one-to-one replacement | The old materialized snapshot may include historical or stale members not represented by active activity rows or current queue depth. Consumers requiring these arrays need an explicit query contract before retirement is accepted. |
| Durable enrichment state, retries, cooldowns and manual-review status | Enrichment state table and activity records | These sources represent enrichment workflow state, not the old S3 queue snapshot. Legacy manual-review records need a production compatibility audit. |
| Step Functions task token | Not exposed by replacement views | Tokens remain workflow-internal and are not stored in the activity index; do not infer or recreate them from execution metadata. |

The local code and hermetic tests establish the intended read routing and
cutover flag only. The cutover flag defaults to enabled, and legacy reads
remain active at that setting. The production recheck above confirms parity is not
established: activity has no rows, historical snapshots contain task tokens,
and the manual-review scan was partial. Therefore the flag remains enabled
by default. Do not disable it, delete historical snapshot objects, or claim
full migration acceptance until the required comparison is recorded.
