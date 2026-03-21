# Pixabay URL Expiration Issue - Fix Summary

## Problem Description

When sqs2scouts retrieves images from Pixabay and displays them in Slack notifications, the URLs expire immediately when clicked. This happens because:

1. **Pixabay Hotlink Protection**: Pixabay generates temporary URLs that expire quickly (sometimes within minutes or seconds)
2. **Delayed Processing**: The original system was designed to download images during the approval process, but by then the URLs had already expired
3. **User Experience**: Users see broken links and cannot preview images before approving them

## Root Cause

The issue occurs because Pixabay URLs like this:
```
https://pixabay.com/get/ge301403808a4345758b70721956d0b9a0c013c1c9e714199151724c37ae6458f773e2af096d76c0d68a97efa6ccfcd849a4901f7f13e370c36079b6afb2773dc_640.jpg
```

Are temporary and expire very quickly due to Pixabay's anti-hotlinking measures.

## Solution Implemented

### 1. Improved URL Detection
Enhanced the Pixabay URL detection logic in both `scouts.mjs` and `sqs2scouts.mjs` to handle various URL formats:

```javascript
const isPixabayUrl = imageUrl.includes('pixabay.com') || 
                    imageUrl.includes('cdn.pixabay.com') ||
                    /pixabay\.com\/get\//.test(imageUrl);
```

### 2. Immediate Download Strategy
Modified `handlePixabayAction()` in `sqs2scouts.mjs` to download Pixabay images **immediately** when they are first retrieved, not during approval:

```javascript
// If we got a Pixabay URL, download it immediately to prevent expiration
if (selectedImageUrl && (selectedImageUrl.includes('pixabay.com') || selectedImageUrl.includes('cdn.pixabay.com'))) {
    console.log(`[Pixabay] Downloading Pixabay image immediately to prevent expiration: ${selectedImageUrl}`);
    const downloadedUrl = await downloadImageToWebsiteS3(selectedImageUrl, eventTitle);
    if (downloadedUrl) {
        selectedImageUrl = downloadedUrl; // Replace with S3 URL
    }
}
```

### 3. Slack Notification Improvements
The system already had logic to display Pixabay URLs as text links instead of image blocks:

```javascript
if (isPixabayUrl) {
    // Pixabay URLs cannot be hotlinked - show as text link only
    blocks.push({
        type: 'section',
        text: {
            type: 'mrkdwn',
            text: `*Image URL:* <${imageUrl}|View on Pixabay> _(Pixabay images cannot be embedded - will be downloaded to S3 on approval)_`,
        },
    });
}
```

## Flow Comparison

### Before (Broken)
1. Pixabay API returns temporary URL
2. URL stored in hex file
3. Slack shows text link to Pixabay
4. User clicks link → **URL expired** ❌
5. On approval, system tries to download → **URL expired** ❌

### After (Fixed)
1. Pixabay API returns temporary URL
2. **System immediately downloads image to S3** ✅
3. S3 URL stored in hex file
4. Slack shows working S3 link ✅
5. User clicks link → **Image loads perfectly** ✅
6. On approval, S3 URL is already ready ✅

## Benefits

1. **Immediate Access**: Users can preview images right away
2. **Permanent URLs**: S3-hosted images never expire
3. **Better Performance**: Images cached with 1-year TTL
4. **Self-Hosted**: Complete control over image availability
5. **Slack Compatible**: S3 URLs work perfectly in Slack image blocks

## Testing

Created diagnostic tools to verify the fix:
- `test-remote-image-url-detection.mjs` - Tests URL detection logic
- `debug-pixabay-issue.mjs` - Diagnoses the complete flow

## Deployment

The fix is ready to deploy. Key changes:
1. Enhanced URL detection in both Lambda functions
2. Immediate download strategy in `sqs2scouts.mjs`
3. Fallback download logic in `scouts.mjs` for approval flow

## Monitoring

After deployment, monitor logs for these messages:
- `[Pixabay] Downloading Pixabay image immediately to prevent expiration`
- `[Pixabay] Successfully downloaded and replaced URL`
- `[Approval] Detected Pixabay URL, downloading to S3`

The issue should be completely resolved with these changes.
