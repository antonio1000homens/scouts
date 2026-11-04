# Issue #174 — deferred refresh work design

## Current behavior

The scheduled calendar refresh defaults to four runs per day. A run can cap
new request publications with `ScheduledRefreshMaxEvents` (currently zero by
default). `enrichEventsWithAI()` coalesces eligible requests by HEX within one
invocation and checks durable per-HEX/per-stage enrichment state before
publishing. Once the cap is reached, it continues writing the full agenda but
does not persist the remaining eligible candidates. A later calendar run
rediscovers them. This is eventual rediscovery, not a measurable or guaranteed
deferred-work queue.

The existing `scoutsRequests` queue is the downstream work buffer. Its 14-day
retention, receive limit, and DLQ cover work after publication. They do not
cover candidates skipped by the scheduled publication cap. Keep its existing
Lambda event-source mapping for prompt processing; the empty-receive baseline
shows no current SQS charge and does not justify changing that mapping.

## Repository implementation

The repository now defines a DynamoDB outbox table and a conditional 15-minute
EventBridge dispatcher in the Scouts Lambda stack. The dispatcher sends at
most 10 ready items per invocation to the existing `scoutsRequests` queue; it
does not add an SQS event-source mapping. The table defaults to on-demand
capacity, has a `state-nextAttemptAt-index` with a narrow INCLUDE projection,
and retains terminal items for 14 days after their 14-day work expiry. The
table is retained if the stack is removed or replaced.

The stack also supports `PROVISIONED` capacity for this optional outbox table
and its GSI. Each resource's RCU and WCU parameter is capped at 10, so this
table plus its index cannot be configured above 20 RCUs or 20 WCUs. This cap
keeps the outbox alone below the nominal 25-unit allowance. The account and
regional table inventory were subsequently checked against AWS's per-payer
Free Tier and organization state (see the readback below). The cap is not a
workload benchmark or capacity recommendation. The default remains
`PAY_PER_REQUEST`; neither the feature nor the table is enabled by default.
Capacity values must come from the workload benchmark, not the parameter
defaults. The GitHub deployment workflow reads the corresponding
`DEFERRED_REFRESH_OUTBOX_*` repository variables and falls back to the same
off/on-demand defaults. Setting those variables changes the configuration
applied by subsequent Scouts deployments, so set them only after the staged
capacity review and approval.

`DeferredRefreshOutboxEnabled` defaults to `false`. The table, dispatcher
schedule, outbox writes, outbox IAM permissions and admin reads are all
conditioned on the opt-in parameter, so a normal stack deployment does not
create the outbox. Enabling it requires a prior capacity review with #172; the
implementation does not claim that on-demand usage is free or switch any
existing table's billing mode. Once created, the table is retained if the
feature is disabled or the stack is removed.

Each work item contains:

- `workKey`: deterministic hash of normalized HEX, stage, and generation ID.
- `hex`, `stage`, `generationId`, `title`, and `sourceKeys`, a DynamoDB
  string set of stable `<configured-feed-id>#<realm>` identifiers. Do not put
  private feed URLs in queue records or logs.
- `createdAt`, `nextAttemptAt`, `expiresAt`, `attemptCount`, `state`, and
  `leaseUntil`.
- Stable `requestId` and `rootRequestId`, derived from `workKey`, for
  downstream activity idempotency.

Coalescing and delivery rules:

1. Coalesce by `workKey` before writing. A conditional update admits only new,
   ready, or leased records; an atomic string-set addition merges feed/realm
   source keys. A dispatched, expired, or needs-attention item cannot be
   revived for the same generation.
2. Store pending items in `state=ready`; query a due-time GSI by queue state
   and `nextAttemptAt`. The access pattern must be paginated and capped.
3. Claim each item with a conditional update and a five-minute lease before sending
   it to `scoutsRequests`. The existing per-stage reservation remains the
   final guard against duplicate enrichment if a send succeeds but the
   outbox update fails.
