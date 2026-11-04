# `scoutsDecision` queue: current contract

> This file previously described an automatic SQS consumer in the `scouts`
> Lambda. That description is obsolete. The current repository has no
> `scoutsDecision` Lambda event-source mapping, and `scouts` does not process
> queue records as an invocation path.

## Current behavior

No external consumer was identified, and the repository has no automatic
consumer or acknowledgement contract. Producers no longer publish terminal
decision notifications to `scoutsDecision`. The `scouts` Operations view
continues to read queue attributes and CloudWatch queue metrics; it does not
receive or delete messages. Existing messages remain subject to the queue's
configured retention period, and the queue remains available for read-only
operational visibility.

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
