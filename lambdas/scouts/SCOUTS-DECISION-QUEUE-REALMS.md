# `scoutsDecision` queue: current contract

> This file previously described an automatic SQS consumer in the `scouts`
> Lambda. That description is obsolete. The current repository has no
> `scoutsDecision` Lambda event-source mapping, and `scouts` does not process
> queue records as an invocation path.

## Current behavior

Producers send decision notifications to `scoutsDecision` after persistence.
The `scouts` Operations view reads queue attributes and CloudWatch queue
metrics; it does not receive or delete messages. No in-repository automatic
consumer for this queue is configured. Any external consumer must be identified
and reviewed before changing message retention, payloads, or queue ownership.

## Current producer payloads

Two source paths publish messages:

- `sqs2scouts/function/approval-lifecycle-adapter.mjs` publishes
  `{ realm: "sqs2scouts", action: "persisted", subject: { hex, title },
  source: "approval-lifecycle-adapter", requestId?, rootRequestId?, requestHex? }`
  after saving and publishing the canonical event. This producer uses the same
  `persisted` action for both `awaiting_image` and `approved` approval states;
  consumers must not interpret this action alone as final approval.
- `sqs2scouts/function/persistence-processor.mjs` publishes
  `{ realm: "sqs2scouts", action: "persisted" | "hidden", subject: { hex,
  title, uid? }, source: "sqs2scouts", requestId?, requestHex? }` after the
  canonical write and agenda publication path. Its `hidden` action reflects a
  `HIDDEN` Slack decision; otherwise it emits `persisted`.

Both paths treat this queue publication as best-effort: they log a warning if
`SendMessage` fails and do not roll back the successful event write. The
repository supplies neither a consumer nor an acknowledgement/retry contract
for these notifications. The bounded production readback recorded in the
issue rollout log found an accumulating visible backlog, but no message body
was read. Queue metrics and these source payloads do not identify an external
consumer, so do not purge, redrive, change retention, or add a consumer based
on the source audit alone. Identifier fields with `?` may be absent from the
serialized message when the producer value is undefined.

The CloudFormation mapping inventory is in
[`SCOUTS-REQUEST-PIPELINE.md`](docs/SCOUTS-REQUEST-PIPELINE.md), and the
Operations read-only behavior is in
[`SQS-MESSAGE-LIMITS.md`](docs/SQS-MESSAGE-LIMITS.md). Keep
`scoutsDecision` unmapped to `scouts`; adding that mapping would create a
feedback path from terminal notifications into request discovery.

## Historical context

The previous version documented a proposed recursive SQS-to-HTTP handler and
realm-specific callbacks. Those code snippets and flow descriptions no longer
match the current source or deployed CloudFormation templates. Consult Git
history if the original design is needed; do not use it as an operational
runbook.
