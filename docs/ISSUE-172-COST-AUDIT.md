# Scouts AWS cost audit and safe changes

## Repeatable read-only inventory

Run from the repository root with an authenticated Scouts profile:

```sh
AWS_PROFILE=<scouts-account-profile> node scripts/scouts-cost-audit.mjs --max-scan-items 200 > scouts-cost-audit.json
```

The script verifies account `553490163883` before continuing and fixes the region to `eu-west-2`. It inventories the three application tables and TTL settings, samples only `expiresAt` and `state` with a hard per-table cap (default 200, maximum 500), waits one second between scan pages, lists recent CloudWatch metric identities and alarm definitions, and retrieves 14 days of DynamoDB capacity/throttle metrics. It does not write AWS resources or items. Keep the generated JSON out of Git if its operational details are not needed in a public repository.

The sample is intentionally capped. If `expirySample.capped` is true, increase the cap only after reviewing table size and desired read volume. CloudWatch `list-metrics` is a recent-discovery view; an empty result does not disprove historical billing. Use the Cost and Usage Report or billing console for billed metric-month reconciliation.

## Observed baseline

Read-only snapshot collected 2026-11-01 UTC from the verified Scouts account. The owner-supplied bill period was not independently verified.

| Table | Mode | Item count / size | TTL | Sampled expiry data |
|---|---|---:|---|---|
| `scouts-gemini-usage` | PAY_PER_REQUEST | 3 / 228 bytes | ENABLED, `expiresAt` | 3 numeric Unix-second expiries; none expired or missing |
| `scouts-enrichment-state` | PAY_PER_REQUEST | 158 / 7,575,114 bytes | ENABLED, `expiresAt` | 158 sampled; none expired or missing; 118 succeeded, 27 manual_review, 10 persist_pending, 3 pending |
| `scouts-request-activity` | PAY_PER_REQUEST | 0 / 0 bytes | ENABLED, `expiresAt` | no rows; GSI `activity-feed` is also empty |

The activity GSI uses `ProjectionType: ALL`. In the 14-day CloudWatch window, DynamoDB reported 59,402 table read capacity units and 2,377 `activity-feed` index read capacity units; writes were zero and no read/write throttle datapoints were reported. `scouts-gemini-usage` used 2 table read units and `scouts-enrichment-state` used 3,811.5. Total observed read use was 65,592 units; request activity accounted for 61,779 (94%). A linear 30-day extrapolation is about 140,554 units, close to the owner-supplied 154,339 reads, but the billing period is unknown. These metrics are aggregate by table/index, not by API operation. CloudWatch exposed `SuccessfulRequestLatency` and `ReturnedItemCount` query series for request activity, but that does not prove an exact RCU split by caller.

The code has two request-activity read paths: a feed `Query` on `activity-feed` (with post-read filters for HEX, root ID, states, and active state), and one by-ID lookup per requested ID. The admin activity view polls every four seconds while it tracks active requests, and previously looked up all tracked IDs on each poll, including IDs already returned by the feed. The poll is now ten seconds while active and sixty seconds while idle; by-ID lookups are limited to tracked IDs missing from the latest feed response. The 14-day totals support repeated empty/poll reads as a likely driver, but aggregate metrics do not identify which screen or caller contributed each read. The by-ID path now uses `GetItem` on the primary key; this removes query semantics and extra query overhead, but a one-row lookup has the same DynamoDB capacity basis, so no RCU saving is claimed for that change.

