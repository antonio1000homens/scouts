# Live regression canary

## Purpose

The live regression canary validates the deployed Scouts event lifecycle using one unique synthetic event in the production data path without rendering that event on the public website.

It is deliberately separate from the hermetic Issue 39 tests. The hermetic tests prove contracts without AWS credentials; this canary proves that the deployed API, queues/orchestration, persistence and S3 projections still work together.

## Synthetic event

Each run creates a unique event with:

- title: `SCOUTS REGRESSION <timestamp>-<random>`;
- UID: `scouts-regression-<timestamp>-<random>`;
- a unique title-derived HEX;
- a future date (2099 by default);
- canonical metadata with no tagline/theme/image and `isApproved=false`, `isHidden=false`.

The canary writes and then reads back both:

- `events/<hex>.json` — the authoritative canonical event/metadata document;
- `agenda.json` — the published agenda projection for the same HEX.

The test does not treat a successful HTTP response as success. Every mutation must become visible in both S3 representations before the stage passes.

Production mutations are ownership-aware and optimistic. The event object is created with an S3 create-only precondition; agenda seed/reset/cleanup writes use the current ETag and retry on concurrent updates. Cleanup removes only objects and agenda entries that this run proved it created.

## Public-page isolation

Future dating alone is not a sufficient safety boundary because the public loader intentionally renders future events.

The public loader therefore permanently filters events whose top-level UID **or source UID** begins with the reserved prefix:

```text
scouts-regression-
```

Before any production mutation, the canary reads the deployed `website/scripts/event-loader.js` from the production bucket and refuses to run unless that deployed guard is present. This prevents an independently triggered canary from un-hiding an event while an older website bundle is still live.

This means the canary can safely verify a real `unhide` transition (`metadata.status.isHidden=false`) while the event remains in `agenda.json`, without becoming visible on the public site.

Normal calendar events must never use the reserved prefix.

## Lifecycle exercised

The canary performs the following deployed journey:

1. Verify the AWS account and deployed public-page regression guard.
2. Seed a clean synthetic event in `events/<hex>.json` and `agenda.json`.
3. Assert the event object exists in S3 and the agenda contains the same canonical metadata.
4. Request `generateFull`; wait for tagline, image theme and image URL to persist in both files.
5. Require a `website/eventImages/` generated-image key and assert the object itself exists in S3.
6. Clear only the tagline in both canonical representations, request `generateTagline`, and assert durable read-back.
7. Clear only the image theme, request `generateImageTheme`, and assert durable read-back.
8. Clear only the image URL, request `generateImage`, and again require durable read-back plus a verifiable generated-image object.
9. Request `approve`; assert `isApproved=true` in the event and agenda.
10. Request `hide`; assert `isHidden=true` in the event and agenda.
11. Request `unhide`; assert `isHidden=false` in the event and agenda and confirm the reserved regression UID remains attached.
12. Remove the synthetic agenda entry and event object, sweep the complete `website/eventImages/<hex>-` namespace, and verify S3 deletions rather than reporting cleanup success from an acknowledgement alone.

An agenda backup is retained under `migration-backups/live-regression/<run-id>/agenda.json` for recovery/audit.

## Running from GitHub Actions

Use the **Scouts Live Regression Canary** workflow and explicitly enable the `confirm_live_mutation` input.

The workflow:

- is `workflow_dispatch` only;
- does not run on pull requests or pushes;
- uses GitHub OIDC with the existing AWS role;
- verifies the expected AWS account before mutation;
- resolves the deployed `scouts` Lambda Function URL;
- reads `/scouts/shared/required-api-key` from SSM with decryption and masks it immediately;
- gives the job enough wall-clock budget for every bounded stage wait plus `finally` cleanup;
- writes a compact pass/fail table to the GitHub job summary.

## Running locally

Local execution deliberately does **not** accept ambient/default AWS credentials. Select an explicit profile for the intended production account; the script independently verifies account `553490163883` before mutating anything.

```bash
export AWS_PROFILE="<your-explicit-scouts-production-profile>"
export AWS_REGION=eu-west-2
export SCOUTS_API_URL="$(aws --profile "${AWS_PROFILE}" lambda get-function-url-config --function-name scouts --query FunctionUrl --output text)"
export SCOUTS_API_KEY="$(aws --profile "${AWS_PROFILE}" ssm get-parameter --name /scouts/shared/required-api-key --with-decryption --query Parameter.Value --output text)"
export LIVE_TEST_ACK=1
node lambdas/tools/live-canonical-event-smoke.mjs
```

Do not print `SCOUTS_API_KEY`.

## Failure interpretation

A failure names the durable boundary that did not converge, for example:

- `Full enrichment persistence`;
- `Tagline enrichment persistence`;
- `Image theme enrichment persistence`;
- `Image enrichment persistence`;
- `approval persistence`;
- `hide persistence`;
- `unhide persistence`.

Cleanup failures are also failures of the canary. A run must not report PASS while a canary-owned event, agenda entry, or generated image is known to remain behind.

This is specifically intended to catch cases where the request is acknowledged but S3 remains unchanged.

## Scope and limitation

The canary simulates a newly ingested event by seeding the clean canonical event and agenda projection before exercising the deployed mutation/enrichment pipeline. It does **not** currently test fetching/parsing a remote OSM/ICS calendar feed. That remains covered by hermetic calendar parsing/identity tests and can be added later through a dedicated isolated regression feed if calendar-ingress coverage becomes necessary.
