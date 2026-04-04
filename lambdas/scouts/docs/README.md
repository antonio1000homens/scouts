# Scouts Calendar Lambda

Fetches the two Online Scout Manager calendars, converts them into tidy JSON, and writes `events.json` and `programme.json` to the `2ndtolworth` S3 bucket (keys configurable via environment variables).

## Features

- **Event Merging**: Reads existing events from S3 before overwriting, ensuring:
  - Existing events (matched by UID) are preserved and not duplicated
  - Events older than 3 months are automatically removed
  - New events are seamlessly integrated
  
- **AI-Generated Taglines**: New future events automatically receive an AI-generated catchy one-liner via the Gemini API (requires the `GEMINI_API_KEY_PARAMETER` SSM parameter reference)

## Lambda layer

The `lambda-layer/lambda-layer.zip` bundle contains the shared runtime dependencies:
- `@aws-sdk/client-s3` for S3 operations
- `@google/generative-ai` for Gemini API integration

1. Publish the layer archive to your AWS account (for example with `aws lambda publish-layer-version --layer-name scouts-shared --zip-file fileb://lambda-layer/lambda-layer.zip`).
2. Attach the newly published layer version to the `scouts` Lambda function so the handler can resolve the SDK package from `/opt/nodejs/node_modules`.

Repeat `npm install` inside `lambda-layer/nodejs/` and recreate the zip whenever dependencies change.

## Environment variables

- `EVENTS_CALENDAR_URL` *(optional)* – defaults to the Cubs Events feed provided by OSM.
- `PROGRAMME_CALENDAR_URL` *(optional)* – defaults to the Cubs Programme feed provided by OSM.
- `TARGET_BUCKET` *(optional)* – defaults to `2ndtolworth`.
- `EVENTS_OBJECT_KEY` *(optional)* – defaults to `events.json`.
- `PROGRAMME_OBJECT_KEY` *(optional)* – defaults to `programme.json`.
Note: by default the lambda requests calendar ICS feeds without Authorization headers. The default, bundled calendar URLs are public and do not require authentication. If you need to fetch a protected calendar, provide a pre-authorised URL in `EVENTS_CALENDAR_URL` / `PROGRAMME_CALENDAR_URL` or proxy the request through an authenticated service.
- `GEMINI_API_KEY_PARAMETER` *(optional)* – SSM parameter name for the Google Gemini API key used to generate AI taglines for new future events. If not provided, events will not have AI-generated content.

> The lambda expects to run on the Node.js 24.x runtime so that the deployed environment matches the current Lambda configuration.

The existing GitHub workflow that syncs `lambdas/` to S3 already includes this lambda, so no pipeline changes are required.
