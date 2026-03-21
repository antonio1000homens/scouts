#!/usr/bin/env node

/**
 * Test script to verify remote image URL detection logic
 */

function isRemoteImageUrl(imageUrl) {
    if (!imageUrl || typeof imageUrl !== 'string') return false;
    
    const url = imageUrl.trim();
    return /^https?:\/\//.test(url);
}

// Test cases
const testUrls = [
    // Remote image URLs (should return true)
    'https://images.example.com/ge301403808a4345758b70721956d0b9a0c013c1c9e714199151724c37ae6458f773e2af096d76c0d68a97efa6ccfcd849a4901f7f13e370c36079b6afb2773dc_640.jpg',
    'https://cdn.example.com/photo/2023/01/15/12/34/image-123456_640.jpg',
    'https://media.example.net/get/g123abc456def789.jpg',
    'http://www.example.org/some/path/image.jpg',
    
    // Non-remote URLs (should return false)
    '/website/eventImages/image.jpg',
    'images/image.jpg',
    'event-image.webp',
    'not-a-url',
    
    // Edge cases
    '',
    null,
    undefined,
    'ftp://example.com/image.jpg'
];

console.log('Testing remote image URL detection...\n');

testUrls.forEach((url, index) => {
    const result = isRemoteImageUrl(url);
    const expected = typeof url === 'string' && /^https?:\/\//.test(url);
    const status = result === expected ? '✅' : '❌';
    
    console.log(`${status} Test ${index + 1}: ${result ? 'REMOTE' : 'NOT REMOTE'}`);
    console.log(`   URL: ${url || 'null/undefined'}`);
    if (result !== expected) {
        console.log(`   ⚠️  Expected: ${expected}, Got: ${result}`);
    }
    console.log('');
});

console.log('Test completed!');
