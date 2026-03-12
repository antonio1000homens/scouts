# Pixabay Image Flow - Before and After

## Before (Problem)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Pixabay API Request                                      │
│    sqs2scouts → Pixabay API                                 │
│    Returns: https://pixabay.com/get/g123abc456.jpg         │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. Slack Notification                                       │
│    ❌ Tries to display image block                          │
│    ❌ Image fails to load (hotlink protection)             │
│                                                             │
│    [Image failed to load]                                  │
│    Image URL: https://pixabay.com/get/g123abc456.jpg       │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. Approval                                                 │
│    User clicks "Approve"                                    │
│    scouts lambda saves hex file with Pixabay URL           │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. Result                                                   │
│    ❌ Hex file contains non-working Pixabay URL            │
│    ❌ Image cannot be used in web app                      │
└─────────────────────────────────────────────────────────────┘
```

## After (Solution)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Pixabay API Request                                      │
│    sqs2scouts → Pixabay API                                 │
│    Returns: https://pixabay.com/get/g123abc456.jpg         │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. Slack Notification                                       │
│    ✅ Displays URL as clickable text link                   │
│    ✅ Clear message about download on approval              │
│                                                             │
│    Image URL: View on Pixabay                              │
│    (Pixabay images cannot be embedded - will be            │
│     downloaded to S3 on approval)                           │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. Approval                                                 │
│    User clicks "Approve"                                    │
│    scouts lambda detects Pixabay URL                        │
│                                                             │
│    3a. Download image                                       │
│        fetch(pixabay.com/get/g123abc456.jpg)               │
│                                                             │
│    3b. Upload to S3                                         │
│        → s3://2ndtolworth/images/event-name-1697123.jpg    │
│                                                             │
│    3c. Generate S3 URL                                      │
│        http://2ndtolworth.s3-website.eu-west-2.            │
│        amazonaws.com/images/event-name-1697123.jpg          │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. Result                                                   │
│    ✅ Hex file contains working S3 URL                      │
│    ✅ Image can be embedded anywhere                        │
│    ✅ Image is self-hosted and permanent                    │
│                                                             │
│    hex file:                                                │
│    {                                                        │
│      "title": "Scout Camp Weekend",                        │
│      "image": {                                             │
│        "url": "http://2ndtolworth.s3-website.eu-west-2.    │
│                amazonaws.com/images/event-123.jpg"          │
│      }                                                      │
│    }                                                        │
└─────────────────────────────────────────────────────────────┘
```

## Key Improvements

1. **User Experience**: Clear messaging about what will happen
2. **Reliability**: Images are self-hosted and won't break
3. **Performance**: Images cached with 1-year TTL
4. **Flexibility**: Can embed images in any context (Slack, web, email, etc.)

## Example URLs

### Before (Pixabay)
```
https://pixabay.com/get/g3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2.jpg
```
❌ Cannot be embedded
❌ May expire or change
❌ Subject to Pixabay's terms

### After (S3)
```
http://2ndtolworth.s3-website.eu-west-2.amazonaws.com/images/scout-camp-weekend-1697123456789.jpg
```
✅ Can be embedded anywhere
✅ Permanent and stable
✅ Under our control
