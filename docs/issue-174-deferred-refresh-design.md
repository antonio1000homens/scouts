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
does not add an SQS event-source mapping. The table uses on-demand capacity,
has a `state-nextAttemptAt-index` with a narrow INCLUDE projection, and retains
terminal items for 14 days after their 14-day work expiry. The table is
retained if the stack is removed or replaced.

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
concurrent scheduled invocations. The table currently uses PAY_PER_REQUEST;
it is an additional request-cost consumer and does not use the owner's
preferred shared provisioned free allocation. Do not enable it or claim $0
without those measurements. If the GSI/query model exceeds safe provisioned
capacity, retain on-demand mode or use bounded scheduled scans only after
measuring their read cost.

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
not production-validated. Capacity benchmarking, deployment, live queue-age
and drain-lag proof, and the shared provisioned-capacity decision remain before
it can satisfy the queue rollout portion of issue #174.
