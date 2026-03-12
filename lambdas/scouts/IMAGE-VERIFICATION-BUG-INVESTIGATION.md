# Image Verification Bug Investigation

## Problem Statement
Scouts Lambda is incorrectly identifying images as "broken" and removing their URLs from hex files, even though the images actually exist in S3 at `s3://2ndtolworth/website/images/`.

## Evidence
1. **Images exist in S3**:
   ```bash
   aws s3 ls s3://2ndtolworth/website/images/
   # Shows: 34742066697265776f726b73206e69676874.jpg (50KB, uploaded 2025-10-17 21:21:03)
   ```

2. **HeadObject works correctly**:
   ```bash
   aws s3api head-object --bucket 2ndtolworth --key "website/images/34742066697265776f726b73206e69676874.jpg"
   # Returns: ContentLength: 50407, ContentType: image/jpeg
   ```

3. **Hex file shows URL as null**:
   ```json
   {
     "title": "4T fireworks night",
     "image": {
       "prompt": "4t fireworks night",
       "url": null
     }
   }
   ```

4. **Scouts log shows false positive**:
   ```json
   "brokenImages": [{
     "uid": "osm-scouts-event-1604303",
     "title": "4T fireworks night",
     "brokenUrl": "website/images/34742066697265776f726b73206e69676874.jpg"
   }]
   ```

## Root Cause Analysis

### Image URL Format
When sqs2scouts downloads images, it stores them with **relative paths**:
- **Storage location**: `s3://2ndtolworth/website/images/{hex}.jpg`
- **URL format in hex files**: `website/images/{hex}.jpg`

Example from `downloadImageToWebsiteS3()` (lines 909-1020):
```javascript
const s3Key = `website/images/${baseFilename}${extension}`;
// ...
const relativeUrl = s3Key;  // Returns: "website/images/hex.jpg"
return relativeUrl;
```

### Image Verification Logic
The `imageExistsInS3()` function (lines 1326-1372) had insufficient handling of relative paths.

**Original logic**:
```javascript
if (imageUrl.includes('/')) {
  const parts = imageUrl.split('/');
  const keyStartIndex = parts.findIndex((part, idx) => {
    if (idx === 0) return false; // http: or s3:
    if (idx === 1) return false; // empty string
    if (part.includes('s3') || part.includes('amazonaws')) return false; // domain parts
    return true;
  });
  key = keyStartIndex >= 0 ? parts.slice(keyStartIndex).join('/') : imageUrl;
}
```

**Problem with relative path `website/images/file.jpg`**:
- Parts: `['website', 'images', 'file.jpg']`
- Loop iterations:
  - idx=0, part='website': Not 'http:', not empty, no 's3' → **returns true** → keyStartIndex = 0
  - Result: `parts.slice(0).join('/')` = `'website/images/file.jpg'` ✅

Wait, this should actually work correctly! Let me investigate further...

## Hypothesis: Timing Issue?

The issue might not be in the key extraction but in **when** the verification runs. Let me check the workflow:

1. **sqs2scouts** downloads image → sets `event.image.url = 'website/images/hex.jpg'`
2. **sqs2scouts** saves hex file with this URL
3. **scouts** runs image verification
4. **scouts** checks if image exists

But wait - looking at the log output again:
- `"hexFilesRepaired":6` - scouts modified 6 hex files
- `"repairNotificationsSent":14` - sent 14 repair notifications

This suggests scouts is actively removing URLs and sending repair messages!

## Additional Investigation Needed

Let me check what value is actually stored in the hex files versus what scouts is checking.

### Test Case: 4T fireworks night
- **Hex value**: `34742066697265776f726b73206e69676874`
- **Image in S3**: `website/images/34742066697265776f726b73206e69676874.jpg` ✅ EXISTS
- **Hex file image.url**: `null` (scouts removed it!)

## Updated Fix

The fix I implemented adds explicit handling for relative paths:

```javascript
// If it's already a relative path starting with website/images, use it directly
if (imageUrl.startsWith('website/images/') || imageUrl.startsWith('/website/images/')) {
  key = imageUrl.startsWith('/') ? imageUrl.substring(1) : imageUrl;
  console.log(`[Image Check] Using relative path as key: ${key}`);
} else if (imageUrl.includes('/')) {
  // Parse full URLs...
}
```

This ensures that:
1. Relative paths like `website/images/file.jpg` are used directly as S3 keys
2. Full URLs like `http://bucket.s3.amazonaws.com/website/images/file.jpg` are parsed correctly
3. Debug logging helps identify what key is being checked

## Next Steps

1. **Deploy the updated scouts.mjs**
2. **Monitor the logs** for the new debug messages:
   - `[Image Check] Using relative path as key: ...`
   - `[Image Check] Image EXISTS in S3: ...`
   - `[Image Check] Image NOT FOUND in S3: ...`
3. **Verify** that images are no longer incorrectly marked as broken
4. **Check** that repair notifications are only sent for truly missing images

## Testing Commands

```bash
# Run scouts with the fix
./scouts.sh

# Check if images still marked as broken
aws s3 cp s3://2ndtolworth/events/34742066697265776f726b73206e69676874.json - | jq '.image'

# Verify image still exists
aws s3 ls s3://2ndtolworth/website/images/34742066697265776f726b73206e69676874.jpg

# Check scouts output for new log messages
cat output.log | jq '.body' | jq -r '.' | jq '.imageRepair'
```
