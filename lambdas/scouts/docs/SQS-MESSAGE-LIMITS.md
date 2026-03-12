# SQS Message Publishing Limits

## Overview
The scouts lambda now implements different message publishing limits based on how it is invoked:

## Message Limits

### POST Invocations (HTTP)
- **Limit**: Up to **5 SQS messages** per invocation to scoutsRequests queue
- **Trigger**: Direct HTTP POST requests to the lambda
- **Purpose**: Allows batch processing of multiple events in a single invocation

### SQS-Triggered Invocations (scoutsDecision queue)
- **Limit**: Only **1 SQS message** per invocation to scoutsRequests queue  
- **Trigger**: Messages from the scoutsDecision queue
- **Purpose**: Prevents message amplification and ensures controlled processing

### Custom Limits
- **Override**: Both limits can be overridden by structured commands
- **Command**: `{ realm: 'scouts', subject: 'events', action: <number> }`
- **Example**: `{ realm: 'scouts', subject: 'events', action: 10 }` allows 10 messages

## Retry Behavior

### Hex Files with High Run Counts
- **Threshold**: Hex files with `runs > 20` are **skipped from retries**
- **Purpose**: Prevents infinite retry loops for events that consistently fail
- **Behavior**: The hex file is still updated but no retry message is sent to the queue

### Run Count Tracking
- Each retry increments the `runs` field in the hex file
- When `runs >= 5`, the event becomes a "bump candidate" for retry
- When `runs > 20`, retries are skipped entirely

## Implementation Details

### Detection of SQS Triggers
When processing SQS events from the scoutsDecision queue, the lambda:
1. Detects `event.Records` with `eventSource === 'aws:sqs'`
2. Creates a synthetic event with `_triggeredBySqs: true` marker
3. Recursively calls the handler with this marked event

### Message Limit Application
The `maxScoutRequests` variable is set based on:
1. Structured command action (if provided) - highest priority
2. `_triggeredBySqs` marker: `1` message if true
3. Default for POST requests: `5` messages

### Retry Skip Logic
In the `enrichEventsWithAI` function:
1. Events at threshold (runs >= 5) are collected
2. Before sending retry messages, check if `runs > 20`
3. If true, log skip message and continue to next event
4. Run count is still incremented for tracking

## Testing
See `tests/test-sqs-message-limits.mjs` for comprehensive test coverage of:
- SQS vs POST limit detection
- Custom limit overrides
- Retry skip behavior for high run counts
