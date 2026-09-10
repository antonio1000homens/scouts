# Scouts Agent Notes

## Prompt configuration source of truth

- `lambdas/scouts/scouts.conf` is the source of truth for Scouts prompt configuration.
- The deployed runtime copy is written to the configured website/runtime bucket as `scouts.conf`.
- Local Bitwarden secret UUID mappings belong in `lambdas/scouts/.env`, which must remain untracked; use `lambdas/scouts/.env.example` as the template.

## AWS configuration

- Local AWS profile selection is developer-specific. Set `AWS_PROFILE` (or the script-specific profile override) explicitly in local shell configuration rather than documenting a personal profile name in this repository.
- CI deployments should use GitHub Actions OIDC with `AWS_ROLE_TO_ASSUME` rather than long-lived AWS access keys.
- Deployment-specific account IDs, bucket names, queue URLs/ARNs and resource identifiers may be supplied through GitHub Environment/repository variables or explicit environment variables.
- Do not rely on an implicit/default AWS profile for production work.

## Who uses `scouts.conf`

- The Scouts runtime loads the active configuration from S3 key `scouts.conf`.
- The Scouts admin UI reads the deployed root copy at `/scouts.conf` so it can build the same full image-generation prompt as the Lambda.

## Working rules

- When changing prompt wording, prompt templates, image prompt specifications, or image theme guidelines, update `lambdas/scouts/scouts.conf` first.
- Do not reintroduce hard-coded prompt-template fallbacks unless explicitly requested.
- If prompt behavior differs between the admin UI and the deployed runtime, compare the deployed `scouts.conf` with the repository copy before changing code.
- Do not recreate a separate root `scouts.conf`.
- Never commit `.env` files, Wrangler local state, copied production payloads, private calendar/feed URLs, signed URLs, credentials, personal contact details, or generated diagnostic dumps.

## CloudFront infrastructure

- CloudFront is managed by CloudFormation using `scouts/cloudfront-stack.yaml`.
- Cache behaviors include no-cache handling for `/agenda.json`, `/runtime/*`, and `/events/*`.
- Update CloudFront through CloudFormation rather than manual console/CLI edits.
- Distribution-specific IDs/domains should be treated as deployment configuration where they are not intentionally part of public website documentation.

## Deployment notes

- `deploy.sh website` uploads `lambdas/scouts/scouts.conf` to the configured website bucket.
- `deploy-manual.sh` is a compatibility wrapper around `./deploy.sh website`.
- GitHub Actions own Scouts website, queue, Lambda, and Scouts Slack-handler deployments.
- Production deployment jobs must not run for untrusted pull requests/forks.
- The `scouts-function` deployment must not run ahead of `deploy-scouts-image-enrich` when the image-enrich state machine is part of the same rollout.
- The `scouts-lambda` stack treats `ImageEnrichStateMachineArn` as optional until the state machine output is available.

## Public repository hygiene

- Test fixtures must be synthetic/anonymised rather than exports copied from OSM, AWS, Slack, or another production system.
- Keep non-secret deployment configuration outside source where practical, but do not treat ordinary ARNs/account IDs as credentials.
- Real secrets belong in GitHub Secrets, Bitwarden, AWS SSM Parameter Store, or AWS Secrets Manager.
- Run the repository secret/privacy checks before changing repository visibility.
