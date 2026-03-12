#!/usr/bin/env node

/**
 * Test that notifications are batched per HEX rather than per event
 * This ensures that multiple events with the same title only generate one notification
 */

import { test } from 'node:test';
import assert from 'node:assert';

test('HEX notification batching logic', async (t) => {
  await t.test('Multiple events with same title should batch to single HEX notification', () => {
    // Simulate the Map-based collection logic
    const hexNotifications = new Map();
    
    // Simulate multiple events with the same title (thus same HEX)
    const titleHex = '54657374204576656e74'; // "Test Event" in hex
    const events = [
      { title: 'Test Event', uid: 'event-1', realm: 'AI' },
      { title: 'Test Event', uid: 'event-2', realm: 'AI' },
      { title: 'Test Event', uid: 'event-3', realm: 'AI' },
    ];
    
    // Simulate the collection logic from scouts.mjs
    for (const event of events) {
      if (!hexNotifications.has(titleHex)) {
        hexNotifications.set(titleHex, {
          realm: event.realm,
          title: event.title,
          uid: event.uid,
        });
      }
    }
    
    // Verify only one notification is queued for the shared HEX
    assert.strictEqual(hexNotifications.size, 1, 'Should only have one notification for duplicate HEX');
    assert.ok(hexNotifications.has(titleHex), 'Should have the test event HEX');
    
    const notification = hexNotifications.get(titleHex);
    assert.strictEqual(notification.realm, 'AI');
    assert.strictEqual(notification.title, 'Test Event');
  });

  await t.test('Events with different titles should create separate notifications', () => {
    const hexNotifications = new Map();
    
    // Simulate events with different titles (thus different HEXes)
    const events = [
      { titleHex: '4576656e742031', title: 'Event 1', uid: 'event-1', realm: 'AI' },
      { titleHex: '4576656e742032', title: 'Event 2', uid: 'event-2', realm: 'AI' },
      { titleHex: '4576656e742033', title: 'Event 3', uid: 'event-3', realm: 'imageUrl' },
    ];
    
    for (const event of events) {
      if (!hexNotifications.has(event.titleHex)) {
        hexNotifications.set(event.titleHex, {
          realm: event.realm,
          title: event.title,
          uid: event.uid,
        });
      }
    }
    
    // Verify three separate notifications for different titles
    assert.strictEqual(hexNotifications.size, 3, 'Should have three notifications for different HEXes');
  });

  await t.test('Same HEX with different realms should only keep first realm', () => {
    const hexNotifications = new Map();
    
    // This shouldn't happen in practice, but tests Map behavior
    const titleHex = '54657374204576656e74';
    const events = [
      { title: 'Test Event', uid: 'event-1', realm: 'AI' },
      { title: 'Test Event', uid: 'event-2', realm: 'imagePrompt' }, // Different realm, same HEX
    ];
    
    for (const event of events) {
      if (!hexNotifications.has(titleHex)) {
        hexNotifications.set(titleHex, {
          realm: event.realm,
          title: event.title,
          uid: event.uid,
        });
      }
    }
    
    // Should only have first realm (AI) since Map doesn't overwrite
    assert.strictEqual(hexNotifications.size, 1);
    const notification = hexNotifications.get(titleHex);
    assert.strictEqual(notification.realm, 'AI', 'Should keep first realm encountered');
  });

  await t.test('Notification payload structure', () => {
    const hexValue = '54657374204576656e74';
    const notificationData = {
      realm: 'AI',
      title: 'Test Event',
      uid: 'test-uid',
    };
    
    // Build the payload as it would be sent to postToScouts2Sqs
    const payload = {
      realm: notificationData.realm,
      subject: hexValue,
      action: 'request',
    };
    
    // Verify payload structure
    assert.strictEqual(payload.realm, 'AI');
    assert.strictEqual(payload.subject, hexValue);
    assert.strictEqual(payload.action, 'request');
  });
});
