# Cloudflare deployment contract

## Authority

GitHub Actions is the sole production deployment authority for Scouts Cloudflare Workers.

The canonical workflow is:

```text
pull request
  -> plan and validate
  -> no production deployment

merge/push to master
  -> detect changed components
  -> deploy selected components
  -> deploy Cloudflare Workers only when cloudflare/* changed
```

The repository workflow is `.github/workflows/deploy-to-s3.yml`.

## Workers Builds / Git integration

Cloudflare Workers Builds must not be connected to this repository while GitHub Actions owns deployment.

A connected Cloudflare Git integration can build or deploy independently of the repository's change planner. PR #157 demonstrated this: a website-only change correctly skipped the GitHub Actions Cloudflare deployment lane, while the Cloudflare GitHub App still ran a `Workers Builds: scouts-admin-proxy` build.

The Cloudflare Git integration was disconnected on 27 September 2026. A subsequent merge/push to `master` was verified to start only the repository's GitHub Actions workflows, with no `Workers Builds: ...` check from the Cloudflare GitHub App.

If Workers Builds is ever reconnected, disconnect it again under Cloudflare Dashboard -> Workers & Pages -> Worker -> Settings -> Builds. GitHub Actions must remain the only automatic production deployment path.

The removed `cloudflare/wrangler.toml` existed only to support the legacy Workers Builds project. The canonical Worker configurations remain inside their Worker directories.

## Pull requests

Pull requests may:

- detect which components would be affected;
- run repository tests and safety checks;
- validate Worker source/configuration.

Pull requests must not:

- deploy the website;
- deploy AWS resources;
- deploy Cloudflare Workers.

The deployment workflow enforces this by excluding `pull_request` events from `deploy-web` and `deploy-aws`.

## Production deployment

On a push/merge to `master`:

- changes under `cloudflare/*` set the Cloudflare deployment target;
- `deploy-web` installs Wrangler;
- deployment credentials are resolved by the workflow;
- `cloudflare/scouts-admin-proxy/deploy-ci.sh` deploys the admin proxy;
- `cloudflare/scouts-slack-handler/deploy-ci.sh` deploys the Slack handler.

This keeps Worker deployment in the same audit trail and change-selection model as the rest of the Scouts stack.

## Manual deployment

The Worker-specific README files document local/manual Wrangler deployment for recovery and debugging. Manual deployment is an operational escape hatch, not an additional automatic deployment authority.
