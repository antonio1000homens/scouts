# Calendar Proxy Architecture

## Problem: CORS Restriction

### Before (Direct Fetch - ❌ Failed)
```
┌─────────────┐                    ┌──────────────────────┐
│   Browser   │────────X───────────▶│ OnlineScoutManager   │
│             │   CORS Error        │  .co.uk/ext/cal/     │
│ index.html  │   🚫 Blocked        │                      │
└─────────────┘                    └──────────────────────┘
```

**Issue:** Browser security (CORS) prevents direct fetch from OnlineScoutManager
**Result:** Calendar events cannot be displayed

---

## Solution: Server-Side Proxy

### After (Proxy Fetch - ✅ Success)
```
┌─────────────┐                ┌─────────────┐                ┌──────────────────────┐
│   Browser   │                │   Express   │                │ OnlineScoutManager   │
│             │                │   Server    │                │  .co.uk/ext/cal/     │
│ index.html  │                │  (Node.js)  │                │                      │
│             │                │             │                │                      │
│ calendar-   │                │  server.js  │                │                      │
│ render.js   │                │             │                │                      │
└──────┬──────┘                └──────┬──────┘                └──────────┬───────────┘
       │                              │                                  │
       │ 1. Fetch                     │                                  │
       │ /api/calendar-proxy?url=...  │                                  │
       ├──────────────────────────────▶│                                  │
       │                              │                                  │
       │                              │ 2. Server-side fetch             │
       │                              │ (no CORS restriction)            │
       │                              ├──────────────────────────────────▶│
       │                              │                                  │
       │                              │ 3. ICS file data                 │
       │                              │◀──────────────────────────────────┤
       │                              │                                  │
       │ 4. ICS with CORS headers     │                                  │
       │◀──────────────────────────────┤                                  │
       │                              │                                  │
       │ 5. Parse & Render            │                                  │
       │ ✅ Display events            │                                  │
       │                              │                                  │
```

---

## Request Flow Details

### Step 1: Browser Request
```javascript
// calendar-render.js
const proxyUrl = `/api/calendar-proxy?url=${encodeURIComponent(icsUrl)}`;
const res = await fetch(proxyUrl);
```

### Step 2: Express Receives Request
```javascript
// server.js
app.get('/api/calendar-proxy', async (req, res) => {
  const icsUrl = req.query.url;
  // Validate URL is from OnlineScoutManager
  // Fetch server-side (no CORS)
});
```

### Step 3: Server Fetches ICS
```javascript
// server.js
https.get(icsUrl, (icsRes) => {
  // Collect data
  icsRes.on('data', chunk => data += chunk);
});
```

### Step 4: Server Returns with Headers
```javascript
// server.js
res.set('Content-Type', 'text/calendar; charset=utf-8');
res.set('Cache-Control', 'public, max-age=300');
res.send(data);
```

### Step 5: Browser Renders Events
```javascript
// calendar-render.js
const events = parseICSEvents(ics);
// Display events in UI
```

---

## Key Components

### Client Side (Browser)
- **File:** `scripts/calendar-render.js`
- **Role:** Request ICS via proxy, parse, render
- **Change:** Uses `/api/calendar-proxy` instead of direct URL

### Server Side (Node.js)
- **File:** `server.js`
- **Role:** Proxy ICS requests, add CORS headers
- **Features:**
  - URL validation
  - Redirect handling
  - 5-minute caching
  - Error handling

### Static Files
- **Served by:** Express static middleware
- **Files:** HTML, CSS, images, fonts
- **Access:** `http://localhost:3000/`

---

## Security Features

### 1. URL Validation
```javascript
if (!parsedUrl.hostname.includes('onlinescoutmanager.co.uk')) {
  return res.status(403).json({ error: 'Only OnlineScoutManager URLs allowed' });
}
```

### 2. CORS Headers
```javascript
app.use(cors()); // Allows cross-origin requests
```

### 3. Cache Control
```javascript
res.set('Cache-Control', 'public, max-age=300'); // 5 minutes
```

---

## Deployment

### Local Development
```bash
npm install
npm start
# Server runs on http://localhost:3000
```

### Production Options
1. **Heroku:** `git push heroku main`
2. **Vercel:** `vercel`
3. **AWS/Azure/GCP:** Node.js app deployment
4. **Docker:** `docker build -t scouts . && docker run -p 3000:3000 scouts`

---

## Error Handling

### Graceful Fallback
If proxy fails, the UI shows:
> "Could not load events here — click Open calendar to view or download the file."

Fallback links remain functional for direct access.

---

## Performance

- **Cache Duration:** 5 minutes (configurable)
- **Response Time:** ~500ms-2s (depends on OnlineScoutManager)
- **Concurrent Requests:** Express handles multiple requests efficiently
- **Bundle Size:** Minimal (express + cors only)

---

## Testing

### Parser Test (Offline)
```bash
# Open test-proxy.html
# Click "Test Parser"
# ✅ Should parse sample ICS data
```

### Proxy Test (Server Required)
```bash
npm start
# Open test-proxy.html
# Click "Test Proxy Connection"
# ✅ Should connect to proxy endpoint
```

### Integration Test (Internet Required)
```bash
npm start
# Open index.html
# Calendar events should display automatically
```

---

## Maintenance

### Update Dependencies
```bash
npm update
```

### Check Server Logs
```bash
npm start
# Monitor console output for errors
```

### Adjust Cache Duration
Edit `server.js`:
```javascript
res.set('Cache-Control', 'public, max-age=600'); // 10 minutes
```

---

## Troubleshooting

### Events Not Loading
1. Check server is running: `npm start`
2. Check browser console for errors
3. Test proxy endpoint directly
4. Verify OnlineScoutManager URLs are valid

### CORS Errors
- Ensure accessing via server (http://localhost:3000)
- Not via file:// protocol

### Server Won't Start
- Check port 3000 is available
- Verify Node.js is installed
- Reinstall dependencies: `rm -rf node_modules && npm install`