On-demand is currently billed at the owner-reported $0.02 in the supplied (unverified-period) extract. One provisioned RCU serves one strongly consistent 4 KB read per second, or two eventually consistent reads per second. The observed 14-day averages are approximately 0.049 RCU for the request table, 0.002 for its GSI, 0.003 for enrichment state, and negligible for usage. A scenario of one RCU and one WCU on each of the three tables plus the activity GSI therefore has four RCUs and four WCUs provisioned. AWS currently includes the first 25 provisioned RCUs and 25 WCUs per Region per payer account for Standard tables, but the unused allowance for this payer is not verified. If all eight units fit within unused allowance, the maximum saving against the supplied DynamoDB bill is about $0.02/month; without that allowance, fixed provisioned charges could exceed the current on-demand bill. Daily averages do not establish peak capacity or burst safety, so no billing-mode conversion is proposed. AWS documents the [DynamoDB pricing and Free Tier](https://aws.amazon.com/dynamodb/pricing/) and [provisioned capacity unit rates](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/provisioned-capacity-mode.html).

## TTL and retention decision

All three live tables report TTL `ENABLED` on `expiresAt`. The bounded sample found Number attributes consistent with Unix seconds. The state table currently has 27 `manual_review` and 10 `persist_pending` rows with future expiries, so those live rows are not immediately at risk. DynamoDB TTL deletion remains asynchronous; an expired item can still be returned until DynamoDB removes it.

The enrichment-state writer now leaves TTL unset for `in_progress`, `retry_wait`, `persist_pending`, `manual_review`, and operator-reset `pending` rows. It retains the 90-day expiry for `succeeded` state, where expiry can permit a future regeneration. This prevents new actionable or recoverable states from aging out. `getEnrichmentState` uses a strongly consistent `GetItem` and continues returning an expired-but-present row; the application does not assume TTL has already deleted it. A regression test covers this case. The live rows inspected still have their existing 90-day `expiresAt` values; this repository-only change does not backfill or update them. A guarded one-time migration script is provided; its default mode only scans and summarizes, while `--apply` conditionally removes `expiresAt` from actionable rows and never deletes items. The read-only dry-run found 40 eligible rows (27 `manual_review`, 10 `persist_pending`, 3 `pending`), all expiring more than 30 days later, with no expired or missing expiry values. Review the output and obtain a separate operations approval before running its `--apply` mode. No live data was changed in this audit.

Usage records retain their existing daily quota semantics and TTL. Request activity retains its seven-day TTL and no recurring cleanup scan was added. Its table and index were empty at audit time, so changing the GSI projection or adding a new index is not justified by this sample.

## Custom metrics and alert coverage

`list-metrics` returned no recently discoverable series in either custom namespace at audit time. The supplied bill extract reports 0.679 custom metric-months; that historical billing figure cannot be mapped to active identities from the current discovery response. Source inspection shows the prior EMF publishers emitted multiple dimension combinations and per-outcome image metric names. Publishers now keep only the low-cardinality metric identities required by the existing alarms; other outcomes remain structured JSON logs.

| Metric identity after change | Alarm | Decision |
|---|---|---|
| `Scouts/Gemini: Requests {Outcome=failure}` | `scouts-gemini-request-failed`, threshold 1 / 5 min | Keep; dimension matches alarm |
| `Scouts/Gemini: EnrichmentQuarantined {}` | `scouts-gemini-enrichment-quarantined`, threshold 1 / 5 min | Keep; dimensionless metric matches alarm |
| `Scouts/Gemini: EnrichmentRetry {}` | `scouts-gemini-enrichment-retry-burst`, threshold 5 / 1 hour | Keep; dimensionless metric matches alarm |
| `Scouts/ImageGeneration: ProviderQuotaExhausted {}` | `scouts-cloudflare-free-allocation-exhausted`, threshold 1 / 5 min | Keep; dimensionless metric matches alarm |
| `Scouts/ImageGeneration: Failure {}` | `scouts-image-generation-failure-burst`, threshold 3 / 1 hour | Keep; dimensionless metric matches alarm |

The five live alarms were all `OK` when inspected and had no alarm actions configured. Their state alone does not prove recent metric delivery; the recent metric discovery list was empty. The two image-generation publishing paths now emit the dimensionless `Failure` series consumed by the alarm. Gemini request failures continue to emit the exact `Outcome=failure` series. No alarm was removed. The bill extract says these alarms are inside the free allowance, so migrating evaluation to Kubernetes does not offer a demonstrated direct saving. Keep CloudWatch alarm coverage until equivalent Prometheus/Alertmanager conditions, notification routing, missing-data behavior, and AWS connectivity-loss alerting are implemented and verified.

## Expected impact and remaining evidence

- The active/idle admin polling interval reduces request frequency by 60% while active and 58% while idle, before accounting for tab count. It also skips redundant by-ID reads for requests already in the latest feed page. Status notifications may be delayed by up to the new interval.
- Exact-key `GetItem` clarifies and narrows the by-ID database operation; DynamoDB capacity savings are not assumed for a one-item read.
- Limiting EMF to the five alarm-backed identities removes success, stage, kind, and diagnostic-only metric series from future publication. Existing historical series and billing-month charges are unaffected by this source change.
- No DynamoDB billing mode, CloudFormation resource, live alarm, or live item was changed. Deployment, alarm parity in Kubernetes, and existing-row TTL backfill remain separate approval/review steps.
- S3 ($0.34 in the supplied extract) was not audited here; it should be a separate read-only review because it exceeds DynamoDB cost and may involve live event images.
