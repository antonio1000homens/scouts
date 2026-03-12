# CloudFront Infrastructure

## Overview

The 2ndtolworth.org.uk CloudFront distribution is managed via CloudFormation.

- **Stack Name**: scouts-cloudfront
- **Template**: `cloudfront-stack.yaml`
- **AWS Profile**: `scouts`
- **Certificate Region**: `us-east-1`

## Cache Behaviors

The distribution has specific no-cache behaviors for:
- `/agenda.json` - Calendar data
- `/runtime/*` - Runtime configuration
- `/events/*` - Event images and data

These paths use cache policy `f6072fdc-ae27-4d49-a206-4f2a80c82fbe` (no-cache).

## First-Time Setup In The Scouts Account

1. Request the ACM certificate in `us-east-1`:
   ```bash
   AWS_PROFILE=scouts bash request-acm-certificate.sh
   ```
2. Add the returned DNS validation CNAME in Cloudflare.
3. Wait for the certificate to reach `ISSUED`.
4. Deploy CloudFront:
   ```bash
   AWS_PROFILE=scouts CERTIFICATE_ARN=<issued-us-east-1-cert-arn> ENABLE_ALIAS=false bash deploy-cloudfront.sh
   ```
5. Update the GitHub secret `CLOUDFRONT_DISTRIBUTION_ID` in `antonio1000homens/scouts`.
6. When you are ready for cutover, remove `2ndtolworth.org.uk` from the old distribution and redeploy with:
   ```bash
   AWS_PROFILE=scouts CERTIFICATE_ARN=<issued-us-east-1-cert-arn> ENABLE_ALIAS=true bash deploy-cloudfront.sh
   ```

## Updating CloudFront

To modify the distribution:

1. Edit `cloudfront-stack.yaml`
2. Update the stack:
   ```bash
   AWS_PROFILE=scouts aws cloudformation update-stack \
     --stack-name scouts-cloudfront \
     --template-body file://cloudfront-stack.yaml \
     --parameters ParameterKey=CertificateArn,ParameterValue=<issued-us-east-1-cert-arn>
   ```
3. Wait for deployment:
   ```bash
   AWS_PROFILE=scouts aws cloudformation wait stack-update-complete --stack-name scouts-cloudfront
   ```

## Importing Existing Distribution

If the distribution needs to be imported into CloudFormation in an account that already owns it:

```bash
bash import-cloudfront.sh
```

## GitHub Actions Integration

The deploy workflow automatically invalidates CloudFront cache after S3 deployment using the `CLOUDFRONT_DISTRIBUTION_ID` secret.
