#!/usr/bin/env node

/**
 * Test script to verify input field extraction from Slack payloads
 */

// Mock the extractInputValues function for testing
function extractInputValues(parsedPayload) {
    const state = parsedPayload.state?.values || {};
    const extracted = {};
    
    // Extract AI tagline
    if (state.ai_tagline_input?.ai_tagline_value?.value) {
        extracted.AI = state.ai_tagline_input.ai_tagline_value.value.trim();
    }
    
    // Extract image prompt
    if (state.image_prompt_input?.image_prompt_value?.value) {
        extracted.imagePrompt = state.image_prompt_input.image_prompt_value.value.trim();
    }
    
    // Extract image URL
    if (state.image_url_input?.image_url_value?.value) {
        extracted.imageUrl = state.image_url_input.image_url_value.value.trim();
    }
    
    return extracted;
}

function testInputExtraction() {
    console.log('🧪 Testing Slack input field extraction...\n');

    // Mock Slack payload with input values
    const mockSlackPayload = {
        state: {
            values: {
                ai_tagline_input: {
                    ai_tagline_value: {
                        value: 'Updated AI tagline from user input!'
                    }
                },
                image_prompt_input: {
                    image_prompt_value: {
                        value: 'scouts hiking mountain adventure'
                    }
                },
                image_url_input: {
                    image_url_value: {
                        value: 'https://updated-image-url.com/new-image.jpg'
                    }
                }
            }
        }
    };

    console.log('📥 Mock Slack payload:');
    console.log(JSON.stringify(mockSlackPayload, null, 2));
    console.log('');

    const extracted = extractInputValues(mockSlackPayload);
    
    console.log('📤 Extracted values:');
    console.log(JSON.stringify(extracted, null, 2));
    console.log('');

    // Verify extraction
    const expectedValues = {
        AI: 'Updated AI tagline from user input!',
        imagePrompt: 'scouts hiking mountain adventure',
        imageUrl: 'https://updated-image-url.com/new-image.jpg'
    };

    let allCorrect = true;
    for (const [key, expectedValue] of Object.entries(expectedValues)) {
        if (extracted[key] !== expectedValue) {
            console.error(`❌ Mismatch for ${key}: expected "${expectedValue}", got "${extracted[key]}"`);
            allCorrect = false;
        } else {
            console.log(`✅ ${key}: correctly extracted`);
        }
    }

    if (allCorrect) {
        console.log('\n🎉 All input values extracted correctly!');
        console.log('\n📋 Next steps:');
        console.log('1. Run the approval notification test to generate a Slack message');
        console.log('2. Verify the input fields appear in the Slack notification');
        console.log('3. Test the complete approval flow by clicking OK in Slack');
    } else {
        console.log('\n❌ Some input values were not extracted correctly');
        process.exit(1);
    }
}

// Run the test
testInputExtraction();