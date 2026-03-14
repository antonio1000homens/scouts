# Quick Reference - Scouts Lambda Deployment

## First Time Deployment

```bash
./deploy.sh
```

This single command will handle everything:
- Create S3 bucket
- Build and publish Lambda layer
- Create IAM role
- Deploy Lambda function
- Test deployment

## Common Tasks

### Update function code only
```bash
./update-function.sh
```

### Rebuild and update layer
```bash
./update-layer.sh
```

### Test the function
```bash
./test-function.sh
```

### View S3 contents
```bash
./view-s3.sh
```

## Direct AWS CLI Commands

### Invoke function
```bash
aws lambda invoke --function-name scouts --region eu-west-2 output.json
```

### View logs
```bash
aws logs tail /aws/lambda/scouts --follow --region eu-west-2
```

### List S3 objects
```bash
aws s3 ls s3://2ndtolworth/
```

### Download S3 objects
```bash
aws s3 cp s3://2ndtolworth/events.json events.json
aws s3 cp s3://2ndtolworth/programme.json programme.json
```

### Update environment variables
```bash
aws lambda update-function-configuration \
  --function-name scouts \
  --environment "Variables={
      TARGET_BUCKET=2ndtolworth,
      EVENTS_OBJECT_KEY=events.json,
      PROGRAMME_OBJECT_KEY=programme.json,
      GEMINI_API_KEY=your_gemini_api_key
  }" \
  --region eu-west-2
```

> **Note**: The `GEMINI_API_KEY` is optional but required for AI-generated event taglines. Get your API key from [Google AI Studio](https://makersuite.google.com/app/apikey).

### Get function info
```bash
aws lambda get-function --function-name scouts --region eu-west-2
```

### List layer versions
```bash
aws lambda list-layer-versions --layer-name scouts-shared --region eu-west-2
```

## Configuration

Default values (can be customized in scripts):
- **Function name**: scouts
- **Layer name**: scouts-shared
- **Bucket name**: 2ndtolworth
- **Region**: eu-west-2
- **Runtime**: nodejs24.x
- **Role name**: scouts-lambda-role

## Files Created

- `deploy.sh` - Full deployment script
- `update-function.sh` - Update function code
- `update-layer.sh` - Rebuild and publish layer
- `test-function.sh` - Test the function
- `view-s3.sh` - View S3 bucket contents
- `DEPLOYMENT.md` - Detailed deployment guide

## Troubleshooting

### Check function status
```bash
aws lambda get-function-configuration --function-name scouts --region eu-west-2
```

### View recent errors
```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/scouts \
  --filter-pattern "ERROR" \
  --region eu-west-2
```

### Verify IAM permissions
```bash
aws iam get-role-policy --role-name scouts-lambda-role --policy-name ScoutsS3Access
```

### Test S3 access
```bash
aws s3 ls s3://2ndtolworth/ --region eu-west-2
```
