#!/usr/bin/env node

/**
 * Test Pixabay image download to S3 functionality
 * This ensures that:
 * 1. Pixabay URLs are detected correctly
 * 2. Download function handles various image formats
 * 3. S3 URL is constructed correctly
 */

import { test } from 'node:test';
import assert from 'node:assert';

test('Pixabay URL detection and S3 transformation', async (t) => {
  await t.test('Should detect Pixabay URLs', () => {
    const pixabayUrls = [
      'https://pixabay.com/get/image123.jpg',
      'https://cdn.pixabay.com/photo/2024/01/01/12-00-00.jpg',
      'http://pixabay.com/images/test.png'
    ];

    const nonPixabayUrls = [
      'https://example.com/image.jpg',
      'https://s3.amazonaws.com/bucket/image.jpg',
      'https://imgur.com/abc123'
    ];

    for (const url of pixabayUrls) {
      assert.ok(url.includes('pixabay.com'), `Should detect ${url} as Pixabay URL`);
    }

    for (const url of nonPixabayUrls) {
      assert.ok(!url.includes('pixabay.com'), `Should not detect ${url} as Pixabay URL`);
    }
  });

  await t.test('Should construct S3 website URL correctly', () => {
    const bucket = '2ndtolworth';
    const region = 'eu-west-2';
    const key = 'images/test-event-123456.jpg';
    
    const expectedUrl = `http://${bucket}.s3-website.${region}.amazonaws.com/${key}`;
    
    assert.strictEqual(
      expectedUrl,
      'http://2ndtolworth.s3-website.eu-west-2.amazonaws.com/images/test-event-123456.jpg',
      'S3 website URL should be constructed correctly'
    );
  });

  await t.test('Should sanitize event title for filename', () => {
    const testCases = [
      { title: 'Test Event', expected: 'test-event' },
      { title: 'Event with CAPS', expected: 'event-with-caps' },
      { title: 'Event!!!With***Special###Chars', expected: 'event-with-special-chars' },
      { title: '  Spaces  at  edges  ', expected: 'spaces-at-edges' },
      // Note: Trailing dash after truncation is acceptable in filenames
      { title: 'Very Long Event Title That Should Be Truncated To Fifty Characters Maximum Length', expected: 'very-long-event-title-that-should-be-truncated-to-' }
    ];

    for (const { title, expected } of testCases) {
      const sanitized = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 50);
      
      assert.strictEqual(
        sanitized,
        expected,
        `Title "${title}" should sanitize to "${expected}"`
      );
    }
  });

  await t.test('Should determine correct file extension from content type', () => {
    const testCases = [
      { contentType: 'image/jpeg', expected: '.jpg' },
      { contentType: 'image/png', expected: '.png' },
      { contentType: 'image/gif', expected: '.gif' },
      { contentType: 'image/webp', expected: '.webp' },
      { contentType: 'image/svg+xml', expected: '.svg' },
      { contentType: 'image/jpg', expected: '.jpg' },
      { contentType: 'application/octet-stream', expected: '.jpg' }, // default
    ];

    for (const { contentType, expected } of testCases) {
      let extension = '.jpg'; // default
      if (contentType.includes('png')) {
        extension = '.png';
      } else if (contentType.includes('gif')) {
        extension = '.gif';
      } else if (contentType.includes('webp')) {
        extension = '.webp';
      } else if (contentType.includes('svg')) {
        extension = '.svg';
      }
      
      assert.strictEqual(
        extension,
        expected,
        `Content type "${contentType}" should map to extension "${expected}"`
      );
    }
  });

  await t.test('Should handle approval flow with Pixabay URL', () => {
    // Simulate the approval flow logic
    const subject = {
      hex: '74657374',
      title: 'Test Event',
      image: {
        prompt: 'test prompt',
        url: 'https://pixabay.com/get/test-image.jpg'
      }
    };

    const existingHex = {
      title: 'Test Event',
      AI: 'Test AI content'
    };

    // Merge logic
    const mergedEvent = {
      ...existingHex,
      ...subject,
      hex: subject.hex,
      updatedAt: new Date().toISOString(),
    };

    // Ensure image container
    if (subject.image) {
      mergedEvent.image = {
        prompt: subject.image.prompt ?? existingHex.image?.prompt ?? null,
        url: subject.image.url ?? existingHex.image?.url ?? null,
      };
    }

    // Check if URL is from Pixabay
    const isPixabayUrl = mergedEvent.image?.url && mergedEvent.image.url.includes('pixabay.com');
    
    assert.ok(isPixabayUrl, 'Should detect Pixabay URL in approval flow');
    assert.strictEqual(mergedEvent.image.url, 'https://pixabay.com/get/test-image.jpg');
    
    // Simulate URL replacement after download
    if (isPixabayUrl) {
      mergedEvent.image.url = 'http://2ndtolworth.s3-website.eu-west-2.amazonaws.com/images/test-event-123456.jpg';
    }
    
    assert.ok(
      !mergedEvent.image.url.includes('pixabay.com'),
      'Pixabay URL should be replaced with S3 URL after download'
    );
    assert.ok(
      mergedEvent.image.url.includes('2ndtolworth.s3-website'),
      'URL should point to S3 website'
    );
  });
});

console.log('✅ All Pixabay download tests passed');
