# Image Download Approval Flow

## Before

```text
Admin submits a remote image URL
  ->
Event stores the external URL directly
  ->
That URL can expire, block embedding, or disappear
```

## After

```text
Admin submits a remote image URL
  ->
sqs2scouts downloads the asset
  ->
Image is uploaded to S3
  ->
Event image URL is replaced with the S3-hosted URL
```

## Flow Detail

### 1. Admin Persist

The admin page submits `imageUrl` through the persist route.

### 2. Download

`sqs2scouts` treats the remote URL as a download source and fetches the image bytes.

### 3. Upload

The image is written to:

```text
s3://2ndtolworth/images/event-name-1697123.jpg
```

### 4. Replace URL

The persisted event data is rewritten to:

```text
http://2ndtolworth.s3-website.eu-west-2.amazonaws.com/images/event-name-1697123.jpg
```

## Result

Benefits:

1. The stored event image URL is stable
2. The image is under your control
3. Downstream consumers only need to render your S3 URL
4. The download flow is source-agnostic and not tied to Pixabay
