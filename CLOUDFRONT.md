# CloudFront Infrastructure

## Overview

The 2ndtolworth.org.uk CloudFront distribution is managed via CloudFormation.

- **Distribution ID**: E3I6EACBCFE736
- **Stack Name**: scouts-cloudfront
- **Template**: `cloudfront-stack.yaml`

## Cache Behaviors

The distribution has specific no-cache behaviors for:
- `/agenda.json` - Calendar data
- `/runtime/*` - Runtime configuration
- `/events/*` - Event images and data

These paths use cache policy `f6072fdc-ae27-4d49-a206-4f2a80c82fbe` (no-cache).

## Updating CloudFront

To modify the distribution:

1. Edit `cloudfront-stack.yaml`
2. Update the stack:
   ```bash
   aws cloudformation update-stack \
     --stack-name scouts-cloudfront \
     --template-body file://cloudfront-stack.yaml
   ```
3. Wait for deployment:
   ```bash
   aws cloudformation wait stack-update-complete --stack-name scouts-cloudfront
   ```

## Importing Existing Distribution

If the distribution needs to be imported into CloudFormation:

```bash
bash import-cloudfront.sh
```

This requires CloudFormation permissions in the vsstudio-policy.

## GitHub Actions Integration

The deploy workflow automatically invalidates CloudFront cache after S3 deployment using the `CLOUDFRONT_DISTRIBUTION_ID` secret.
