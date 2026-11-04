# `scoutsDecision` queue: current contract

> This file previously described an automatic SQS consumer in the `scouts`
> Lambda. That description is obsolete. The current repository has no
> `scoutsDecision` Lambda event-source mapping, and `scouts` does not process
> queue records as an invocation path.

## Current behavior

Producers send terminal decision notifications to `scoutsDecision`. The
`scouts` Operations view reads queue attributes and CloudWatch queue metrics;
it does not receive or delete messages. No in-repository automatic consumer
for this queue is configured. Any external consumer must be identified and
reviewed before changing message retention, payloads, or queue ownership.

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
