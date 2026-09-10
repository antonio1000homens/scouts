# Public repository migration runbook

This document covers the final one-off steps for making this repository public after the source cleanup in issue #66 is merged.

The objective is pragmatic: remove genuine secrets, personal/private information and production-derived private payloads. Ordinary AWS account IDs, ARNs, bucket/resource names and public service URLs are configuration rather than credentials and do not require a history rewrite by themselves.

## 1. Keep the repository private during cleanup

Do not change repository visibility until the source cleanup and history/privacy audit are complete.

## 2. Configure deployment values outside source where useful

GitHub repository/environment variables are suitable for non-secret deployment configuration. GitHub Secrets, Bitwarden, AWS SSM Parameter Store or AWS Secrets Manager must be used for credentials and secret values.

Useful non-secret variables include:

- `AWS_ROLE_TO_ASSUME`
- `CLOUDFORMATION_ROLE_ARN`
- `CODE_BUCKET`
- `CLOUDFLARE_ACCOUNT_ID`
- `ADMIN_API_BASE`
- deployment bucket/queue identifiers where they are externalised from scripts

Keep API keys, OAuth credentials, Slack tokens/signing secrets and Cloudflare API tokens out of ordinary variables.

The main deployment workflow already uses GitHub OIDC for AWS and its deploy jobs do not run for `pull_request` events. Preserve those properties when changing the workflow.

## 3. Run current-tree safety checks

From a clean clone:

```bash
node --test tests/public-repo-safety.test.mjs
```

Install `gitleaks` and scan the repository as well:

```bash
gitleaks git --redact
```

Investigate every genuine secret finding. Rotate/revoke a real credential before relying on repository cleanup.

## 4. Rewrite history for confirmed private data

The cleanup identified historical files that contained genuine personal/private data. Removing them in a normal commit does not remove older blobs from Git history.

Perform the rewrite from a fresh mirror clone and take a backup first:

```bash
git clone --mirror git@github.com:antonio1000homens/scouts.git scouts-public-cleanup.git
cd scouts-public-cleanup.git
```

Use `git filter-repo` (preferred) to purge the historical Wrangler local-state file and historical real OSM calendar fixture. Because the calendar path is retained as a new synthetic test fixture in the cleaned source, preserve a safe copy of the synthetic fixture before the rewrite and re-add it after filtering.

Example path-removal phase:

```bash
git filter-repo \
  --path cloudflare/.wrangler/cache/wrangler-account.json \
  --path lambdas/scouts/function/tests/cubs-programme.ics \
  --invert-paths
```

Then restore only the synthetic `cubs-programme.ics` fixture from the cleaned branch in a new commit.

Do not add sensitive values to replacement files, shell history, issue comments or the migration documentation.

If the history audit finds another real secret/PII value, extend the rewrite only for that confirmed sensitive content. Do not rewrite history solely to remove benign AWS/Cloudflare identifiers.

## 5. Scan all retained refs after rewriting

Run secret/privacy checks against all branches/tags that will remain reachable. Delete stale merged branches where useful.

At minimum review for:

- AWS access/secret keys;
- Google/Gemini API keys;
- Slack tokens, webhook URLs and signing secrets;
- Cloudflare API tokens;
- OAuth credentials;
- PEM/private-key material;
- private/pre-authorised OSM/calendar feed URLs;
- signed/authenticated URLs;
- unintended personal email addresses and phone numbers;
- copied production payloads containing private data.

Re-run `gitleaks` after the rewrite and verify the known removed blobs are no longer reachable from retained refs.

## 6. Review GitHub-side content outside Git

Git history rewriting does not alter GitHub Issues, PR comments, Actions logs or uploaded artifacts.

Before publication, review these separately for genuine secrets/private data. Ordinary account IDs and ARNs do not require removal on their own.

Delete or sanitize items that contain credentials, private feed URLs, personal contact details, signed URLs or private production payloads.

## 7. Validate deployment and tests

Before changing visibility:

1. Clone the cleaned repository normally into a fresh directory.
2. Run the repository tests and `tests/public-repo-safety.test.mjs`.
3. Confirm no local `.env`, `.wrangler`, `tmp/` or generated deployment snapshots appear as tracked files.
4. Run a trusted production deployment with the configured GitHub variables/secrets.
5. Confirm fork/PR-triggered workflows cannot deploy or access production credentials.

## 8. Final publication sequence

Immediately before changing visibility:

1. Re-run current-tree and full-history secret/privacy scans.
2. Check retained branches/tags.
3. Review Actions artifacts/logs and GitHub discussion content.
4. Confirm public website media/contact information is intentionally publishable and image metadata is acceptable.
5. **Delete issue #66 rather than merely closing it.**
6. Change repository visibility to public.

After publication, keep the `Public repository safety` workflow enabled so future pull requests and pushes are checked for regressions.
