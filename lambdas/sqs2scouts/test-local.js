#!/usr/bin/env node

// Test script for sqs2scouts Lambda function
// This simulates SQS messages being sent to the function

import { lambdaHandler } from './function/sqs2scouts.mjs';

// Mock SQS events
const testEvents = [
    {
        name: 'Valid scouts message',
        event: {
            Records: [
                {
                    body: JSON.stringify({
                        realm: 'scouts',
                        subject: 'test-scout-001',
                        action: 'scoutScan'
                    })
                }
            ]
        }
    },
    {
        name: 'Badge ceremony event',
        event: {
            Records: [
                {
                    body: JSON.stringify({
                        realm: 'scouts',
                        subject: 'badge-ceremony',
                        action: 'event'
                    })
                }
            ]
        }
    },
    {
        name: 'Empty records (should fail)',
        event: {
            Records: []
        }
    }
];

async function runTests() {
    console.log('🚀 Starting sqs2scouts Lambda tests...\n');
    
    for (const testCase of testEvents) {
        console.log(`🧪 Testing: ${testCase.name}`);
        console.log(`📤 Event:`, JSON.stringify(testCase.event, null, 2));
        
        try {
            const result = await lambdaHandler(testCase.event);
            console.log(`📥 Status: ${result.statusCode}`);
            console.log(`📥 Response:`, JSON.stringify(JSON.parse(result.body), null, 2));
        } catch (error) {
            console.error(`❌ Error:`, error.message);
        }
        
        console.log(''); // Empty line between tests
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s between tests
    }
    
    console.log('✅ All tests completed!');
    console.log('💡 Check your Slack #scouts channel for messages');
}

runTests().catch(console.error);