# Scouts.mjs - scoutsDecision Queue Realm Support

## Overview
The `scouts.mjs` Lambda function receives messages from the `scoutsDecision` SQS queue and processes them based on their realm.

## Supported Realms from scoutsDecision Queue

### 1. **sqs2scouts** Realm
**Purpose**: React to persistence outcomes reported by the `sqs2scouts` lambda.

**Actions**:
- `persisted`: HEX file saved successfully. Scouts lambda checks whether the HEX is complete (AI + image prompt + image URL). If anything is missing it does not requeue from this callback path; otherwise the agenda entry is updated with the final AI/image data.
- `hidden`: Event status is `hidden`. Scouts lambda updates `agenda.json` so the event disappears from the public feed.

**Code Location**: `scouts.mjs` around the `structuredCommand.realm === 'sqs2scouts'` branch (~2090 onwards).

**Example Message**:
```json
{
  "realm": "sqs2scouts",
  "action": "persisted",
  "subject": {
    "hex": "776f726b696e6720646f6773",
    "title": "Working dogs"
  },
  "source": "sqs2scouts"
}
```

Hidden event notifications look similar but include `action: "hidden"` and, when available, a `uid` in the subject so agenda updates can match either UID or HEX.

### 2. **scouts** Realm (commands)
**Purpose**: Internal triggers initiated by scouts.mjs itself (e.g. fresh fetches, reset, or manual resume requests).

**Supported Actions**:
- `reset`: When `subject === 'agenda'`, deletes cached agenda and ICS files before repopulating.
- Event requests: When `subject === 'events'` and `action` is a number, instructs scouts.mjs to queue that many new events via `realm: 'scoutsRequest'`.

**Code Location**: `scouts.mjs` command parsing logic (~1960-2050).

## Message Flow

### From SQS to Processing
1. Message arrives in `scoutsDecision` queue
2. SQS triggers `scouts.mjs` Lambda
3. Lambda extracts message from SQS record
4. Message is reprocessed as HTTP request (recursive call)
5. Realm-specific handler processes the request

**SQS Handler Code** (Lines 1828-1858):
```javascript
if (event.Records && Array.isArray(event.Records)) {
  for (const record of event.Records) {
    const messageBody = JSON.parse(record.body);
    const sqsEvent = {
      ...messageBody,
      headers: {},
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify(messageBody),
      _triggeredBySqs: true
    };
    const result = await lambdaHandler(sqsEvent);
  }
}
```

## Downstream Queue Integration

### scoutsRequests Queue
Scouts.mjs sends messages to the `scoutsRequests` queue when:
- A `persisted` notification arrives but the HEX is still incomplete → no requeue is performed from this callback path.
- A reset command removes cached state → follow-up work items are enqueued so enrichment can restart.

## Summary

| Realm | Purpose | Sends To | Slack Update |
|-------|---------|----------|--------------|
| sqs2scouts | Persisted/hidden notifications from sqs2scouts lambda | scoutsRequests (only when enrichment still needed) | Handled upstream in sqs2scouts (scouts.mjs only updates agenda) |
| scouts | Internal commands for resets and event batches | scoutsRequests | No |

## Notes
- Only `sqs2scouts` notifications are expected from the decision queue after the persistence refactor; approval/hide realms were removed in favour of the persist pipeline.
- The `_triggeredBySqs` flag indicates messages came from SQS (affects default behaviour).
- Messages are reprocessed recursively to maintain consistent handling logic.
