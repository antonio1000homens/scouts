# 2nd Tolworth Scout Group Website

A professional, responsive website for 2nd Tolworth Scout Group with design inspired by the official [Scouts UK website](https://www.scouts.org.uk/).

## 🎨 Recent Updates - Scouts UK Style

This website has been completely redesigned to match the official Scouts UK branding and style guidelines.

### New Features
- ✅ Official Scouts UK color palette and typography
- ✅ Section logos (Beavers, Cubs, Scouts)
- ✅ Animated buttons with hover effects
- ✅ Age range overview section
- ✅ Activities showcase section
- ✅ Modern card-based layouts
- ✅ Yellow primary CTA buttons
- ✅ Enhanced responsive design
- ✅ **Calendar proxy server** - Fetches ICS files from OnlineScoutManager without CORS issues

## 📁 Files & Structure

### Main Files
- `index.html` - Main website
- `styles.css` - Complete styling
- `component-preview.html` - Preview all UI components
- `server.js` - Calendar proxy server
- `package.json` - Node.js dependencies

### Images Directory (`/images/`)
- `beavers-logo.svg` - Beavers section logo (teal)
- `cubs-logo.svg` - Cubs section logo (green)
- `scouts-logo.svg` - Scouts section logo (dark teal)
- `scouts-main-logo.svg` - Main Scouts logo

### Booklet
- `2tolworthcub_booklet_html/` - Cub Scout booklet pages

### Documentation
- `DESIGN_IMPROVEMENTS.md` - Design overhaul details
- `BUTTONS_AND_IMAGES.md` - Buttons and images guide

## Features

- **Responsive Design**: Fully responsive layout that works on desktop, tablet, and mobile devices
- **Section Information**: Dedicated content for Beavers (6-8), Cubs (8-10½), and Scouts (10½-14)
- **News Section**: Display latest updates and announcements
- **Contact Form**: Easy way for interested families to get in touch
- **Official Branding**: Uses official Scouts UK colors and typography
- **Interactive Elements**: Animated buttons, hover effects, and smooth transitions
- **Modern UI**: Clean, professional design matching scouts.org.uk

## 🎯 Sections Include

- Home/Hero section with yellow CTA buttons
- About section with action buttons
- Age range overview (visual section indicators)
- Our Sections (Beavers, Cubs, Scouts) with logos
- Activities showcase (camping, activities, badges)
- Latest News
- Calendar integration
- Contact information and form
- Multi-column footer

## How to Use

### Option 1: Static Site (without calendar events)

Simply open `index.html` in a web browser:

```bash
# Using Python
python3 -m http.server 8000

# Then open http://localhost:8000 in your browser
```

### Option 2: With Calendar Proxy Server (recommended)

To enable live calendar event fetching from OnlineScoutManager, run the Node.js proxy server:

```bash
# Install dependencies (first time only)
npm install

# Start the server
npm start

# Then open http://localhost:3000 in your browser
```

The proxy server:
- Fetches ICS calendar files from OnlineScoutManager
- Serves them with proper CORS headers
- Caches responses for 5 minutes
- Handles redirects and downloads automatically
- Serves all static files (HTML, CSS, images)

## 🎨 View Components

To see all available buttons, logos, and UI components:
```bash
# Open component-preview.html in your browser
```

## Customization

To customize for your specific scout group:

1. Update the group name in `index.html`
2. Replace logo SVGs with your group's logos (if available)
3. Modify meeting times and locations in the sections
4. Update contact information (email, phone, address)
5. Add your own news items and events
6. Add real photos from group activities
7. Customize colors in `styles.css` if needed

## Technologies

- HTML5
- CSS3
- JavaScript (for calendar rendering)
- Node.js + Express (for calendar proxy server)
- CORS-enabled proxy to fetch ICS files