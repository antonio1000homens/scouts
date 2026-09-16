# Scouts workflow testing strategy

This document implements the test/security design from issue #39.

## Purpose

A green deployment must prove more than retry helpers. The test suite should make failures diagnosable across:

`Admin/UI -> request contract -> queue contract -> orchestration -> provider -> persistence -> approval/action -> public rendering`

Normal pull-request tests are hermetic and must not depend on the deployed site.

## Test layers

### Authoritative hermetic runner

Normal hermetic tests are discovered and executed by one entry point:

```bash
npm ci --prefix lambdas/shared-layer/nodejs
node scripts/run-hermetic-tests.mjs
```

`scripts/run-hermetic-tests.mjs` owns the approved test locations and naming
convention, prints selected file counts for each component, fails when an
expected component selects no tests, and runs the deployed-Lambda `no-undef`
gate before the tests. Live scripts and provider-spend tests are not selected.
The intentional undefined-identifier fixture is checked as part of the runner
so a broken lint configuration cannot silently pass.

### Layer A — hermetic unit/contract tests (every affected PR)

These tests run with Node's built-in test runner and no production credentials.

Coverage includes:

- admin agenda-refresh payloads;
- admin tag/image/full-enrichment payloads;
- approve, hide and unhide payloads;
- duplicate approval suppression;
- missing-auth / missing-HEX fail-closed behaviour;
- Slack action-ID mapping for approve/skip/edit/hide;
- public hidden-event detection;
- public generated-image rendering only after approval;
- deterministic fake text/image provider behaviour;
- cached image reuse.

Browser functions are loaded from the actual checked-in browser source into a Node `vm` sandbox. Network/backend dependencies are injected as no-op/memory functions, so the tests exercise the current UI function bodies without loading the real admin site.

### Layer B — hermetic component journey (every affected PR)

`tests/issue-39-synthetic-workflow.integration.test.mjs` follows a synthetic event through logical component boundaries:

1. admin generation request;
2. queue contract;
3. stage selection;
4. deterministic tagline generation;
5. deterministic image-theme generation;
6. deterministic image generation;
7. in-memory persistence;
8. approval;
9. public visibility;
10. hide;
11. hidden public state;
12. unhide;
13. restored public state.

The test records boundary/stage information so a failure identifies the broken logical stage rather than only reporting an incorrect final object.

The fake provider exists under `tests/helpers/` only. Production provider allowlists continue to accept only their normal production values; `fake` is deliberately not a production-selectable provider.

The persistence boundary also has a handler-level test. It invokes the real
`persistence-processor.mjs` Lambda handler through its SQS entry point with a
production-shaped message and injected fake S3/SQS/SFN/activity adapters. The
fixture hides and unhides a canonical HEX, reads back the HEX document and agenda,
checks every same-HEX sibling receives the same state (including a later-added
occurrence), and requires a completed activity result.

### Layer C — deployed smoke test (future, manual/post-merge only)

Do **not** run a write-capable smoke test against normal production event keys.

Before implementing a deployed smoke test, provide one of these isolation mechanisms, in preference order:

1. dedicated `scouts-test` stack (recommended);
2. dedicated test queues/table/bucket;
3. an IAM-enforced `test/<run-id>/` namespace across every writable resource.

A prefix is only sufficient if all participating services can be prevented by IAM/application validation from escaping the test namespace.

## Deployed smoke-test security design

When isolation exists, the smoke test should be a separate job after deployment. A fresh runner is useful here because it validates the deployed system from outside the deployment runner.

Required controls:

- GitHub OIDC only; no long-lived AWS access keys;
- a dedicated least-privilege smoke-test IAM role;
- permissions limited to the isolated test resources/prefix;
- deterministic fake provider by default;
- no Slack posts to normal operational channels;
- no real member, child or calendar data;
- a generated test ID such as `test-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`;
- bounded polling (for example <= 2 minutes total);
- no unbounded SQS/Step Functions retries;
- `if: always()` best-effort cleanup;
- cleanup output lists any retained test keys/resources without leaking credentials;
- an explicit workflow input before any real-provider test;
- real-provider smoke call budget hard-limited to one provider invocation.

Suggested future output:

```text
Synthetic event: test-<run-id>
Request accepted: PASS
Queued: PASS
Tagline: PASS
Image theme: PASS
Image generation: PASS (fake provider)
Persistence: PASS
Approval: PASS
Public visibility: PASS
Hide: PASS
Hidden from public loader: PASS
Cleanup: PASS
```

## Pull-request security invariants

Tests executed for pull requests must:

- require no Bitwarden variables or secrets;
- require no AWS credentials;
- make no S3, DynamoDB, SQS or Step Functions writes;
- make no Slack calls;
- make no Gemini or Cloudflare inference calls;
- never follow arbitrary fixture URLs;
- use synthetic identifiers only;
- avoid printing environment variables or secret-like values.

The CI job intentionally runs the issue #39 suite before any deployment lane. PR events skip `deploy-web` and `deploy-aws` entirely.

## Running locally

The authoritative suite is:

```bash
npm ci --prefix lambdas/shared-layer/nodejs
node scripts/run-hermetic-tests.mjs
```

The issue #39 subset can still be run directly when iterating on the UI or
security contracts:

From the repository root, the issue #39 suite has no external dependencies beyond Node:

```bash
node --test \
  tests/issue-39-admin-actions.test.mjs \
  tests/issue-39-actions-rendering.test.mjs \
  tests/issue-39-synthetic-workflow.integration.test.mjs \
  tests/issue-39-security-contract.test.mjs
```

Provider-specific tests that import only pure provider clients can also run without credentials, for example:

```bash
node --test lambdas/sqs2scouts/function/tests/test-cloudflare-image-client.mjs
```

## Coverage matrix

| Journey | Layer A | Layer B | Deployed smoke |
| --- | --- | --- | --- |
| Agenda request publication | yes | contract | future |
| Tagline request | yes | yes | future |
| Image-theme request | yes | yes | future |
| Image request | yes | yes | future |
| Provider response/schema | existing + fake | yes | fake by default |
| Image cache/reuse | existing + fake | yes | future |
| Persistence boundary | existing contracts | real handler with injected adapters | future |
| Approve | yes | yes | future |
| Hide/unhide | yes | yes | future |
| Invalid/tampered action | yes | yes | future |
| Hidden public filtering | yes | yes | future |
| Approved image rendering | yes | visibility contract | future |

## What these tests do not prove

Hermetic tests cannot prove that production SQS event-source mappings are enabled, deployed Lambda environment variables are correct, or AWS permissions currently allow a message to flow. Those are specifically the purpose of the future isolated deployed smoke layer.

When an incident occurs before that layer exists, use the issue #39 tests to first rule out browser/message-contract regressions, then inspect deployed queue depth/event-source mappings/Step Functions/runtime state.

## Regression policy

Every confirmed production defect must add or strengthen an automated
regression at the lowest production boundary that would have prevented the
escape, and that regression must be selected by `scripts/run-hermetic-tests.mjs`.
The change description records:

```text
Why existing tests missed it:
New regression:
Would the regression fail on the previous commit: yes/no
CI command/job that executes it:
```

If the CI command is not explicit, the regression is not complete.
