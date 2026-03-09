# Scouts Agent Notes

## Prompt Configuration Source Of Truth

- `scouts.conf` lives in the lambdas repo at:
  `/Users/antoniofreire/storage/github/lambdas/scouts/sqs/sqs2scouts/scouts.conf`
- That file is the source of truth for Scouts prompt configuration.
- It is deployed to S3 as `s3://2ndtolworth/scouts.conf`.

## Who Uses `scouts.conf`

- `sqs2scouts` loads the active runtime configuration from S3 key `scouts.conf`.
- The Scouts admin UI also reads `scouts.conf` from the website root so it can build the same full image-generation prompt as the lambda.

## Working Rules

- When changing prompt wording, prompt templates, image prompt specifications, or image theme guidelines, update the lambdas repo copy of `scouts.conf` first.
- Keep the website copy at `/Users/antoniofreire/storage/github/scouts/scouts.conf` in sync when the admin UI needs the same configuration locally.
- Do not reintroduce hardcoded prompt-template fallbacks in code unless explicitly requested.
- If prompt behavior differs between the admin UI and `sqs2scouts`, check `scouts.conf` in S3 and the two repo copies before changing code.

## Deployment Notes

- `lambdas/scouts/sqs/sqs2scouts/deploy.sh` uploads `scouts.conf` to S3 during lambda deploys.
- `scouts/deploy-manual.sh` can also upload `scouts.conf` to `s3://2ndtolworth/scouts.conf`.
