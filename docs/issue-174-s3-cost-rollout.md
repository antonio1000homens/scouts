# Issue #174 — staged Scouts S3/SQS cost optimisation

This is **phase 1 of several PRs**, not an S3-to-DynamoDB lifecycle cutover
and not permission to deploy infrastructure without review.

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

## Changes in this PR

1. **Proposed four refreshes/day**: CloudFormation and runtime defaults
   move to `rate(6 hours)`. The deploy script **explicitly passes** the
   cadence so preexisting CloudFormation stacks do not silently retain
   `rate(30 minutes)`. Admin **Run refresh now** and independently
   invoked workflows remain available. Existing 24-hour ICS freshness
   behaviour is unchanged. The change takes effect only if the stack
   is actually deployed after review.
2. **Stop unconditional queued-snapshot touch**: previously the start
   and `finally` paths each read queued, processing, completed and wrote
   queued (up to six GET + two PUT per normal execution).
   The dead append/touch writers are removed. Normal reconciliation still
   reads all three legacy snapshots, prunes stale queued entries, writes
   queued **only on actual prune**, and retains active Step Functions
   reporting. The private legacy `subject=snapshot` API and admin
   viewer remain available; they should be deprecated only after a
   separately tested activity-ledger equivalence cutover.
3. **Deduplicate per-invocation image HEAD checks** across agenda and
   canonical HEX verification. Failed checks are never cached; 404 means
   missing, while permission/throttle/service failures now propagate
   rather than deleting potentially valid image URLs. A future refresh
   still checks every referenced image, preserving deleted-image recovery.
4. **Reuse canonical HEX JSON within the same refresh**: orphan cleanup's
   successful reads are reused by the subsequent HEX verification pass,
   with a **500-entry upper bound** and invalidation on deletion.
   The image verifier is create-only and canonical event objects are not
   removed or replaced by DynamoDB.
5. Emit **one aggregate log per refresh** for `reusedHexReads`,
   `imageHead.requests` and `imageHead.cacheHits`. No custom
   CloudWatch metrics, high-cardinality object-key logging, or new
   paid monitoring were added.

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

- Snapshot/Activity parity: field-level comparison of `requests`,
  `requestIds`, `hexes`, `links`, status/timing/Step Functions token
  with DynamoDB activity, durable enrichment-state, SQS attributes
  and running Step Functions executions. Ensure atomic idempotency and
  compatibility with old manual-review records before disabling legacy
  reads/admin endpoints or deleting any S3 snapshot.
- S3 canonical persistence integrity: review unconditional PUT+GET
  verification and duplicate caller readbacks; do **not** remove these
  until conditional revision/ETag contracts and failure tests pass.
- Coalesced/deferred refresh queue: idempotent feed keys, bounded batch,
  visibility/expiry/retries, DLQ and measurable queue age. Avoid
  creating a continuously polling fourth SQS event-source mapping.
- Capacity planning belongs with **#172**. Benchmark provisioned RCU/WCU
  peaks, shared free allocation, burst behaviour, GSI usage and throttle
  retries before any on-demand-to-provisioned mode change.
- SQS options: keep two processing mappings unless cost evidence proves
  another approach; separately evaluate replacing only the idle DLQ
  activity mapping with queue-depth alarms plus safe manual diagnostics.
  No live Lambda event-source mapping is changed in this PR.

**Cost guarantee:** none. Savings are conditional on actual invocation
attribution and traffic distribution. S3 object storage, API calls,
CloudWatch and any use above free allocations can still incur charges.
