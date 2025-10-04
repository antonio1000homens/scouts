// Simple Express server to proxy ICS calendar requests
// This avoids CORS issues when fetching from OnlineScoutManager

const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all origins (can be restricted to specific domains if needed)
app.use(cors());

// Serve static files from the current directory
app.use(express.static('.'));

// Proxy endpoint for ICS calendar files
app.get('/api/calendar-proxy', async (req, res) => {
  const icsUrl = req.query.url;

  if (!icsUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // Validate that the URL is from OnlineScoutManager
  try {
    const parsedUrl = new URL(icsUrl);
    if (!parsedUrl.hostname.includes('onlinescoutmanager.co.uk')) {
      return res.status(403).json({ error: 'Only OnlineScoutManager URLs are allowed' });
    }
  } catch (err) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  console.log(`Proxying ICS request: ${icsUrl}`);

  // Determine protocol (http or https)
  const protocol = icsUrl.startsWith('https') ? https : http;

  // Fetch the ICS file
  protocol.get(icsUrl, (icsRes) => {
    let data = '';

    // Handle redirects (302)
    if (icsRes.statusCode === 302 || icsRes.statusCode === 301) {
      const redirectUrl = icsRes.headers.location;
      console.log(`Following redirect to: ${redirectUrl}`);
      return protocol.get(redirectUrl, (redirectRes) => {
        let redirectData = '';
        redirectRes.on('data', chunk => redirectData += chunk);
        redirectRes.on('end', () => {
          res.set('Content-Type', 'text/calendar; charset=utf-8');
          res.set('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
          res.send(redirectData);
        });
      }).on('error', (err) => {
        console.error('Error following redirect:', err);
        res.status(500).json({ error: 'Failed to fetch calendar' });
      });
    }

    icsRes.on('data', chunk => {
      data += chunk;
    });

    icsRes.on('end', () => {
      // Set proper content type for ICS files
      res.set('Content-Type', 'text/calendar; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
      res.send(data);
    });
  }).on('error', (err) => {
    console.error('Error fetching ICS:', err);
    res.status(500).json({ error: 'Failed to fetch calendar' });
  });
});

app.listen(PORT, () => {
  console.log(`Calendar proxy server running on http://localhost:${PORT}`);
  console.log(`Proxy endpoint: http://localhost:${PORT}/api/calendar-proxy?url=<ICS_URL>`);
});
