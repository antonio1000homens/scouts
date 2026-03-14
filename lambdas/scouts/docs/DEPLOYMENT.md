# Scouts Lambda Deployment Guide

This guide provides step-by-step instructions for deploying the Scouts Lambda function to AWS.

## Prerequisites

- AWS CLI installed and configured (`aws configure`)
- Node.js and npm installed
- Appropriate AWS permissions (IAM, Lambda, S3)

## Quick Deployment

The easiest way to deploy everything is to use the automated deployment script:

```bash
chmod +x deploy.sh
./deploy.sh
```

This script will:
1. Create the S3 bucket (if it doesn't exist)
2. Build and publish the Lambda layer
3. Create the IAM role (if needed)
4. Package and deploy the Lambda function
5. Test the deployment
6. Verify S3 objects were created

## Manual Deployment Steps

If you prefer to deploy manually or need to customize the process:

### 1. Create S3 Bucket

```bash
aws s3api create-bucket \
    --bucket 2ndtolworth \
    --region eu-west-2 \
    --create-bucket-configuration LocationConstraint=eu-west-2
```

### 2. Build Lambda Layer

```bash
cd lambda-layer/nodejs
npm install --production
cd ..
zip -r lambda-layer.zip nodejs
```

### 3. Publish Lambda Layer

```bash
aws lambda publish-layer-version \
    --layer-name scouts-shared \
    --zip-file fileb://lambda-layer/lambda-layer.zip \
    --compatible-runtimes nodejs24.x \
    --region eu-west-2
```

Note the `LayerVersionArn` from the output - you'll need it in step 6.

### 4. Create IAM Role

Create a trust policy file (`trust-policy.json`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

Create the role:

```bash
aws iam create-role \
    --role-name scouts-lambda-role \
    --assume-role-policy-document file://trust-policy.json
```

Attach the basic Lambda execution policy:

```bash
aws iam attach-role-policy \
    --role-name scouts-lambda-role \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

Create S3 access policy file (`s3-policy.json`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl"
      ],
      "Resource": "arn:aws:s3:::2ndtolworth/*"
    }
  ]
}
```

Attach the S3 policy:

```bash
aws iam put-role-policy \
    --role-name scouts-lambda-role \
    --policy-name ScoutsS3Access \
    --policy-document file://s3-policy.json
```

### 5. Package Lambda Function

```bash
zip scouts-lambda.zip scouts.mjs
```

### 6. Create Lambda Function

Replace `<ACCOUNT_ID>` with your AWS account ID and `<LAYER_VERSION>` with the version from step 3:

```bash
aws lambda create-function \
    --function-name scouts \
    --runtime nodejs24.x \
    --role arn:aws:iam::<ACCOUNT_ID>:role/scouts-lambda-role \
    --handler scouts.handler \
    --zip-file fileb://scouts-lambda.zip \
    --layers arn:aws:lambda:eu-west-2:<ACCOUNT_ID>:layer:scouts-shared:<LAYER_VERSION> \
    --region eu-west-2 \
    --timeout 30 \
    --memory-size 256 \
    --environment "Variables={TARGET_BUCKET=2ndtolworth,EVENTS_OBJECT_KEY=events.json,PROGRAMME_OBJECT_KEY=programme.json}"
```

### 7. Test the Function

```bash
aws lambda invoke \
    --function-name scouts \
    --region eu-west-2 \
    output.json

cat output.json
```

### 8. Verify S3 Objects

```bash
aws s3 ls s3://2ndtolworth/
aws s3 cp s3://2ndtolworth/events.json - | jq .
aws s3 cp s3://2ndtolworth/programme.json - | jq .
```

## Update Existing Deployment

### Update Lambda Layer

```bash
cd lambda-layer/nodejs
npm install --production
cd ..
zip -r lambda-layer.zip nodejs

aws lambda publish-layer-version \
    --layer-name scouts-shared \
    --zip-file fileb://lambda-layer/lambda-layer.zip \
    --compatible-runtimes nodejs24.x \
    --region eu-west-2
```

### Update Lambda Function Code

```bash
zip scouts-lambda.zip scouts.mjs

aws lambda update-function-code \
    --function-name scouts \
    --zip-file fileb://scouts-lambda.zip \
    --region eu-west-2
```

### Update Lambda Function Configuration

```bash
aws lambda update-function-configuration \
    --function-name scouts \
    --layers arn:aws:lambda:eu-west-2:<ACCOUNT_ID>:layer:scouts-shared:<NEW_LAYER_VERSION> \
    --environment "Variables={TARGET_BUCKET=2ndtolworth,EVENTS_OBJECT_KEY=events.json,PROGRAMME_OBJECT_KEY=programme.json}" \
    --region eu-west-2
```

## Environment Variables

You can add optional environment variables when creating or updating the function:

```bash
aws lambda update-function-configuration \
    --function-name scouts \
    --environment "Variables={
        TARGET_BUCKET=2ndtolworth,
        EVENTS_OBJECT_KEY=events.json,
        PROGRAMME_OBJECT_KEY=programme.json,
  # OSM credentials are no longer required for public ICS feeds.
  # If you need to access protected OSM feeds, provide pre-authorised URLs or proxy the request.
    }" \
    --region eu-west-2
```

## Useful Commands

### View Lambda logs

```bash
aws logs tail /aws/lambda/scouts --follow --region eu-west-2
```

### Delete the function

```bash
aws lambda delete-function --function-name scouts --region eu-west-2
```

### Delete a layer version

```bash
aws lambda delete-layer-version \
    --layer-name scouts-shared \
    --version-number <VERSION> \
    --region eu-west-2
```

### List all layer versions

```bash
aws lambda list-layer-versions \
    --layer-name scouts-shared \
    --region eu-west-2
```

## Troubleshooting

### Function times out
Increase the timeout value:
```bash
aws lambda update-function-configuration \
    --function-name scouts \
    --timeout 60 \
    --region eu-west-2
```

### Permission errors
Verify the IAM role has the correct policies attached:
```bash
aws iam list-attached-role-policies --role-name scouts-lambda-role
aws iam list-role-policies --role-name scouts-lambda-role
```

### Layer not found
Verify the layer ARN and version:
```bash
aws lambda list-layer-versions --layer-name scouts-shared --region eu-west-2
```
