# Message Flow Reference

This guide captures the realm/action/subject combinations that move through the
Scouts enrichment pipeline and which component handles each hop.

## Components
- `scouts/function/scouts.mjs` – extracts events and publishes enrichment requests.
- `scouts/sqs/scouts2sqs/function/scouts2sqs.mjs` – validates inbound payloads, notifies Slack, and forwards to SQS.
- `eu-west-2/243857182133/scoutsProcessing` SQS queue – buffers work between lambdas.
- `scouts/sqs/sqs2scouts/function/sqs2scouts.mjs` – consumes requests from SQS, generates Slack approvals, and persists results.
- Slack – approval UI for AI copy, image prompts, and image URLs.

## Message catalogue

| Step | Producer → Consumer | Realm | Action | Subject shape | Purpose |
| ---- | ------------------- | ----- | ------ | ------------- | ------- |
| 1 | `scouts` → `scouts2sqs` | `AI` \| `imageUrl` | `request` | HEX string (`"6d616b6520686f6e6579"`) | Request initial enrichment for an event. |
| 2 | `scouts2sqs` → SQS | `AI` \| `imageUrl` | `request` | Identical HEX string | Persist request for downstream review. |
| 3 | `sqs2scouts` → Slack | `AI` \| `imageUrl` | `request` | HEX string | Build approval modal and pull existing metadata from S3. |
| 4 | Slack → `scouts2sqs` | `scouts` | `approval` | JSON: `{ "hex": "...", "AI": "...", "image": { "prompt": "...", "url": "..." }, "uid": "...", "section": "cubs" }` | User approves copy/image updates. Modal is replaced with a processing message immediately. |
| 5 | `scouts2sqs` → SQS | `scouts` | `approval` | Same JSON payload | Queue the approved content for persistence. |
| 6 | `sqs2scouts` → S3 & Slack | `scouts` | `approval` | Same JSON payload | Overwrite `events/<hex>.json` with approved data and confirm via Slack. |
| 7 | `scouts` → `scouts2sqs` | `scouts` | `bump` | `{ hex: [...], items: [...] }` | (Existing) Batch retry for stalled HEX files. |
| 8 | `scouts` → `scouts2sqs` | `scouts` | `reset` | `'reset'` | (Existing) Inform Slack that HEX history was cleared. |

## Sample payloads

### Enrichment request
```json
{
  "realm": "AI",
  "subject": "6d616b6520686f6d6573",
  "action": "request"
}
```

### Approval response
```json
{
  "realm": "scouts",
  "subject": {
    "hex": "6d616b6520686f6d6573",
    "uid": "event-42",
    "title": "Make & Do Badges",
    "section": "cubs",
    "AI": "Maker night: build, test, and earn your badge!",
    "image": {
      "prompt": "cubs badge making workshop",
      "url": "https://example.com/cubs-workshop.jpg"
    }
  },
  "action": "approval"
}
```

Use these examples when wiring integrations or regression-testing the lambdas.
