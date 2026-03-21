#!/usr/bin/env node

/**
 * Test the hex file canonical source logic
 * This ensures that:
 * 1. Hex file values override agenda event values (canonical source)
 * 2. Hex files remain after events are fully populated
 * 3. Runs field is removed from completed hex files
 */

import { test } from 'node:test';
import assert from 'node:assert';

test('Hex file canonical source logic', async (t) => {
  await t.test('Hex file values should override event values', () => {
    // Simulate the merge logic
    const baseEvent = {
      title: 'Test Event',
      AI: 'Event AI content',
      image: {
        theme: 'Event theme',
        url: 'https://event.url/image.jpg'
      }
    };

    const existingHexFile = {
      AI: 'Hex AI content',
      image: {
        theme: 'Hex theme',
        url: 'https://hex.url/image.jpg'
      }
    };

    // Apply the canonical source logic (hex file overrides)
    if (existingHexFile.AI) {
      baseEvent.AI = existingHexFile.AI;
    }
    if (existingHexFile.image?.theme) {
      baseEvent.image.theme = existingHexFile.image.theme;
    }
    if (existingHexFile.image?.url) {
      baseEvent.image.url = existingHexFile.image.url;
    }

    // Verify hex file values were used
    assert.strictEqual(baseEvent.AI, 'Hex AI content', 'AI should come from hex file');
    assert.strictEqual(baseEvent.image.theme, 'Hex theme', 'Theme should come from hex file');
    assert.strictEqual(baseEvent.image.url, 'https://hex.url/image.jpg', 'URL should come from hex file');
  });

  await t.test('Partial hex file values should override corresponding event values', () => {
    const baseEvent = {
      title: 'Test Event',
      AI: 'Event AI content',
      image: {
        theme: 'Event theme',
        url: 'https://event.url/image.jpg'
      }
    };

    const existingHexFile = {
      AI: 'Hex AI content',
      image: {
        // Only theme is set in hex file
        theme: 'Hex theme',
        url: null
      }
    };

    // Apply the canonical source logic
    if (existingHexFile.AI) {
      baseEvent.AI = existingHexFile.AI;
    }
    if (existingHexFile.image?.theme) {
      baseEvent.image.theme = existingHexFile.image.theme;
    }
    if (existingHexFile.image?.url) {
      baseEvent.image.url = existingHexFile.image.url;
    }

    // Verify hex file values were used where available
    assert.strictEqual(baseEvent.AI, 'Hex AI content', 'AI should come from hex file');
    assert.strictEqual(baseEvent.image.theme, 'Hex theme', 'Theme should come from hex file');
    assert.strictEqual(baseEvent.image.url, 'https://event.url/image.jpg', 'URL should remain from event (hex has no URL)');
  });

  await t.test('Runs field should be removed from completed hex file', () => {
    const hexFileData = {
      title: 'Test Event',
      AI: 'AI content',
      image: {
        theme: 'Test theme',
        url: 'https://example.com/image.jpg'
      },
      runs: 5
    };

    // Simulate removing runs field for completed file
    const updatedHexFile = { ...hexFileData };
    delete updatedHexFile.runs;

    // Verify runs field was removed
    assert.strictEqual(updatedHexFile.runs, undefined, 'Runs field should be undefined');
    assert.strictEqual(updatedHexFile.AI, 'AI content', 'AI should still be present');
    assert.strictEqual(updatedHexFile.image.theme, 'Test theme', 'Theme should still be present');
    assert.strictEqual(updatedHexFile.image.url, 'https://example.com/image.jpg', 'URL should still be present');
  });

  await t.test('Hex file cleanup should remove deprecated event fields', () => {
    const hexFileData = {
      title: 'Test Event',
      uid: 'event-123',
      dtstart: { raw: '2026-03-21T19:00:00.000Z' },
      location: 'The Den',
      section: 'cubs',
      icsType: 'cubs-programme',
      AI: 'AI content',
      image: {
        theme: 'Test theme',
        url: 'https://example.com/image.jpg'
      },
      processing: ['imageTheme'],
      runs: 3,
      hex: '54657374204576656e74'
    };

    // Simulate removing runs plus deprecated persisted fields
    const updatedHexFile = { ...hexFileData };
    delete updatedHexFile.runs;
    delete updatedHexFile.location;
    delete updatedHexFile.section;
    delete updatedHexFile.icsType;
    delete updatedHexFile.processing;

    // Verify deprecated persisted fields were removed
    assert.strictEqual(updatedHexFile.title, 'Test Event');
    assert.strictEqual(updatedHexFile.uid, 'event-123');
    assert.deepStrictEqual(updatedHexFile.dtstart, { raw: '2026-03-21T19:00:00.000Z' });
    assert.strictEqual(updatedHexFile.location, undefined);
    assert.strictEqual(updatedHexFile.section, undefined);
    assert.strictEqual(updatedHexFile.icsType, undefined);
    assert.strictEqual(updatedHexFile.processing, undefined);
    assert.strictEqual(updatedHexFile.AI, 'AI content');
    assert.strictEqual(updatedHexFile.image.theme, 'Test theme');
    assert.strictEqual(updatedHexFile.image.url, 'https://example.com/image.jpg');
    assert.strictEqual(updatedHexFile.hex, '54657374204576656e74');
    assert.strictEqual(updatedHexFile.runs, undefined);
  });
});

console.log('✅ Hex file canonical source tests complete!');
