# Browser Cache Clearing Guide

## The Problem
S3 is serving the CORRECT HTML with `website/images/...` paths.
Your browser has cached the OLD HTML with `/website/images/...` paths.

S3 static website hosting does NOT support cache invalidation like CloudFront.
You MUST clear your browser cache.

## Quick Test: Does it work in Incognito?
**Best first test:** Open an incognito/private window and visit:
http://2ndtolworth.s3-website.eu-west-2.amazonaws.com

If it works there, it's 100% a browser cache issue.

---

## Solution 1: Hard Refresh (Try This First)

### Chrome/Edge/Brave:
1. Open the website
2. Open DevTools (F12)
3. **Right-click** the refresh button (top left of browser)
4. Select **"Empty Cache and Hard Reload"**

### Firefox:
1. Open the website  
2. Press **Ctrl+Shift+R** (Windows/Linux) or **Cmd+Shift+R** (Mac)

### Safari:
1. Open the website
2. Press **Cmd+Option+R**

---

## Solution 2: Clear ALL Browser Cache

### Chrome:
1. Press `Ctrl+Shift+Delete` (Windows) or `Cmd+Shift+Delete` (Mac)
2. Select **"Cached images and files"** (UNCHECK passwords/history)
3. Time range: **"All time"**
4. Click **"Clear data"**

### Firefox:
1. Press `Ctrl+Shift+Delete` or `Cmd+Shift+Delete`
2. Check **"Cached Web Content"**
3. Time range: **"Everything"**
4. Click **"Clear Now"**

### Edge:
1. Press `Ctrl+Shift+Delete`
2. Check **"Cached images and files"**
3. Click **"Clear now"**

### Safari:
1. Safari → Preferences → Advanced
2. Check **"Show Develop menu"**
3. Develop → **Empty Caches**

---

## Solution 3: Disable Cache in DevTools (For Testing)

### All Browsers:
1. Open DevTools (F12)
2. Open Network tab
3. Check **"Disable cache"**
4. Keep DevTools open while browsing
5. Refresh the page

---

## Solution 4: Add Cache-Busting Query Parameter

Visit the URL with a timestamp to bypass cache:
```
http://2ndtolworth.s3-website.eu-west-2.amazonaws.com/index.html?t=123456
```

Change the number each time to force a fresh fetch.

---

## Why This Happened

1. Previously, index.html had `/website/images/...` (absolute paths)
2. Your browser cached that HTML file
3. We updated S3 to have `website/images/...` (relative paths)
4. S3 is NOW serving the correct version
5. But your browser is still using the cached OLD version

## Verify S3 is Correct

Run this command to see what S3 is actually serving:
```bash
curl -s http://2ndtolworth.s3-website.eu-west-2.amazonaws.com/index.html | grep "src=\".*images/"
```

You'll see `website/images/...` (correct) not `/website/images/...` (old).

---

## Long-term Solution: Use CloudFront

S3 static website hosting doesn't support cache invalidation.
If you need better cache control, consider:

1. **CloudFront** (AWS CDN):
   - Supports cache invalidation
   - Can set custom cache headers
   - Better performance
   - Can invalidate cache on-demand

2. **Cache-Control Headers** (already done):
   - We set `no-cache, no-store, must-revalidate` on HTML files
   - This helps prevent future caching issues
   - But existing cached content must still be cleared manually

---

## Testing Checklist

- [ ] Test in incognito/private window
- [ ] Hard refresh with DevTools open (Ctrl+Shift+R)
- [ ] Clear all browser cache
- [ ] Test in different browser
- [ ] Check browser console for actual error URLs
- [ ] Verify S3 content with curl command above
