# Scouts AWS Account Bootstrap

This stack bootstraps the new Scouts AWS account `553490163883` with:

- GitHub OIDC provider for Actions
- `ScoutsBootstrapAdminRole`
- `GitHubActionsScoutsDeployRole`
- `GitHubActionsLambdasDeployRole`
- `CloudFormationExecutionRole`
- artifact bucket `aws2022-lambda-code-eu-west-2-553490163883`

## Usage

Assume an admin-capable identity in account `553490163883`, then run:

```bash
cd scouts/aws/bootstrap
BOOTSTRAP_PRINCIPAL_ARN=arn:aws:iam::553490163883:role/YourAdminRole ./deploy.sh
```

If your bootstrap principal is an IAM user or an AWS Identity Center-managed role, pass that ARN instead.

## Outputs

Use the output role ARNs to set:

- `antonio1000homens/scouts` repository variable `AWS_ROLE_TO_ASSUME`
- `antonio1000homens/lambdas` repository variable `AWS_ROLE_TO_ASSUME`
- repository variable `CLOUDFORMATION_ROLE_ARN` in both repos

The artifact bucket output should be used as `CODE_BUCKET` for the Scouts lambda deploy jobs.
