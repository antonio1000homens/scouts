# Slack Realm Pixabay Fix

## Issue
When `scouts2sqs` received a message with realm "slack" containing AI and image prompt but no image URL, it was always converting it to realm "persist" without checking if the subject needed pixabay image fetching.

## Fix Applied
Added logic to check if a "slack" realm message needs pixabay image fetching before defaulting to the persist realm.

### File Modified
`/home/windsor/github/lambdas/scouts/sqs/scouts2sqs/function/scouts2sqs.mjs`

### Changes
In the SQS message handler for realm "slack", added the following logic:

1. **Extract image data**: Uses `ensureImageContainer()` to normalize the image object
2. **Check completion status**:
   - `hasAI`: Checks if AI tagline exists
   - `hasPrompt`: Checks if image prompt exists
   - `hasUrl`: Checks if image URL exists

3. **Conditional routing**:
   - If `hasAI && hasPrompt && !hasUrl`: Routes to **pixabay** realm with action "request"
   - Otherwise: Routes to **persist** realm (existing behavior)

### Code Flow
```
Slack realm message received
    ↓
Check subject fields
    ↓
Has AI? ──Yes──→ Has image prompt? ──Yes──→ Has image URL?
    ↓                     ↓                         ↓
    No                    No                      No ──→ Send to pixabay realm
    ↓                     ↓                         ↓
Send to persist realm ←───┴─────────────────────────Yes ──→ Send to persist realm
```

### Benefits
- **Completes the enrichment pipeline**: Ensures slack messages with partial data get fully enriched
- **Consistent behavior**: Matches the same logic used for HTTP requests with "scouts" realm
- **Preserves metadata**: Slack metadata and response URLs are properly forwarded to pixabay processing

### Example Payload
**Input (slack realm):**
```json
{
  "realm": "slack",
  "action": "approve",
  "subject": {
    "hex": "536f6d657468696e67",
    "title": "Something",
    "AI": "Great activity for scouts",
    "image": {
      "prompt": "scouts doing outdoor activities",
      "url": null
    }
  },
  "slackMetadata": { "channel": "C123", "ts": "1234.5678" }
}
```

**Output (to scoutsProcessing queue):**
```json
{
  "realm": "pixabay",
  "action": "request",
  "subject": {
    "hex": "536f6d657468696e67",
    "title": "Something",
    "AI": "Great activity for scouts",
    "image": {
      "prompt": "scouts doing outdoor activities",
      "url": null
    }
  },
  "slackMetadata": { "channel": "C123", "ts": "1234.5678" }
}
```

### Testing Recommendations
1. Send a slack realm message with AI and image prompt but no URL
2. Verify it gets routed to pixabay realm in scoutsProcessing queue
3. Confirm slackMetadata is preserved
4. Ensure sqs2scouts processes it and fetches the image from Pixabay
5. Verify the final event is persisted with the image URL

## Date
October 17, 2025