4. After a successful send, mark the item dispatched. On a transient send or
   capacity error, increment attempts and set bounded exponential backoff.
   Release or expire the lease so another scheduled drain can retry it.
5. After the retry limit, mark the item `needs_attention` with a bounded
   failure reason. Keep terminal items queryable in Operations for at least
   the diagnostic retention period. Never silently drop expired work: mark it
   `expired` with its age and reason.
6. Limit dispatches per invocation (initial proposal: 10) and process only
   candidates older than the immediate publication allowance. Calendar
   discovery, approvals, manual retries, active Step Functions callbacks,
   and other latency-sensitive work do not enter this outbox.

The runtime API exposes a bounded read-only status query for ready, due,
leased, needs-attention, and expired work. Operations displays the sample
counts, oldest ready item, sampled retry count, expired lease count, and
failure reasons for a small needs-attention sample. A plus sign indicates
that the bounded sample has more results. Dispatch does not count as completed
enrichment; completion remains owned by request activity and enrichment state.

## Capacity and rollout gates

The outbox table is defined in source but remains uncreated and unused by
default. Before
enabling it, coordinate with #172 and measure actual write/read peaks, GSI
allocation, burst behavior, retry amplification, maximum batch size, and
concurrent scheduled invocations. The table defaults to PAY_PER_REQUEST and
remains an additional request-cost consumer in that mode. Provisioned mode is
available in source and deployment configuration but has not been benchmarked
or enabled. Do not enable the outbox, switch its billing mode, or claim $0
without workload measurements and a shared-account capacity review. If the
GSI/query model exceeds safe provisioned capacity, retain on-demand mode or use
bounded scheduled scans only after measuring their read cost.

## Read-only DynamoDB capacity evidence (2026-11-03 19:59 UTC)

AWS STS verified account `553490163883` before this read. All three existing
tables remain `PAY_PER_REQUEST`; `scouts-request-activity` has zero items, and
`scouts-deferred-refresh` is not present. A seven-day `GetMetricData` query
(2026-10-27 19:59 through 2026-11-03 19:59 UTC) returned complete one-minute
series with 10,078 points per metric:

| Resource | Consumed read units | Nonzero minutes | Largest one-minute sum |
|---|---:|---:|---:|
| `scouts-enrichment-state` table | 5,709.5 | 343 | 927.5 at Nov 1 23:01 UTC |
| `scouts-gemini-usage` table | 6 | 3 | 2 at Nov 1 23:00 UTC |
| `scouts-request-activity` table | 6 | 3 | 2 at Nov 1 23:00 UTC |
| `scouts-request-activity/activity-feed` GSI | 3 | 4 | 1.5 at Nov 3 19:23 UTC |

All four table/index write-capacity series had zero consumed units in this
window. The enrichment-state maximum is a one-minute sum: it is a 15.46 RCU/s
minute-average equivalent only if consumption was uniform, and does not bound
the per-second peak or concurrency. The window also contains no request-activity
rows and no deferred-outbox traffic, so it does not represent the read/write
mix or retry amplification expected after enabling the outbox. The later
Free Tier readback below establishes the current regional allowance and
account scope, but not safe workload capacity. Do not enable the outbox or
change billing modes on the strength of these historical metrics; a
representative benchmark and throttling/retry acceptance are still required.

## Provisioned-capacity wiring deployment readback (2026-11-03 22:35 UTC)

