# Pixabay Image Download to S3

## Overview

This update modifies the Pixabay image handling to address the issue where Pixabay images cannot be hotlinked (embedded directly in Slack notifications). The solution:

1. **Display Pixabay URLs as text** in Slack notifications (not as image blocks)
2. **Download images to S3** when approval occurs
3. **Replace Pixabay URL** with S3-hosted URL in hex files

## Problem

Pixabay's terms of service prevent hotlinking their images. When we tried to display Pixabay image URLs directly in Slack, they would fail to load. This made it difficult for users to preview images before approving them.

## Solution

### 1. Slack Notifications (sqs2scouts)

When a Pixabay image URL is detected in the notification:
- Display it as a clickable text link (not an image block)
- Add a note that the image will be downloaded to S3 on approval
- Users can click the link to view the image on Pixabay's website

**Example Slack message:**
```
*Image URL:* View on Pixabay (Pixabay images cannot be embedded - will be downloaded to S3 on approval)
```

### 2. Approval Flow (scouts)

When a user approves an event with a Pixabay image URL:
1. Detect if the image URL is from Pixabay
2. Download the image file
3. Upload to S3 bucket in `images/` directory
4. Generate S3 website URL: `http://2ndtolworth.s3-website.eu-west-2.amazonaws.com/images/...`
5. Replace the Pixabay URL with the S3 URL in the hex file

**Result:** The hex file now references a stable, self-hosted image that can be embedded anywhere.

## Technical Details

### Download Function

The `downloadImageToS3()` function:
- Fetches images from any HTTP(S) URL
- Detects content type and uses appropriate file extension (jpg, png, gif, webp, svg)
- Sanitizes event title for safe filename
- Adds timestamp to prevent collisions
- Uploads to S3 with public caching (1 year)
- Returns S3 website endpoint URL

### Filename Pattern

Images are saved with the pattern:
```
images/{sanitized-title}-{timestamp}.{ext}
```

Examples:
- `images/scout-camp-weekend-1697123456789.jpg`
- `images/laser-tag-event-1697234567890.png`

### S3 Configuration

Images are stored with:
- **Bucket:** `2ndtolworth` (or `TARGET_BUCKET` env var)
- **Path:** `images/{filename}`
- **ContentType:** Detected from source (image/jpeg, image/png, etc.)
- **CacheControl:** `public, max-age=31536000` (1 year)
- **Access:** Public via S3 website endpoint

### URL Format

The S3 website endpoint URL format:
```
http://{bucket}.s3-website.{region}.amazonaws.com/{key}
```

Example:
```
http://2ndtolworth.s3-website.eu-west-2.amazonaws.com/images/scout-camp-weekend-1697123456789.jpg
```

## Testing

Unit tests are provided in `scouts/function/tests/test-pixabay-download.mjs`:

Run tests:
```bash
cd scouts
node function/tests/test-pixabay-download.mjs
```

Tests cover:
- ✅ Pixabay URL detection
- ✅ S3 URL construction
- ✅ Filename sanitization
- ✅ Content type to extension mapping
- ✅ Approval flow integration

## Files Changed

1. **scouts/sqs/sqs2scouts/function/sqs2scouts.mjs**
   - Modified `buildApprovalBlocks()` to detect Pixabay URLs
   - Display Pixabay URLs as text links instead of image blocks

2. **scouts/function/scouts.mjs**
   - Added `downloadImageToS3()` function
   - Modified approval handler to download Pixabay images
   - Replace Pixabay URLs with S3 URLs in hex files

3. **scouts/function/tests/test-pixabay-download.mjs** (new)
   - Comprehensive unit tests for the download functionality

## Deployment

The changes are backward compatible. Existing URLs will continue to work, and only new approvals with Pixabay URLs will trigger the download process.

### Required Permissions

The Lambda function needs S3 write permissions:
```json
{
  "Effect": "Allow",
  "Action": [
    "s3:PutObject"
  ],
  "Resource": "arn:aws:s3:::2ndtolworth/images/*"
}
```

### S3 Bucket Configuration

Ensure the S3 bucket is configured as a static website:
```bash
aws s3 website s3://2ndtolworth/ \
  --index-document index.html \
  --error-document error.html
```

Make the `images/` directory publicly readable:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::2ndtolworth/images/*"
    }
  ]
}
```

## Future Enhancements

Possible improvements:
1. Add image resizing/optimization before upload
2. Support additional image sources with similar restrictions
3. Add cleanup job to remove old images
4. Add image metadata (alt text, attribution) to hex files
5. Generate thumbnail versions for faster loading
