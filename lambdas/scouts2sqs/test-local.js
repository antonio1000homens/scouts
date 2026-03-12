#!/usr/bin/env node

import https from 'https';

// Configuration
const FUNCTION_URL = process.env.FUNCTION_URL || 'https://hnpooqvuwzt2rvpqtxfngfvhrq0nxngr.lambda-url.eu-west-2.on.aws/';
const API_KEY = process.env.REQUIRED_API_KEY || '';

// Test payloads
const testCases = [
    {
        name: 'Valid scouts message',
        payload: {
            realm: 'scouts',
            subject: 'test-scout-001',
            action: 'scoutScan'
        }
    },
    {
        name: 'Another scouts message',
        payload: {
            realm: 'scouts', 
            subject: 'badge-ceremony',
            action: 'event'
        }
    },
    {
        name: 'Missing subject (should fail)',
        payload: {
            realm: 'scouts',
            action: 'test'
        }
    }
];

async function testFunction(testCase) {
    console.log(`\n🧪 Testing: ${testCase.name}`);
    console.log(`📤 Payload:`, JSON.stringify(testCase.payload, null, 2));
    
    const postData = JSON.stringify(testCase.payload);
    
    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            'x-api-key': API_KEY
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(FUNCTION_URL, options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => responseData += chunk);
            res.on('end', () => {
                console.log(`📥 Status: ${res.statusCode}`);
                try {
                    const response = JSON.parse(responseData);
                    console.log(`📥 Response:`, JSON.stringify(response, null, 2));
                    resolve({ status: res.statusCode, data: response });
                } catch (e) {
                    console.log(`📥 Raw Response:`, responseData);
                    resolve({ status: res.statusCode, data: responseData });
                }
            });
        });

        req.on('error', (error) => {
            console.error(`❌ Error:`, error.message);
            reject(error);
        });

        req.write(postData);
        req.end();
    });
}

async function runTests() {
    console.log('🚀 Starting scouts2sqs Lambda tests...');
    console.log(`🎯 Target URL: ${FUNCTION_URL}`);
    
    if (FUNCTION_URL.includes('your-function-url-here')) {
        console.error('❌ Please update FUNCTION_URL with your actual Lambda function URL');
        process.exit(1);
    }

    if (!API_KEY) {
        console.error('❌ Set REQUIRED_API_KEY in your environment before running this test');
        process.exit(1);
    }

    for (const testCase of testCases) {
        try {
            await testFunction(testCase);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s between tests
        } catch (error) {
            console.error(`❌ Test failed: ${testCase.name}`, error.message);
        }
    }
    
    console.log('\n✅ All tests completed!');
    console.log('\n💡 Check your scoutsProcessing SQS queue and Slack #scouts channel for messages');
}

runTests().catch(console.error);