PR #198 merged as `8ba0b0242c54a9190708de79b94152c01ac5a126`. Deployment run
[`41731893268`](https://github.com/antonio1000homens/scouts/actions/runs/41731893268)
completed successfully, and the `scouts-lambda` stack reached
`UPDATE_COMPLETE` at 22:35:41 UTC. The deployed parameters are
`DeferredRefreshOutboxEnabled=false` and
`DeferredRefreshOutboxBillingMode=PAY_PER_REQUEST`; each provisioned capacity
parameter remains at its default of 1. The Lambda environment reports the
outbox disabled with an empty table name. `ListTables` confirms
`scouts-deferred-refresh` is absent, while the three existing Scouts DynamoDB
tables remain `ACTIVE` and `PAY_PER_REQUEST`.

This verifies the dormant configuration deployed without creating the outbox
or changing existing table modes. It does not benchmark provisioned capacity
or approve a later mode switch. The account's current Free Tier and organization
scope are recorded below.

## DynamoDB Free Tier and account-scope readback (2026-11-03 22:54 UTC)

AWS STS verified account `553490163883` before the read-only checks. AWS
Organizations identifies this account as the management/payer account; its
organization currently contains one active account, `553490163883`. The
`eu-west-2` DynamoDB inventory contains only `scouts-enrichment-state`,
`scouts-gemini-usage`, and `scouts-request-activity`. All three are
`PAY_PER_REQUEST`, and the `scouts-deferred-refresh` table is absent. There is
currently no provisioned table or GSI capacity in this account and Region
consuming the DynamoDB provisioned-capacity allowance.

`GetAccountPlanState` reports account plan `PAID`, `ACTIVE`, with zero remaining
credits. Paid-plan status does not remove access to Always Free offers: AWS
documents DynamoDB's free tier as **25 RCUs and 25 WCUs per Region, per payer
account**, for DynamoDB Standard tables. The Free Tier API currently reports
DynamoDB storage usage only (`0.00061634 GB-Mo` actual, `0.0061634 GB-Mo`
forecast of a 25 GB-Mo limit); it reports no provisioned read/write usage.
That is consistent with the complete regional table inventory, which shows
no provisioned tables or GSIs.

The nominal 25/25 provisioned allowance is therefore available to this payer
account in `eu-west-2` at this readback. The optional outbox's configured
maximum of 20 RCUs and 20 WCUs across its table and GSI would fit inside that
allowance in isolation, leaving 5 units of headroom per direction. This is
eligibility evidence only; it does not prove that 20/20 (or any particular
capacity) is safe for the outbox's query/write pattern. The seven-day baseline
contains no outbox workload, and `scouts-enrichment-state` previously showed a
927.5 RCU one-minute sum. Keep the outbox disabled until the queue path is
benchmarked below the shared cap, throttling/retry behavior is accepted, and
the staged rollout is approved.

Related Free Tier API readback on the same date: SQS request usage is
`72,306` actual and `723,060` forecast of a `1,000,000` monthly Always Free
limit. CloudWatch metric monitor usage is `0.93333347` actual and
`9.3333347` forecast of a `10` metric limit. These are usage forecasts, not
posted charges; preserve low-cardinality telemetry and recheck the monthly
forecast before introducing additional metric series.

AWS references: [DynamoDB pricing and Free Tier](https://aws.amazon.com/dynamodb/pricing/)
and [Using the Free Tier API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-free-tier-api.html).

Implementation acceptance:

- Concurrent duplicate discoveries create one active item per work key.
- New generation IDs create new eligible work without reviving completed or
  manual-review work for an unchanged generation.
- A failed queue send is retried after lease/backoff; a successful send with
  a lost acknowledgement cannot produce duplicate enrichment cost.
- Stale leases recover after dispatcher termination.
- Retry exhaustion and expiry are visible and actionable.
- Per-run limits and queue-age bounds are tested under backlog and throttling.
- Immediate/manual flows bypass this queue and retain their existing latency.
- No fourth continuous SQS mapping is added; dispatcher schedule and batch
  size have explicit rollback settings.

The queue code and hermetic failure tests are implemented, but the feature is
not production-validated. The seven-day live capacity readback above is useful
baseline evidence, not a workload benchmark: capacity benchmarking,
deployment, live queue-age and drain-lag proof, and the shared
provisioned-capacity decision remain before it can satisfy the queue rollout
portion of issue #174.

PR #206 adds focused concurrency regressions for two same-generation
discoveries coalescing on one work key and two dispatchers competing for one
conditional lease. They exercise the DynamoDB command contract through the
hermetic client; they do not replace a live throughput or backlog benchmark.
