#!/usr/bin/env node

/**
 * Test script to verify Pixabay URL detection logic
 */

function isPixabayUrl(imageUrl) {
    if (!imageUrl || typeof imageUrl !== 'string') return false;
    
    const url = imageUrl.trim();
    return url.includes('pixabay.com') || 
           url.includes('cdn.pixabay.com') ||
           /pixabay\.com\/get\//.test(url);
}

// Test cases
const testUrls = [
    // Pixabay URLs (should return true)
    'https://pixabay.com/get/ge301403808a4345758b70721956d0b9a0c013c1c9e714199151724c37ae6458f773e2af096d76c0d68a97efa6ccfcd849a4901f7f13e370c36079b6afb2773dc_640.jpg',
    'https://cdn.pixabay.com/photo/2023/01/15/12/34/image-123456_640.jpg',
    'https://pixabay.com/get/g123abc456def789.jpg',
    'https://www.pixabay.com/some/path/image.jpg',
    
    // Non-Pixabay URLs (should return false)
    'https://example.com/image.jpg',
    'https://s3.amazonaws.com/bucket/image.jpg',
    'https://2ndtolworth.s3-website.eu-west-2.amazonaws.com/images/image.jpg',
    'https://unsplash.com/photo/123/download',
    
    // Edge cases
    '',
    null,
    undefined,
    'not-a-url',
    'https://notpixabay.com/image.jpg'
];

console.log('Testing Pixabay URL detection...\n');

testUrls.forEach((url, index) => {
    const result = isPixabayUrl(url);
    const expected = url && typeof url === 'string' && 
                    (url.includes('pixabay.com') || url.includes('cdn.pixabay.com'));
    const status = result === expected ? '✅' : '❌';
    
    console.log(`${status} Test ${index + 1}: ${result ? 'PIXABAY' : 'NOT PIXABAY'}`);
    console.log(`   URL: ${url || 'null/undefined'}`);
    if (result !== expected) {
        console.log(`   ⚠️  Expected: ${expected}, Got: ${result}`);
    }
    console.log('');
});

console.log('Test completed!');