# Calendar Proxy Server - Deployment Guide

## Overview

The calendar proxy server solves the CORS (Cross-Origin Resource Sharing) issue when fetching ICS calendar files from OnlineScoutManager. Instead of the browser directly fetching from OnlineScoutManager (which triggers CORS errors or file downloads), the request goes through our Node.js/Express server which:

1. Accepts requests from the client-side JavaScript
2. Fetches the ICS file from OnlineScoutManager server-side (no CORS restrictions)
3. Returns the ICS data with proper headers and CORS enabled
4. Caches responses for 5 minutes to reduce load

## Architecture

```
Browser (calendar-render.js)
    ↓
    GET /api/calendar-proxy?url=<encoded_ics_url>
    ↓
Express Server (server.js)
    ↓
    Fetch from OnlineScoutManager
    ↓
    Return ICS data with CORS headers
    ↓
Browser parses and renders events
```

## Files Added/Modified

### New Files
- `server.js` - Express server with proxy endpoint
- `package.json` - Node.js dependencies (express, cors)
- `.gitignore` - Excludes node_modules from git

### Modified Files
- `scripts/calendar-render.js` - Updated to use proxy endpoint
- `README.md` - Added server setup instructions

## Local Development

### First Time Setup
```bash
# Install dependencies
npm install

# Start the server
npm start
```

The server will run on http://localhost:3000

### Test the Proxy
```bash
# Test the proxy endpoint
curl "http://localhost:3000/api/calendar-proxy?url=https%3A%2F%2Fwww.onlinescoutmanager.co.uk%2Fext%2Fcal%2F%3Ff%3D..."
```

## Deployment Options

### Option 1: Heroku

1. Install Heroku CLI
2. Create a new app:
   ```bash
   heroku create your-scouts-app-name
   ```
3. Deploy:
   ```bash
   git push heroku main
   ```
4. Heroku will automatically detect Node.js and run `npm start`

### Option 2: Vercel

1. Install Vercel CLI: `npm i -g vercel`
2. Run: `vercel`
3. Follow the prompts

### Option 3: AWS/Azure/GCP

Deploy as a Node.js application:
- Use a VM or container service
- Install Node.js
- Clone repository
- Run `npm install && npm start`
- Configure reverse proxy (nginx/Apache) if needed
- Use PM2 or similar for process management

### Option 4: Docker

Create a `Dockerfile`:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

Build and run:
```bash
docker build -t scouts-calendar .
docker run -p 3000:3000 scouts-calendar
```

## Environment Variables

The server supports the following environment variable:

- `PORT` - Port to run the server on (default: 3000)

Example:
```bash
PORT=8080 npm start
```

## Security Considerations

1. **URL Validation**: The proxy only allows URLs from `onlinescoutmanager.co.uk`
2. **CORS**: Currently allows all origins - can be restricted in production
3. **Rate Limiting**: Consider adding rate limiting for production
4. **Cache Headers**: 5-minute cache reduces load on OnlineScoutManager

## Production Recommendations

### 1. Add Rate Limiting
```bash
npm install express-rate-limit
```

Add to server.js:
```javascript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use('/api/', limiter);
```

### 2. Restrict CORS Origins

Update server.js:
```javascript
app.use(cors({
  origin: ['https://yourdomain.com', 'https://www.yourdomain.com']
}));
```

### 3. Add Logging

Install winston or morgan:
```bash
npm install morgan
```

### 4. Use Process Manager

For production, use PM2:
```bash
npm install -g pm2
pm2 start server.js --name scouts-calendar
pm2 save
pm2 startup
```

## Troubleshooting

### Calendar Events Not Loading

1. Check browser console for errors
2. Verify server is running: `curl http://localhost:3000/api/calendar-proxy?url=...`
3. Check server logs for errors
4. Verify OnlineScoutManager URLs are correct

### CORS Errors Still Appearing

- Ensure you're accessing the site through the server (http://localhost:3000)
- Not directly opening index.html (file://)

### Server Won't Start

- Check if port 3000 is already in use
- Verify Node.js is installed: `node --version`
- Reinstall dependencies: `rm -rf node_modules && npm install`

## Performance

- **Cache**: Responses are cached for 5 minutes
- **Concurrent**: Express handles multiple requests concurrently
- **Lightweight**: Minimal dependencies (express, cors only)

## How It Works

### Client-Side (calendar-render.js)
```javascript
// Old: Direct fetch (CORS issues)
const res = await fetch(url, {mode: 'cors'});

// New: Through proxy
const proxyUrl = `/api/calendar-proxy?url=${encodeURIComponent(url)}`;
const res = await fetch(proxyUrl);
```

### Server-Side (server.js)
```javascript
// Fetch from OnlineScoutManager
https.get(icsUrl, (icsRes) => {
  // Return with proper headers
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.send(data);
});
```

## Maintenance

- Keep dependencies updated: `npm update`
- Monitor server logs for errors
- Check OnlineScoutManager calendar URLs are still valid
- Update cache duration if needed in server.js

## Support

For issues:
1. Check server logs
2. Test proxy endpoint directly with curl
3. Verify calendar URLs are accessible
4. Check browser console for client-side errors
