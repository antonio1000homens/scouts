# Image Download Flow

## Overview

This flow covers the admin-driven download path for image URLs supplied outside the Gemini generation route. The goal is to take a remote `imageUrl`, download the asset into S3, and replace the event's image URL with a stable bucket URL.

The current flow:

1. Admin submits or persists a remote `imageUrl`
2. `sqs2scouts` receives the persist payload
3. The remote image is downloaded to S3
4. The event JSON is updated to reference the S3-hosted URL

## Problem It Solves

Remote image URLs are not under our control. They can expire, block embedding, or disappear entirely. Persisting them directly makes the event data fragile.

## Current Download Flow

### 1. Persist Request

The admin page submits a `persist` request with an `imageUrl`.

### 2. Download During Persist

When `sqs2scouts` handles the persist request:

1. It reads the remote `imageUrl`
2. It downloads the image bytes
3. It uploads the image to `s3://<bucket>/images/...`
4. It replaces the original remote URL with the S3 URL

### 3. Stored Result

The HEX event file ends up with a stable URL that points at your own bucket rather than the external source.

## Technical Notes

### Download Function

`downloadImageToS3()`:

- accepts any HTTP(S) image URL
- detects content type and chooses an extension
- sanitizes the event title for filenames
- appends a timestamp to avoid collisions
- uploads to `images/`
- returns the S3 website URL

### Filename Pattern

```text
images/{sanitized-title}-{timestamp}.{ext}
```

Examples:

- `images/scout-camp-weekend-1697123456789.jpg`
- `images/laser-tag-event-1697234567890.png`

### URL Format

```text
http://{bucket}.s3-website.{region}.amazonaws.com/{key}
```

Example:

```text
http://2ndtolworth.s3-website.eu-west-2.amazonaws.com/images/scout-camp-weekend-1697123456789.jpg
```

## Testing

Unit tests are provided in `scouts/function/tests/test-image-download.mjs`.

Run:

```bash
cd scouts
node function/tests/test-image-download.mjs
```

Coverage:

- remote URL detection
- S3 URL construction
- filename sanitization
- content-type to extension mapping
- persist/download flow integration

## Files

1. `scouts/sqs/sqs2scouts/function/sqs2scouts.mjs`
2. `scouts/function/scouts.mjs`
3. `scouts/function/tests/test-image-download.mjs`

## Required Permissions

The Lambda needs S3 write access to the `images/` prefix:

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:PutObject"
  ],
  "Resource": "arn:aws:s3:::2ndtolworth/images/*"
}
```
