# SQS2Scouts Lambda Function

Lambda function that processes messages from the scoutsProcessing SQS queue and sends notifications to Slack.

## Queue topology guardrail

- `sqs2scouts` must be triggered by `scoutsProcessing`.
- `scouts2sqs` must be triggered by `scoutsRequests`.
- `scoutsDecision` is notification-only and must not be configured as an event source for `scouts`.
- Do not add a `scoutsDecision -> scouts` Lambda event source mapping. That feedback path can re-enter the pipeline and create loops.

## Structure
```
sqs2scouts/
├── function/
│   ├── lambda-layer/
│   │   └── nodejs/
│   └── sqs2scouts.mjs
├── deploy.sh
├── test-local.js
├── set-env.sh
└── README.md
```

## Configuration

The function keeps non-secret runtime configuration in environment variables and reads secrets from SSM Parameter Store at runtime.

SSM-backed secrets:
- `SLACK_BOT_TOKEN_PARAMETER` -> default `/scouts/shared/slack-bot-token`
- `SLACK_SIGNING_SECRET_PARAMETER` -> default `/scouts/shared/slack-signing-secret`
- `GEMINI_API_KEY_PARAMETER` -> default `/scouts/sqs2scouts/gemini-api-key`

Non-secret environment variables:
- `SLACK_WEBHOOK_URL` - Slack API endpoint (defaults to chat.postMessage)

### Gemini image prompt generation

Gemini prompt creation for image sentences happens in `function/sqs2scouts.mjs` via:
- `buildGeminiPrompt(event, 'imagePrompt', config)`
- `buildEventDetailsForPrompt(event)`
- `generateGeminiSuggestion(event, 'imagePrompt', config)`

This path is used by realm `imagePrompt` (and also by realm `tagline`/`AI`, which returns both tagline and `imagePrompt`).

The prompt sent to Gemini is built from:
- Template: `imagePromptTemplate` (or `aiPromptTemplate` for `tagline`/`AI` mode)
- `{{EVENT_DETAILS}}` placeholder from event fields:
   - `title` (fallback: `summary`, `name`, then decoded `hex` title)
   - `section`
   - `start` (`start.iso`, `start.raw`, or `start`)
   - `location`
   - `description`
   - `notes`
   - `source` (fallback: `calendar`)
- `{{IMAGE_PROMPT_GUIDELINES}}` placeholder from `imagePromptGuidelines` (legacy `imageTagGuidelines` is still accepted as a fallback)

Gemini response is expected as strict JSON and normalized to `image.prompt` using:
- `imagePrompt` if present
- otherwise legacy `imageTag`

### Where this is configured

Prompt template/guideline configuration is loaded at runtime from S3:
- Bucket: `TARGET_BUCKET` (env var, defaults to `scouts-2ndtolworth-prod-553490163883`)
- Key: `SCOUTS_CONFIG_KEY` (env var, defaults to `scouts.conf`)
- Cache TTL: `SCOUTS_CONFIG_TTL_MS` (env var, defaults to 5 minutes)

Relevant keys inside `scouts.conf`:
- `imagePromptTemplate`
- `aiPromptTemplate`
- `imageTagGuidelines`
- `imageGenerationPromptSpecifications`

Repository source of truth:
- [scouts.conf](/c:/storage/github/scouts/lambdas/sqs2scouts/scouts.conf)

That file is the only repository copy that should be edited.

Deployment paths:
- `sqs2scouts/deploy.sh` uploads it to `s3://scouts-2ndtolworth-prod-553490163883/scouts.conf` during lambda deploys.
- `scouts/.github/workflows/deploy-to-s3.yml` uploads the same file to `s3://scouts-2ndtolworth-prod-553490163883/scouts.conf` during website deploys.
- `scouts/deploy-manual.sh` uploads the same file for manual website deploys.

Related Gemini env vars:
- `GEMINI_API_KEY_PARAMETER` (SSM parameter name for Gemini calls)
- `gemini` / `GEMINI` (text suggestion feature flag; defaults enabled)
- `gemini_images` / `geminiImages` / `GEMINI_IMAGES` (Gemini image generation feature flag; defaults enabled)

## Testing Locally

1. **Set environment variables:**
   ```bash
   source ./set-env.sh
   ```
   Prefer storing only `BWS_ACCESS_TOKEN` on the host and keeping the actual secret UUIDs in `lambdas/scouts/.env`.

2. **Test the function locally:**
   ```bash
   node test-local.js
   ```

3. **Deploy the function:**
   ```bash
   ./deploy.sh
   ```

## Expected Behavior

- Triggered by messages in SQS queue: `arn:aws:sqs:eu-west-2:243857182133:scoutsProcessing`
- Processes messages with `realm`, `subject`, `action` parameters
- Sends notifications to Slack channel: `#scouts`
- Returns 200 on success, 500 on errors

## Supported SQS Message Schemas

`sqs2scouts` reads the first SQS record body as JSON with this envelope:

