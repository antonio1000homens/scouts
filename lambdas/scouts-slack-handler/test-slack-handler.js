#!/usr/bin/env node

/**
 * Test script for slack-handler Lambda function
 * Tests the "Approve" action using the payload from hex.json
 */

import https from 'https';
import http from 'http';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const SLACK_HANDLER_URL = process.env.SLACK_HANDLER_URL || 'https://2ks2mbvlaicmsi5mahempusjpy0kgltx.lambda-url.eu-west-2.on.aws/';
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'b044697a622f05dfcf0520af822edb8a';

/**
 * Load the Slack payload from hex.json
 */
function loadPayload() {
    try {
        const payloadPath = path.join(__dirname, 'hex.json');
        const content = readFileSync(payloadPath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error('Error loading hex.json:', error.message);
        process.exit(1);
    }
}

/**
 * Create a signed request for Slack
 */
function createSignedRequest(payload) {
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const baseString = `v0:${timestamp}:${body}`;
    const signature = `v0=${crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(baseString).digest('hex')}`;
    
    return {
        body,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Slack-Request-Timestamp': timestamp.toString(),
            'X-Slack-Signature': signature,
            'User-Agent': 'slack-handler-test/1.0',
            'Content-Length': Buffer.byteLength(body)
        }
    };
}

/**
 * Send the request to the slack-handler
 */
async function sendRequest(payload) {
    return new Promise((resolve, reject) => {
        const { body, headers } = createSignedRequest(payload);
        const url = new URL(SLACK_HANDLER_URL);
        
        // Choose http or https based on URL protocol
        const transport = url.protocol === 'https:' ? https : http;
        
        const options = {
            method: 'POST',
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            headers
        };
        
        console.log(`Sending request to: ${SLACK_HANDLER_URL}`);
        console.log(`Protocol: ${url.protocol}`);
        
        const req = transport.request(options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => responseData += chunk);
            res.on('end', () => {
                try {
                    const parsedResponse = JSON.parse(responseData);
                    resolve({ 
                        statusCode: res.statusCode, 
                        body: parsedResponse,
                        headers: res.headers
                    });
                } catch (error) {
                    resolve({ 
                        statusCode: res.statusCode, 
                        body: responseData,
                        headers: res.headers
                    });
                }
            });
        });
        
        req.on('error', (error) => {
            reject(error);
        });
        
        req.write(body);
        req.end();
    });
}

/**
 * Decode and display the payload details
 */
function displayPayloadInfo(payload) {
    console.log('\n=== Payload Information ===');
    console.log(`Action ID: ${payload.actions[0].action_id}`);
    console.log(`Action Type: ${payload.actions[0].text.text}`);
    console.log(`Channel: ${payload.channel.name} (${payload.channel.id})`);
    console.log(`User: ${payload.user.name} (${payload.user.username})`);
    
    try {
        const actionValue = JSON.parse(payload.actions[0].value);
        console.log(`\nAction Value:`);
        console.log(`  Decision: ${actionValue.decision}`);
        console.log(`  Function URL: ${actionValue.functionUrl}`);
        
        // Decode the base64 payload
        const decodedPayload = Buffer.from(actionValue.payload, 'base64').toString('utf8');
        const parsedPayload = JSON.parse(decodedPayload);
        console.log(`\nDecoded Payload:`);
        console.log(`  Realm: ${parsedPayload.realm}`);
        console.log(`  Action: ${parsedPayload.action}`);
        console.log(`  Subject:`);
        console.log(`    HEX: ${parsedPayload.subject.hex}`);
        console.log(`    UID: ${parsedPayload.subject.uid}`);
        console.log(`    Title: ${parsedPayload.subject.title}`);
        console.log(`    AI: ${parsedPayload.subject.AI}`);
        if (parsedPayload.subject.image) {
            console.log(`    Image Prompt: ${parsedPayload.subject.image.prompt}`);
            console.log(`    Image URL: ${parsedPayload.subject.image.url}`);
        }
    } catch (error) {
        console.error('Error decoding action value:', error.message);
    }
}

/**
 * Main test function
 */
async function main() {
    console.log('===================================');
    console.log('Slack Handler Test Script');
    console.log('===================================');
    
    // Load payload from hex.json
    const payload = loadPayload();
    console.log('✓ Loaded payload from hex.json');
    
    // Display payload information
    displayPayloadInfo(payload);
    
    console.log('\n=== Sending Request ===');
    
    try {
        const response = await sendRequest(payload);
        
        console.log('\n=== Response ===');
        console.log(`Status Code: ${response.statusCode}`);
        console.log(`Response Body:`, JSON.stringify(response.body, null, 2));
        
        if (response.statusCode === 200) {
            console.log('\n✅ Test PASSED - Approve action processed successfully');
        } else {
            console.log('\n❌ Test FAILED - Unexpected status code');
            process.exit(1);
        }
    } catch (error) {
        console.log('\n❌ Test FAILED - Request error');
        console.error('Error:', error.message);
        process.exit(1);
    }
}

// Run the test
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
