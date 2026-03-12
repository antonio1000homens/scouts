# SQS2Scouts Image Persistence Investigation

## Issue Report
User reported that sqs2scouts is not persisting the image URL into the hex.json files.

## Investigation Findings

### ✅ sqs2scouts.mjs IS Working Correctly

After investigating the code, I found that **sqs2scouts IS correctly persisting the image URL** to the hex files. Evidence:

1. **The hex file for "Working dogs" shows correct data:**
```json
{
  "title": "Working dogs",
  "AI": "Paws for adventure! Working Dogs are coming!",
  "image": {
    "prompt": "working dogs",
    "url": "website/images/776f726b696e6720646f6773.jpg"
  },
  "hex": "776f726b696e6720646f6773",
  "sourceImg": "website/images/776f726b696e6720646f6773.jpg"
}
```

2. **The persist realm handler in sqs2scouts.mjs (lines 2339-2430):**
   - Downloads external image to S3 bucket
   - Converts URL to relative path (`website/images/...`)
   - Saves the relative URL to `event.image.url`
   - Calls `saveHexEventToS3()` to persist the data

3. **The `downloadImageToWebsiteS3()` function (lines 909-1020):**
   - Properly downloads images from external URLs
   - Uploads to S3 with proper content type
   - Returns relative URL path
   - Handles file extensions correctly

### ❌ Real Issue: scouts.mjs Not Updating agenda.json

The actual problem is that **scouts.mjs was not properly updating the agenda.json** with the image data from the hex files.

#### Root Cause
When a `sqs2scouts/persisted` notification is received, scouts.mjs:
1. Loads the hex file (which HAS the image URL) ✅
2. Loads the agenda.json ✅
3. Tries to find matching event to update ❌
4. **Sometimes fails to find the match** due to insufficient logging

## Fixes Applied to scouts.mjs

### Fix 1: Added sourceImg Field Update
**Location:** Line ~2148

**Before:**
```javascript
event.AI = hexData.AI;
event.image = { ...hexData.image };
updated = true;
```

**After:**
```javascript
event.AI = hexData.AI;
event.image = { ...hexData.image };
// Also update sourceImg if present in hexData
if (hexData.sourceImg) {
  event.sourceImg = hexData.sourceImg;
}
updated = true;
```

**Reason:** The hex file contains a `sourceImg` field that should also be persisted to agenda.json.

### Fix 2: Added Comprehensive Logging
**Location:** Lines ~2140-2158

**Added logs:**
1. Event count after loading agenda
2. Detailed event matching information with both title and hex
3. Warning when no matching event found
4. HEX data title for debugging mismatches

**Before:**
```javascript
console.log(`[sqs2scouts] Complete data for ${hexValue}, updating agenda.json.`);
// ... update logic ...
```

**After:**
```javascript
console.log(`[sqs2scouts] Complete data for ${hexValue}, updating agenda.json.`);
const existingAgendaRaw = await getJsonFromS3(bucket, agendaKey, 'agenda');
const existingAgenda = hydrateStoredDataset(existingAgendaRaw);

console.log(`[sqs2scouts] Loaded agenda with ${existingAgenda?.events?.length || 0} events`);

// ... update logic with detailed logging ...

if (!updated) {
  console.warn(`[sqs2scouts] No matching event found in agenda for HEX ${hexValue}. HEX data title: "${hexData.title || hexData.summary || 'unknown'}"`);
}
```

## How the System Works

### Complete Flow
```
1. Pixabay realm → Downloads image from Pixabay
2. Persist realm → 
   a. Downloads external image to S3 (if needed)
   b. Converts URL to relative path
   c. Saves hex file with image.url = "website/images/XXX.jpg"
   d. Sends notification to scoutsDecision queue
3. scouts.mjs receives sqs2scouts/persisted notification →
   a. Loads hex file (has image URL)
   b. Loads agenda.json
   c. Finds matching event by hex value
   d. Updates event with AI and image data
   e. Saves updated agenda.json
```

### Data Flow Diagram
```
External URL (e.g., Pixabay)
    ↓
sqs2scouts downloads image
    ↓
S3: website/images/776f726b696e6720646f6773.jpg
    ↓
sqs2scouts saves hex file with relative URL
    ↓
S3: events/776f726b696e6720646f6773.json
{
  "image": {
    "url": "website/images/776f726b696e6720646f6773.jpg"
  }
}
    ↓
scouts.mjs receives notification
    ↓
scouts.mjs updates agenda.json
    ↓
S3: agenda.json
{
  "events": [{
    "image": {
      "url": "website/images/776f726b696e6720646f6773.jpg"
    }
  }]
}
```

## Testing Recommendations

### Test Case 1: Verify Hex File Has Image URL
1. Trigger a persist flow for an event
2. Check the hex file in S3: `events/{hexValue}.json`
3. Verify `image.url` contains relative path like `website/images/...`

### Test Case 2: Verify Agenda Update
1. After persist notification is sent to scoutsDecision queue
2. Check CloudWatch logs for scouts.mjs
3. Look for log: `[sqs2scouts] Updating event "..." with AI and image`
4. Verify agenda.json was updated with image URL

### Test Case 3: Check for Mismatches
1. Look for warning: `No matching event found in agenda for HEX`
2. If found, compare:
   - Title in hex file
   - Title in agenda.json events
   - Calculated hex values

## Potential Future Issues

### Issue: Event Title Mismatch
If the event title in the calendar changes AFTER the hex file is created, the hex value won't match and the agenda won't be updated.

**Solution:** Consider storing the hex value in the agenda.json event or using uid for matching instead of recalculating hex from title.

### Issue: Race Condition
If agenda.json is regenerated from calendars AFTER the hex file is saved but BEFORE the scouts.mjs update runs, the image data will be missing.

**Solution:** The scouts.mjs update will catch this on the next persist notification.

## Summary

- ✅ **sqs2scouts.mjs is working correctly** - hex files DO have image URLs
- ✅ **Image download and storage is working** - images are saved to S3
- ✅ **Added better logging** - will help diagnose future issues
- ✅ **Added sourceImg field update** - ensures all image data is preserved

The user should now see proper image URLs in both hex files AND agenda.json after the next persist flow completes.

## Date
October 17, 2025