```json
{
   "realm": "tagline | imageTheme | image | persist",
   "action": "string",
   "subject": "string | object",
   "title": "optional string used for runtime tracking",
   "subjectLabel": "optional string such as tagline or imageTheme used for runtime tracking",
   "responseUrl": "optional string",
   "response_url": "optional string",
   "slackMetadata": {
      "responseUrl": "optional string",
      "response_url": "optional string"
   }
}
```

Only these `realm` values are accepted:
- `tagline`
- `imageTheme`
- `image`
- `persist`

Any other `realm` is dropped and sent to DLQ.

### Key: `realm`

`realm` routes the message to a specific handler:
- `tagline`: generate tagline and, when missing, an `imageTheme` from HEX event data.
- `imageTheme`: generate the persisted image theme only.
- `image`: generate an event image from the stored theme-derived prompt and store the returned image URL.
- `persist`: persist the event payload (and optionally download image to website bucket).

### Key: `action`

`action` is a string interpreted per realm:

- For `tagline`: informational only for this handler path.
- For `imageTheme`: informational only for this handler path.
- For `image`:
   - `"bypass"` (case-insensitive): use full event object from `subject` when provided.
   - Any other non-`"request"` string: treated as image prompt override.
   - `"request"`: no prompt override.
- For `persist`:
   - `"hidden"` (case-insensitive): marks event as hidden behavior path (skips image download and approval marking).
   - Any other value: normal persist path.

Slack action IDs are also accepted and mapped before handling:
- `scouts_request_hide` -> `HIDE`
- `scouts_request_skip` -> `SKIP`
- `scouts_request_approve` -> `PERSIST`
- `scouts_request_edit` -> `EDIT`

### Key: `subject`

`subject` supports multiple shapes. It is normalized internally.

#### 1. HEX string form

Used by `tagline`, `imageTheme`, and `image` standard paths.

```json
{
   "subject": "68656c6c6f2d6576656e74"
}
```

#### 2. Event object form

Used by `imageRequest` bypass and `persist`.

```json
{
   "subject": {
      "hex": "68656c6c6f2d6576656e74",
      "uid": "optional event uid",
      "originalUid": "optional original uid",

      "title": "Event title",
      "summary": "Optional summary",
      "dtstart": "2026-03-06T19:00:00Z",
      "location": "Optional location",
      "section": "Optional section",
      "icsType": "Optional type",

      "tagline": "Optional tagline",
      "image": {
         "prompt": "Optional image prompt",
         "url": "Optional image URL"
      },

      "approved": true,
      "hidden": false,
      "status": "hidden",
      "runs": 2,

      "source": {
         "uid": "optional",
         "title": "optional",
         "summary": "optional",
         "dtstart": "optional",
         "location": "optional",
         "section": "optional",
         "icsType": "optional"
      },
      "metadata": {
         "hex": "optional",
         "tagline": "optional",
         "image": {
            "prompt": "optional",
            "url": "optional"
         }
      },
      "lastModified": {
         "raw": "optional",
         "ISO": "optional"
      }
   }
}
```

HEX resolution priority inside `subject` object:
1. `subject.metadata.hex`
2. `subject.hex`

## Realm-Specific Examples

### `tagline`

```json
{
   "realm": "tagline",
   "action": "request",
   "subject": "68656c6c6f2d6576656e74"
}
```

### `imageTheme`

```json
{
   "realm": "imageTheme",
   "action": "request",
   "subject": "68656c6c6f2d6576656e74"
}
```

### `image` (standard)

```json
{
   "realm": "image",
   "action": "cartoonish image of scouts in a forest camp at sunset",
   "subject": "68656c6c6f2d6576656e74"
}
```

### `imageRequest` (bypass)

```json
{
   "realm": "imageRequest",
   "action": "bypass",
   "subject": {
      "hex": "68656c6c6f2d6576656e74",
      "title": "Troop Camp",
      "image": {
         "prompt": "cartoonish image of scouts around a woodland campfire"
      }
   }
}
```

### `persist`

```json
{
   "realm": "persist",
   "action": "hidden",
   "subject": {
      "hex": "68656c6c6f2d6576656e74",
      "title": "Troop Camp",
      "image": {
         "url": "https://example.com/image.jpg",
         "prompt": "campfire woodland scouts"
      },
      "status": "hidden"
   },
   "slackMetadata": {
      "responseUrl": "https://hooks.slack.com/actions/..."
   }
}
```

## Test Cases

The test script includes:
- ✅ Valid scouts message
- ✅ Badge ceremony event
- ❌ Empty records (should fail with error)

## Deployment

The function includes:
- SQS event source mapping (automatic trigger)
- IAM role with SQS read permissions
- Lambda layer with Node.js dependencies
- Environment variables for configuration
- Slack integration for notifications

Workflow note: edits under `scouts/sqs/sqs2scouts/**` trigger the GitHub Actions `deploy-sqs2scouts` job when pushed to `main`/`master`.
