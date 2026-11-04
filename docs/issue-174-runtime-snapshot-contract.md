# Issue #174 legacy runtime snapshot contract

This comparison reconstructs the legacy object shape from repository history
(`87c1ebb^`); production snapshot object bodies were not read. The objects were
denormalized, bounded summaries of SQS deliveries. They were not an
authoritative queue or workflow ledger.

## Legacy object shape

The top level held `source`, `queue`, `updatedAt`, `requests`, `requestIds`,
`hexes`, `links`, and `recordCount`. Individual `requests` entries could hold
`requestTime`, `requestId`, `messageId`, `hex`, `title`, `subject`, `realm`,
`action`, `taskToken`, `orchestrationType`, `orchestrationStep`, and `status`;
completed entries could also carry failure information. The three objects
represented queued, processing, and completed snapshots. Writers bounded
request rows to 200, IDs/HEX values to 50, and links to 100; these were
last-writer-wins S3 summaries rather than a complete delivery history.

## Field comparison

| Legacy field | Current lifecycle source | Queue source | Enrichment source | Step Functions source | Limits |
| --- | --- | --- | --- | --- | --- |
| `requests` | `scouts-request-activity` stores one item per `requestId`, with state, stage, timeline, and recovery data. | `GetQueueAttributes` returns queue-level visible, in-flight, and delayed counts. | `scouts-enrichment-state` stores one item per HEX and stage. | Active execution listing returns workflow executions. | No source reconstructs the old combined array. Activity rows can be absent or expire; queue counts have no request identities; enrichment rows are not request rows; execution listing is bounded to active workflows. |
| `requestIds` | Activity partition key `requestId`, plus `rootRequestId` and collapsed `childRequestIds`. | Message IDs are intentionally not enumerated by the read-only status path. Receiving messages would change visibility and is outside this status API. | `lastRequestId` is per HEX/stage and is not a queue inventory. | Execution input can provide request/root IDs when present. | Old arrays contained a capped mix of application request IDs and SQS message IDs; no current read provides that same set. |
| `hexes` | Activity `hex` supports lifecycle lookup and filtering. | Queue attributes do not expose HEX values. | HEX is the partition key and stage is the sort key. | Execution input may contain `hex` or `requestHex`. | HEX identifies event work, not a unique delivery; the old aggregate set was capped at 50. |
| `links` | Activity rows retain `requestId`, `rootRequestId`, `hex`, `action`, and reconciliation identity. | Queue status has no request-to-HEX linkage. | Enrichment state links HEX to a stage and last request ID, not to every delivery. | Execution input can correlate a running workflow to its request ID and HEX. | The old `requestId`/`hex`/`sourceMessageId`/`realm`/`action` rows were sampled links, not a durable relation table. |
| `orchestrationStep`, `orchestrationType`, `taskToken` | Activity `stage` describes lifecycle transitions; tokens are not copied into the activity ledger. | Queue status does not expose message bodies or task tokens. | Stage is explicit in the enrichment key and state. | Execution status is authoritative for an active workflow; input supplies orchestration identity. | Do not infer an active callback from an old task token or snapshot row. A task token is not restored by this migration. |
| `status` | Activity `state` and timeline distinguish queued, processing, retry, review, completion, and failure states. | Queue attributes show aggregate visible/in-flight/delayed counts, not per-message lifecycle states. | Stage state distinguishes pending, in-progress, retry-wait, persist-pending, succeeded, and manual-review outcomes. | Execution status distinguishes running and terminal workflow outcomes. | These status domains have different owners and are not interchangeable. A queue count is not a completed or failed lifecycle record. |
| `requestTime`, snapshot `updatedAt`, completion/failure timing | Activity `createdAt`, `updatedAt`, and timeline timestamps describe individual ledger writes. | SQS/CloudWatch exposes approximate oldest-message age, not every message timestamp. | Enrichment state keeps attempt, update, retry, and lease timestamps. | Execution records expose start/stop times; activity may add current stage time. | Snapshot `updatedAt` refreshed a whole object and was not the timestamp of every row. It cannot establish current in-flight work. |
| `title`, `subject`, `realm`, `action` | Activity retains safe display and operation fields when available. | Queue counts expose none of these. | Enrichment state is keyed by HEX/stage and does not hold full event content. | Execution input may hold request descriptors. | These fields may be absent from a durable row; canonical event content remains in `events/{HEX}.json`. |
| `recordCount` | Bounded Activity queries return rows and an optional continuation cursor. | Queue attributes return approximate queue counts. | Enrichment queries count stage records only when explicitly requested. | Execution listings return execution counts within the selected status and limit. | These counts measure different populations; none is a substitute for the old snapshot's per-batch record count. |

## Current producer and reader inventory

- Current code has no producer for `runtime/scoutsQueued.json`,
  `runtime/scoutsProcessing.json`, or `runtime/scoutsComplete.json`. Historical
  writer functions were removed; the current refresh path has no snapshot
  writer or snapshot-derived active-processing index.
- `subject=snapshot, action=get` remains as a compatibility endpoint behind
  `LegacyRuntimeSnapshotsEnabled`. Production has the flag set to `false`; an
  authenticated request returned HTTP 410. No snapshot object is deleted.
- The Admin legacy viewer still calls that endpoint. Its deployed
  `admin-script.js` contains an explicit notice directing operators to
  Activity and Operations. A direct unauthenticated admin-page request returned
  403, so this evidence verifies the deployed script and API response, not the
  rendered page in an authenticated browser session.
- `tests/issue-174-s3-requests.test.mjs` guards removal of refresh-path snapshot
  reads/writes; `lambdas/scouts/function/tests/test-runtime-snapshot-retirement.mjs`
  covers the API retirement gate. Activity, queue, DLQ, retry, and workflow
  behavior is tested in their component suites rather than through a
  reconstructed snapshot fixture.

## Cutover rule

Use the Activity ledger for request lifecycle, SQS attributes and CloudWatch
age metrics for queue health, `scouts-enrichment-state` for per-stage retry
decisions, and Step Functions for active workflow state. Missing activity rows
must remain visible as missing evidence; do not synthesize a completed row from
an empty queue or an old S3 snapshot. Keep canonical event objects and existing
queue mappings. Historical snapshot objects remain untouched pending any
separate, age-gated deletion approval.
