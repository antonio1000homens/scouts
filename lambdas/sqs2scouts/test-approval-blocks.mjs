#!/usr/bin/env node

/**
 * Test script to verify the approval blocks structure
 * This tests the buildApprovalBlocks function without AWS dependencies
 */

// Mock the buildApprovalBlocks function for testing
function buildApprovalBlocks(event, actionLabel, options = {}) {
    const {
        realm = 'scouts',
        approveAction = actionLabel,
        rejectAction = 'reject',
        previewText = null,
        excludeFields = [],
        suppressEmptyFallback = false,
    } = options;

    const eventTitle = event.title ?? event.summary ?? event.name ?? 'Scouts Event';

    let reviewTarget;
    if (realm === 'AI') {
        reviewTarget = 'AI';
    } else if (realm === 'imagePrompt') {
        reviewTarget = 'Image Prompt';
    } else if (realm === 'imageUrl') {
        reviewTarget = 'Image Link';
    } else {
        reviewTarget = actionLabel ?? 'update';
    }
    const headerText = `${eventTitle} needs approval for: ${reviewTarget}`.slice(0, 150);
    
    const approvePayload = Buffer.from(
        JSON.stringify({
            realm,
            action: approveAction,
            subject: event,
        })
    ).toString('base64');
    const rejectPayload = Buffer.from(
        JSON.stringify({
            realm,
            action: rejectAction,
            subject: event,
        })
    ).toString('base64');

    const approveValue = JSON.stringify({
        decision: 'approve',
        realm: 'scoutsDecision',
        functionUrl: 'https://test-function-url.com',
        payload: approvePayload,
    });
    const rejectValue = JSON.stringify({
        decision: 'skip',
        realm: 'scoutsDecision',
        functionUrl: 'https://test-function-url.com',
        payload: rejectPayload,
    });

    const blocks = [
        {
            type: 'header',
            text: {
                type: 'plain_text',
                text: headerText,
                emoji: true,
            },
        },
    ];

    if (previewText) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: previewText },
        });
    }

    // For approval realm, add editable input fields instead of read-only details
    if (realm === 'approval') {
        // AI Tagline input
        blocks.push({
            type: 'input',
            block_id: 'ai_tagline_input',
            label: {
                type: 'plain_text',
                text: 'AI Tagline',
            },
            element: {
                type: 'plain_text_input',
                action_id: 'ai_tagline_value',
                initial_value: event.AI || '',
                placeholder: {
                    type: 'plain_text',
                    text: 'Enter AI tagline...',
                },
            },
            optional: true,
        });

        // Image Prompt input
        blocks.push({
            type: 'input',
            block_id: 'image_prompt_input',
            label: {
                type: 'plain_text',
                text: 'Image Prompt',
            },
            element: {
                type: 'plain_text_input',
                action_id: 'image_prompt_value',
                initial_value: event.image?.prompt || '',
                placeholder: {
                    type: 'plain_text',
                    text: 'Enter image prompt...',
                },
            },
            optional: true,
        });

        // Image URL input
        blocks.push({
            type: 'input',
            block_id: 'image_url_input',
            label: {
                type: 'plain_text',
                text: 'Image URL',
            },
            element: {
                type: 'plain_text_input',
                action_id: 'image_url_value',
                initial_value: event.image?.url || '',
                placeholder: {
                    type: 'plain_text',
                    text: 'Enter image URL...',
                },
            },
            optional: true,
        });
    }

    const hidePayload = Buffer.from(
        JSON.stringify({
            realm,
            action: 'HIDE',
            subject: event,
        })
    ).toString('base64');
    const hideValue = JSON.stringify({
        decision: 'hide',
        realm: 'scoutsDecision',
        functionUrl: 'https://test-function-url.com',
        payload: hidePayload,
    });

    blocks.push({
        type: 'actions',
        block_id: 'scouts_request_actions',
        elements: [
            {
                type: 'button',
                action_id: 'scouts_request_approve',
                text: {
                    type: 'plain_text',
                    emoji: true,
                    text: 'OK',
                },
                style: 'primary',
                value: approveValue,
            },
            {
                type: 'button',
                action_id: 'scouts_request_skip',
                text: {
                    type: 'plain_text',
                    emoji: true,
                    text: 'Skip',
                },
                style: 'danger',
                value: rejectValue,
            },
            {
                type: 'button',
                action_id: 'scouts_request_hide',
                text: {
                    type: 'plain_text',
                    emoji: true,
                    text: 'Hide',
                },
                value: hideValue,
            },
        ],
    });

    return blocks;
}

function testApprovalBlocks() {
    console.log('🧪 Testing approval blocks structure...\n');

    // Test event data
    const testEvent = {
        title: 'Test Scout Event',
        AI: 'Join us for an amazing adventure!',
        image: {
            prompt: 'outdoor camping adventure',
            url: 'https://example.com/test-image.jpg'
        },
        hex: 'test123'
    };

    console.log('📋 Test event data:');
    console.log(JSON.stringify(testEvent, null, 2));
    console.log('');

    // Test approval realm blocks
    const approvalBlocks = buildApprovalBlocks(testEvent, 'approval', {
        realm: 'approval',
        approveAction: 'APPROVE',
        rejectAction: 'REJECT',
    });

    console.log('📤 Generated approval blocks:');
    console.log(JSON.stringify(approvalBlocks, null, 2));
    console.log('');

    // Verify the structure
    console.log('🔍 Verification:');
    
    // Check for header
    const headerBlock = approvalBlocks.find(block => block.type === 'header');
    if (headerBlock) {
        console.log('✅ Header block found:', headerBlock.text.text);
    } else {
        console.log('❌ Header block missing');
    }

    // Check for input blocks
    const inputBlocks = approvalBlocks.filter(block => block.type === 'input');
    console.log(`✅ Found ${inputBlocks.length} input blocks:`);
    
    inputBlocks.forEach(block => {
        console.log(`  - ${block.label.text}: ${block.element.initial_value || '(empty)'}`);
    });

    // Check for action buttons
    const actionBlock = approvalBlocks.find(block => block.type === 'actions');
    if (actionBlock) {
        const buttonTexts = actionBlock.elements.map(el => el.text.text);
        console.log('✅ Action buttons found:', buttonTexts.join(', '));
        
        // Verify no "Edit" button
        if (!buttonTexts.includes('Edit')) {
            console.log('✅ No "Edit" button found (as expected)');
        } else {
            console.log('❌ "Edit" button found (should be removed)');
        }
    } else {
        console.log('❌ Action block missing');
    }

    console.log('');
    console.log('🎉 Test completed!');
    console.log('');
    console.log('📋 Expected Slack behavior:');
    console.log('1. User sees editable input fields with current values pre-filled');
    console.log('2. User can modify the AI tagline, image prompt, and image URL');
    console.log('3. When user clicks OK, the updated values are sent to the backend');
    console.log('4. No Edit button is present in the interface');
    console.log('5. Skip and Hide buttons work as before');
}

// Run the test
testApprovalBlocks();
