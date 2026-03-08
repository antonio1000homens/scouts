# Website Deployment Summary

## ✅ Completed Setup

### 1. GitHub Actions Workflow
- **File**: `.github/workflows/deploy-to-s3.yml`
- **Status**: Updated and ready
- **Features**:
  - Deploys on push to `main` branch
  - Manual trigger available (workflow_dispatch)
  - Configures S3 bucket for static website hosting
  - Sets public read permissions
  - Syncs HTML, CSS, JS, fonts, and images
  - Cache control headers for performance

### 2. IAM Policy Update
- **File**: `/home/windsor/github/lambdas/scouts/vsstudio-website-policy.json`
- **Status**: Created
- **New Permissions Added**:
  - `s3:PutBucketWebsite` - Enable static website hosting
  - `s3:GetBucketWebsite` - Check website configuration
  - `s3:PutBucketPolicy` - Set public read access policy
  - `s3:GetBucketPolicy` - View bucket policy
  - `s3:PutBucketPublicAccessBlock` - Allow public access

### 3. Deployment Scripts
Created two helper scripts:

**setup-website-hosting.sh**
- One-time S3 bucket configuration
- Enables static website hosting
- Sets public access permissions
- Creates bucket policy

**deploy-website.sh**
- Manual deployment script
- Syncs web files to S3
- Same behavior as GitHub Action

### 4. Documentation
- **File**: `WEBSITE-DEPLOYMENT.md`
- Complete guide covering setup, deployment, and troubleshooting

## 🔧 Next Steps to Complete Deployment

### Step 1: Update IAM Policy (Required)

Upload the new policy to AWS Console:

1. Open AWS Console → IAM → Users → `vsstudio`
2. Click on the `vsstudio-deploy-policy`
3. Click "Edit policy" → JSON tab
4. Copy content from: `/home/windsor/github/lambdas/scouts/vsstudio-website-policy.json`
5. Paste and save

**Why?** Adds S3 website hosting and bucket policy permissions.

### Step 2: Configure S3 Bucket (One-Time)

Run the setup script:

```bash
cd /home/windsor/github/scouts
./setup-website-hosting.sh
```

This configures the S3 bucket for static website hosting.

### Step 3: Set GitHub Secrets

Add AWS credentials to GitHub repository:

1. Go to: https://github.com/antonio1000homens/nfc/settings/secrets/actions
2. Click "New repository secret"
3. Add two secrets:
   - Name: `AWS_ACCESS_KEY_ID`
     Value: [your vsstudio access key ID]
   - Name: `AWS_SECRET_ACCESS_KEY`
     Value: [your vsstudio secret access key]

### Step 4: Test Deployment

Option A - GitHub Action (recommended):
```bash
cd /home/windsor/github/scouts
git add .
git commit -m "Add website deployment workflow"
git push origin main
```

Option B - Manual deployment:
```bash
cd /home/windsor/github/scouts
./deploy-website.sh
```

### Step 5: Verify Website

Once deployed, visit:
```
http://2ndtolworth.s3-website.eu-west-2.amazonaws.com
```

## 📁 Files Deployed to S3

The workflow deploys these files:

```
2ndtolworth bucket:
├── index.html
├── component-preview.html
├── styles.css
├── fonts/
│   ├── fonts.css
│   └── [font files]
├── images/
│   └── [image files]
├── scouts-img/
│   └── [scout images]
├── scripts/
│   └── calendar-render.js
├── 2tolworthcub_booklet_html/
│   └── [9 HTML pages]
├── agenda.json (from Lambda)
└── programme.json (from Lambda)
```

## 🔄 How It Works Together

1. **Lambda Function** (automated):
   - Runs periodically (or on trigger)
   - Fetches OSM calendar data
   - Writes `agenda.json` and `programme.json` to S3

2. **Static Website** (this deployment):
   - Deployed via GitHub Actions on push
   - HTML pages load from S3
   - JavaScript fetches `agenda.json` and `programme.json`
   - Renders calendar events dynamically

## 🎯 Website URL

**Primary Access:**
```
http://2ndtolworth.s3-website.eu-west-2.amazonaws.com
```

**Optional Future Enhancement:**
- Set up custom domain (e.g., scouts.2ndtolworth.org)
- Use Route 53 for DNS
- Add CloudFront CDN for HTTPS and global distribution

## 🔍 Monitoring & Verification

**Check deployment status:**
```bash
# List files in S3
aws s3 ls s3://2ndtolworth/ --recursive

# Test website access
curl -I http://2ndtolworth.s3-website.eu-west-2.amazonaws.com

# Check bucket policy
aws s3api get-bucket-policy --bucket 2ndtolworth

# Check website configuration
aws s3api get-bucket-website --bucket 2ndtolworth
```

**GitHub Actions:**
- View workflow runs: https://github.com/antonio1000homens/nfc/actions
- Check deployment logs for errors
- Manual trigger available from Actions tab

## 💰 Cost Estimate

Expected monthly AWS costs:

| Service | Usage | Cost |
|---------|-------|------|
| S3 Storage | ~50 MB | < $0.01 |
| S3 Requests | ~1000 GET/month | < $0.01 |
| Data Transfer | ~500 MB/month | ~$0.05 |
| Lambda | ~100 invocations | Free tier |
| **Total** | | **< $0.10/month** |

## 🛡️ Security Configuration

- ✅ Bucket allows public read for website files
- ✅ Lambda has write permissions via IAM role
- ✅ GitHub Actions uses IAM user credentials
- ✅ No sensitive data exposed (all scout info is public)
- ✅ Bucket policy restricts to read-only access

## 📝 Quick Reference

| Action | Command |
|--------|---------|
| Setup bucket | `./setup-website-hosting.sh` |
| Deploy website | `./deploy-website.sh` |
| View files | `aws s3 ls s3://2ndtolworth/ --recursive` |
| Website URL | http://2ndtolworth.s3-website.eu-west-2.amazonaws.com |
| GitHub Actions | https://github.com/antonio1000homens/nfc/actions |

## ✨ What's New

Compared to the original workflow:
1. ✅ Fixed bucket name (was `2ntolworth`, now `2ndtolworth`)
2. ✅ Added static website hosting configuration
3. ✅ Added bucket policy for public read access
4. ✅ Only syncs web files (not entire repo)
5. ✅ Added cache control headers
6. ✅ Added manual trigger option
7. ✅ Added deployment success message with URL
8. ✅ Created helper scripts for local deployment
9. ✅ Added comprehensive documentation
