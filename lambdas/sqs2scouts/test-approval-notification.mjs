#!/usr/bin/env node

/**
 * Test script to generate a Slack approval notification
 * This simulates the approval workflow with editable input fields
 */

import { lambdaHandler } from './function/persistence-processor.mjs';

async function testApprovalNotification() {
    console.log('🧪 Testing approval notification with editable fields...\n');

    // Create a test event that simulates an SQS message for approval
    const testEvent = {
        Records: [
            {
                body: JSON.stringify({
                    realm: 'scouts',
                    action: 'approval',
                    subject: {
                        hex: 'test123',
                        title: 'Test Scout Event',
                        AI: 'Join us for an amazing adventure!',
                        image: {
                            prompt: 'outdoor camping adventure',
                            url: 'https://example.com/test-image.jpg'
                        },
                        section: 'Beavers',
                        location: 'Scout Hut',
                        start: {
                            iso: '2024-02-15T19:00:00Z'
                        },
                        description: 'A fun evening activity for all scouts'
                    }
                })
            }
        ]
    };

    try {
        console.log('📤 Sending test approval request...');
        console.log('Event data:', JSON.stringify(testEvent.Records[0].body, null, 2));
        console.log('');

        const result = await lambdaHandler(testEvent);
        
        console.log('✅ Test completed successfully!');
        console.log('Response:', JSON.stringify(result, null, 2));
        console.log('');
        console.log('📋 Expected behavior:');
        console.log('1. A Slack notification should be sent to #scouts-website channel');
        console.log('2. The notification should contain editable input fields for:');
        console.log('   - AI Tagline (pre-filled with current value)');
        console.log('   - Image Prompt (pre-filled with current value)');
        console.log('   - Image URL (pre-filled with current value)');
        console.log('3. The notification should have OK/Skip/Hide buttons');
        console.log('4. When OK is clicked, the updated values from inputs should be sent');
        console.log('5. No "Edit" button should be present');
        console.log('');
        console.log('🔍 Check the #scouts Slack channel to verify the notification format');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('Stack trace:', error.stack);
        process.exit(1);
    }
}

// Run the test
testApprovalNotification().catch(console.error);
