# Quick Start Guide - Calendar Proxy Server

## 🚀 Get Started in 3 Steps

### Step 1: Install Dependencies
```bash
npm install
```
This installs Express and CORS middleware.

### Step 2: Start the Server
```bash
npm start
```
Server will run on http://localhost:3000

### Step 3: Open in Browser
```bash
# Open your browser to:
http://localhost:3000
```

That's it! 🎉

---

## 📋 What You Get

### Automatic Features
- ✅ Calendar events fetched from OnlineScoutManager
- ✅ No CORS errors
- ✅ 5-minute caching
- ✅ Redirect handling
- ✅ Graceful fallback if fetching fails

### Pages Available
- **Main Site:** http://localhost:3000/index.html
- **Test Page:** http://localhost:3000/test-proxy.html
- **Component Preview:** http://localhost:3000/component-preview.html

---

## 🧪 Test the Proxy

### Open Test Page
```bash
http://localhost:3000/test-proxy.html
```

### Run Tests
1. Click **"Test Parser"** - Should show ✅ Success
2. Click **"Test Proxy Connection"** - Requires server running
3. Click **"Fetch Calendar"** - Requires internet access

---

## 🔧 Troubleshooting

### Server Won't Start
```bash
# Check if port 3000 is in use
lsof -i :3000

# Or use a different port
PORT=8080 npm start
```

### Calendar Not Loading
- ✅ Server is running (`npm start`)
- ✅ Accessing via http://localhost:3000 (not file://)
- ✅ Check browser console for errors

### Dependencies Issue
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

---

## 📚 More Information

- **Full Deployment Guide:** See `CALENDAR_PROXY_DEPLOYMENT.md`
- **Architecture Details:** See `PROXY_ARCHITECTURE.md`
- **Implementation Details:** See `calendar-implementation-summary.md`
- **Verification:** See `IMPLEMENTATION_VERIFICATION.md`

---

## 🌐 Deploy to Production

### Heroku (Easiest)
```bash
heroku create your-scouts-app
git push heroku main
```

### Vercel
```bash
npm i -g vercel
vercel
```

### Docker
```bash
docker build -t scouts-calendar .
docker run -p 3000:3000 scouts-calendar
```

See `CALENDAR_PROXY_DEPLOYMENT.md` for detailed instructions.

---

## ⚙️ Configuration

### Change Port
```bash
PORT=8080 npm start
```

### Environment Variables
Create `.env` file (optional):
```
PORT=3000
NODE_ENV=production
```

---

## 📞 Need Help?

1. Check the test page: http://localhost:3000/test-proxy.html
2. Review `CALENDAR_PROXY_DEPLOYMENT.md` troubleshooting section
3. Check server console logs for errors
4. Verify OnlineScoutManager URLs are still valid

---

**Status:** ✅ Ready to deploy
**Time to start:** ~1 minute
**Time to deploy:** ~5 minutes
