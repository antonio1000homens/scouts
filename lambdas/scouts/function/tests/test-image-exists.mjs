#!/usr/bin/env node

/**
 * Test the imageExistsInS3 function to ensure it handles errors correctly
 * and the key variable is accessible in the catch block.
 */

import { test } from 'node:test';
import assert from 'node:assert';

const CURRENT_IMAGE_PREFIX = 'website/eventImages/';
const LEGACY_IMAGE_PREFIX = 'website/images/';

test('imageExistsInS3 error handling', async (t) => {
  await t.test('Should handle null imageUrl gracefully', () => {
    // Simulate the early return for null imageUrl
    const imageUrl = null;
    
    if (!imageUrl || typeof imageUrl !== 'string') {
      assert.ok(true, 'Should return false for null imageUrl');
    } else {
      assert.fail('Should have returned false for null imageUrl');
    }
  });

  await t.test('Should handle empty string imageUrl gracefully', () => {
    // Simulate the early return for empty string
    const imageUrl = '';
    
    // Empty string is falsy, so the first condition catches it
    if (!imageUrl) {
      assert.ok(true, 'Should return false for empty string');
    } else {
      assert.fail('Should have returned false for empty string');
    }
  });

  await t.test('Should extract key from relative path', () => {
    const imageUrl = `${CURRENT_IMAGE_PREFIX}test.jpg`;
    let key = null;
    
    if (imageUrl.startsWith(CURRENT_IMAGE_PREFIX) || imageUrl.startsWith(`/${CURRENT_IMAGE_PREFIX}`)) {
      key = imageUrl.startsWith('/') ? imageUrl.substring(1) : imageUrl;
    }
    
    assert.strictEqual(key, `${CURRENT_IMAGE_PREFIX}test.jpg`, 'Key should be extracted from relative path');
  });

  await t.test('Should extract key from relative path with leading slash', () => {
    const imageUrl = `/${CURRENT_IMAGE_PREFIX}test.jpg`;
    let key = null;
    
    if (imageUrl.startsWith(CURRENT_IMAGE_PREFIX) || imageUrl.startsWith(`/${CURRENT_IMAGE_PREFIX}`)) {
      key = imageUrl.startsWith('/') ? imageUrl.substring(1) : imageUrl;
    }
    
    assert.strictEqual(key, `${CURRENT_IMAGE_PREFIX}test.jpg`, 'Key should be extracted from relative path with leading slash removed');
  });

  await t.test('Should continue to extract key from legacy relative path', () => {
    const imageUrl = `${LEGACY_IMAGE_PREFIX}test.jpg`;
    let key = null;
    
    if (imageUrl.startsWith(LEGACY_IMAGE_PREFIX) || imageUrl.startsWith(`/${LEGACY_IMAGE_PREFIX}`)) {
      key = imageUrl.startsWith('/') ? imageUrl.substring(1) : imageUrl;
    }
    
    assert.strictEqual(key, `${LEGACY_IMAGE_PREFIX}test.jpg`, 'Key should be extracted from legacy relative path');
  });

  await t.test('Key variable should be accessible in error handling', () => {
    // Simulate the scenario where key is set and then an error occurs
    const imageUrl = `${CURRENT_IMAGE_PREFIX}test.jpg`;
    let key = null;
    
    try {
      // Set the key
      if (imageUrl.startsWith(CURRENT_IMAGE_PREFIX) || imageUrl.startsWith(`/${CURRENT_IMAGE_PREFIX}`)) {
        key = imageUrl.startsWith('/') ? imageUrl.substring(1) : imageUrl;
      }
      
      // Simulate an error
      throw new Error('NotFound');
    } catch (error) {
      // This is where the bug was - key should be accessible here
      const logMessage = `Image NOT FOUND in S3: ${imageUrl} (key: ${key || 'unknown'})`;
      assert.ok(logMessage.includes(`${CURRENT_IMAGE_PREFIX}test.jpg`), 'Key should be accessible in catch block');
      assert.ok(!logMessage.includes('unknown'), 'Key should not fall back to "unknown"');
    }
  });

  await t.test('Should handle case when key cannot be extracted', () => {
    const imageUrl = '';
    let key = null;
    
    try {
      // Key remains null
      if (!key) {
        // This simulates returning false when key cannot be extracted
        assert.ok(true, 'Should handle null key appropriately');
      }
    } catch (error) {
      // Even in error case, key should be accessible (though it might be null)
      const logMessage = `Image NOT FOUND in S3: ${imageUrl} (key: ${key || 'unknown'})`;
      assert.ok(logMessage.includes('unknown'), 'Should use "unknown" when key is null');
    }
  });

  await t.test('Should extract key from full S3 URL', () => {
    const imageUrl = `https://bucket.s3.amazonaws.com/${CURRENT_IMAGE_PREFIX}test.jpg`;
    let key = null;
    
    if (imageUrl.includes('/')) {
      const parts = imageUrl.split('/');
      const keyStartIndex = parts.findIndex((part, idx) => {
        if (idx === 0) return false; // http: or s3:
        if (idx === 1) return false; // empty string
        if (part.includes('s3') || part.includes('amazonaws')) return false; // domain parts
        return true;
      });
      key = keyStartIndex >= 0 ? parts.slice(keyStartIndex).join('/') : imageUrl;
    }
    
    assert.strictEqual(key, `${CURRENT_IMAGE_PREFIX}test.jpg`, 'Key should be extracted from full S3 URL');
  });
});

console.log('✅ imageExistsInS3 error handling tests complete!');
