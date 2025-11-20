# Event Images Admin Page

This admin page provides an interface to view and manage event images and AI prompts used in the 2nd Tolworth Scout Group website.

## Features

- **View All Events**: Lists all events from `agenda.json` with their details
- **Event Information**: Shows event name, index, date, location
- **Image Display**: Shows current event images with their URLs
- **AI Prompts**: Displays AI-generated descriptions for each event
- **Section Badges**: Color-coded badges for Beavers, Cubs, and Scouts events
- **S3 Upload Ready**: Prepared for AWS S3 integration to replace images

## Accessing the Admin Page

The admin page is available at: `/website/admin/index.html`

For example:
- Local development: `http://localhost:8000/website/admin/index.html`
- Production: `http://2ndtolworth.s3-website.eu-west-2.amazonaws.com/website/admin/index.html`

## How It Works

### Data Source

The admin page reads event data from `agenda.json` located at the repository root. Each event can have:

```json
{
  "summary": "Event Name",
  "dtstart": "2025-10-09T18:00:00",
  "dtend": "2025-10-09T19:00:00",
  "location": "The Den",
  "description": "Event description",
  "icsType": "beaver*",
  "image": "https://example.com/image.jpg",
  "AI": "AI-generated description of the event"
}
```

### Event Index

Each event is assigned an index (0, 1, 2, etc.) based on its position in the `events` array in `agenda.json`. This index is displayed to help identify events when updating the JSON file.

### Image URLs

The admin page supports multiple image URL formats:
- Direct URL string: `"image": "https://..."`
- Object with URL property: `"image": { "url": "https://..." }`
- `imageUrl` field: `"imageUrl": "https://..."`
- Relative paths: `"image": "website/eventImages/photo.jpg"`

### AI Prompts

AI prompts can be stored in any of these fields:
- `"AI"` (recommended)
- `"ai"`
- `"aiPrompt"`

## S3 Upload Integration

### Current Status

The "Upload Disabled" buttons indicate that S3 upload functionality is prepared but requires AWS SDK integration.

### Enabling S3 Uploads

To enable image uploads to S3:

1. **Add AWS SDK** to the admin page:
   ```html
   <script src="https://sdk.amazonaws.com/js/aws-sdk-2.1234.0.min.js"></script>
   ```

2. **Configure AWS Credentials**: The user needs to have AWS credentials with the following permissions:
   ```json
   {
     "Action": [
       "s3:PutObject",
       "s3:GetObject"
     ],
     "Resource": [
       "arn:aws:s3:::2ndtolworth/*"
     ]
   }
   ```

3. **Update admin-script.js**: The `uploadImage()` function is prepared to handle:
   - File uploads from local disk
   - Image URL updates
   - S3 integration
   - agenda.json updates

### Security Considerations

⚠️ **Important**: 
- This admin page should be protected with authentication
- AWS credentials should never be hardcoded in client-side JavaScript
- Consider using AWS Cognito or a backend API for secure S3 uploads
- The current implementation is a proof-of-concept for demonstration

## File Structure

```
website/admin/
├── index.html          # Main admin page
├── admin-styles.css    # Styling for the admin interface
├── admin-script.js     # JavaScript for loading and displaying events
└── README.md          # This file
```

## Updating Events

To update event images or AI prompts:

1. **Manual Update** (current method):
   - Edit `agenda.json` directly
   - Add or update the `image` and `AI` fields
   - Commit and push changes

2. **Future S3 Upload** (when enabled):
   - Click "Replace Image" button on any event
   - Upload a new image or provide a URL
   - The system will upload to S3 and update agenda.json

## Maintenance

- The admin page automatically detects events from `agenda.json`
- No manual configuration needed for new events
- Images load with error handling (shows placeholder if image fails)
- Responsive design works on desktop and mobile devices

## Browser Compatibility

- Modern browsers (Chrome, Firefox, Safari, Edge)
- Requires JavaScript enabled
- Uses ES6+ features (async/await, fetch API)

## Development

To test locally:

```bash
# Start a local web server from the repository root
python3 -m http.server 8000

# Navigate to:
# http://localhost:8000/website/admin/index.html
```

## Future Enhancements

Potential improvements:
- [ ] Implement full S3 upload integration
- [ ] Add authentication/authorization
- [ ] Bulk image upload
- [ ] Image cropping/editing tools
- [ ] AI prompt editor with save functionality
- [ ] Event filtering by section (Beavers/Cubs/Scouts)
- [ ] Search and sort functionality
- [ ] Direct agenda.json editing interface
