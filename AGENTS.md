# Scouts Agent Notes

## Prompt Configuration Source Of Truth

- `scouts.conf` lives in this repo at:
  `/Users/antoniofreire/storage/github/scouts/lambdas/scouts/scouts.conf`
- That file is the source of truth for Scouts prompt configuration.
- It is deployed to S3 as `s3://scouts-2ndtolworth-prod-553490163883/scouts.conf`.
- Local Bitwarden secret UUID mappings belong in `lambdas/scouts/.env`, which should remain untracked; use `lambdas/scouts/.env.example` as the template.

## AWS Profiles

- Use `AWS_PROFILE=scouts` for Scouts AWS account `553490163883`.
- Use `AWS_PROFILE=windsor` for Windsor AWS account `243857182133`.
- Do not rely on the default AWS profile for work in this repo.
- Do not rely on the default AWS profile for work in this repo.

## Who Uses `scouts.conf`

- The Scouts runtime loads the active configuration from S3 key `scouts.conf`.
- The Scouts admin UI reads the deployed S3 root copy at `/scouts.conf` so it can build the same full image-generation prompt as the lambda.

## Working Rules

- When changing prompt wording, prompt templates, image prompt specifications, or image theme guidelines, update the `scouts` repo copy of `scouts.conf` first.
- Do not reintroduce hardcoded prompt-template fallbacks in code unless explicitly requested.
- If prompt behavior differs between the admin UI and the deployed runtime, check `scouts.conf` in S3 and the `scouts` repo copy before changing code.
- Do not recreate a separate root `scouts.conf` in the `scouts` repo.

## CloudFront Infrastructure

- CloudFront distribution `E3INLSADL3AN6C` is now managed in the Scouts AWS account by CloudFormation stack `scouts-cloudfront`.
- CloudFront domain: `d1wv092irxi2lt.cloudfront.net`
- Template: `scouts/cloudfront-stack.yaml`
- Cache behaviors configured for no-cache on:
  - `/agenda.json`
  - `/runtime/*`
  - `/events/*`
- To update CloudFront: modify `cloudfront-stack.yaml` and use `AWS_PROFILE=scouts`.
- Do NOT manually update CloudFront distribution via console or CLI - use CloudFormation.

## Deployment Notes

- `scouts/deploy.sh website` uploads `lambdas/scouts/scouts.conf` to `s3://scouts-2ndtolworth-prod-553490163883/scouts.conf`.
- `scouts/deploy-manual.sh` is a compatibility wrapper around `./deploy.sh website`.
- GitHub Actions in this repo now own Scouts website, queue, Lambda, and Scouts Slack-handler deployments.
