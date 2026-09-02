# Gemini enrichment retry protection

Automatic enrichment is bounded per HEX and stage (`tagline`, `imageTheme`, or `image`). State is stored in the `scouts-enrichment-state` DynamoDB table.

- Maximum automatic attempts: 3.
- After attempt 1: retry after 1 hour.
- After attempt 2: retry after 6 hours and send one Slack warning.
- After attempt 3, or a deterministic configuration/data/authentication error: `manual_review` and one Slack escalation.
- Scheduled scans check the state and the global `scouts-gemini-usage` circuit before publishing to `scoutsRequests`.
- A successful Gemini result is written to the state record before the event S3 write. If the S3 write fails, the next delivery reuses the cached result and retries persistence without another Gemini call.
- An in-progress lease expires after 30 minutes so a crashed worker can be retried safely.

Metrics are in the `Scouts/Gemini` namespace: `EnrichmentRetry`, `EnrichmentQuarantined`, `EnrichmentSkipped`, `GeminiResultReused`, and the existing `Requests` outcomes. CloudWatch alarms are configured for quarantine, retry bursts, quota rejection, and provider failures.

To list quarantined stages:

```sh
AWS_PROFILE=scouts aws dynamodb scan --region eu-west-2 --table-name scouts-enrichment-state \
  --filter-expression '#state = :manual' --expression-attribute-names '{"#state":"state"}' \
  --expression-attribute-values '{":manual":{"S":"manual_review"}}'
```

To deliberately reset one quarantined stage (after recording the reason), use the shared helper from an operator shell or an equivalent DynamoDB update:

```sh
AWS_PROFILE=scouts AWS_REGION=eu-west-2 GEMINI_ENRICHMENT_STATE_TABLE_NAME=scouts-enrichment-state \
  node --input-type=module -e "import { resetEnrichmentState } from './lambdas/shared-layer/nodejs/enrichment-state.mjs'; await resetEnrichmentState(process.argv[1], process.argv[2])" HEX_VALUE STAGE
```

The command requires AWS credentials for the Scouts account and resets only the specified `HEX + stage` to `pending`; it does not reset the global daily budget.
