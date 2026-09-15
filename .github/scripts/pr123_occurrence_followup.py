from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    p.write_text(text.replace(old, new, 1))


# Slack Hide must use the same occurrence-scoped persist contract as Admin.
slack = Path('lambdas/scouts-slack-handler/function/slack-handler.mjs')
text = slack.read_text()
start_marker = "                if (actionId === 'scouts_request_hide') {"
end_marker = "                if (actionId === 'scouts_request_skip') {"
start = text.index(start_marker)
end = text.index(end_marker, start)
new_hide = '''                if (actionId === 'scouts_request_hide') {
                    console.log('[Slack] Handling hide action');

                    const occurrenceId = String(actionMeta?.occurrenceId ?? eventData?.occurrenceId ?? '').trim();
                    const hex = String(eventData?.metadata?.hex ?? eventData?.hex ?? '').trim().toLowerCase();
                    if (!occurrenceId || !hex) {
                        const staleMessage = `This review is stale or ambiguous for ${eventTitle}. Refresh the review before hiding this occurrence.`;
                        console.warn('[Slack] Refusing hide without canonical occurrence selector', {
                            eventTitle,
                            occurrenceIdPresent: Boolean(occurrenceId),
                            hexPresent: Boolean(hex),
                        });
                        if (responseUrl) {
                            try {
                                await sendSlackResponse(responseUrl, staleMessage);
                            } catch (responseError) {
                                console.error('[Slack] Failed to report stale hide action:', responseError.message);
                            }
                        }
                        return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'visibility_selector_required' }) };
                    }

                    const hidePayload = {
                        realm: 'persist',
                        subject: {
                            occurrenceId,
                            metadata: {
                                hex,
                                status: { isHidden: true },
                            },
                        },
                        action: 'persist',
                        source: 'slack',
                        decisionSource: 'slack',
                        slackMetadata: {
                            channel,
                            ts,
                            responseUrl,
                            previewText,
                        },
                    };
                    console.log('[Debug] Hide payload to send to SQS:', JSON.stringify(hidePayload, null, 2));

                    try {
                        await sendToScoutsRequestQueue(hidePayload);
                        if (responseUrl) {
                            const processingBlocks = [
                                {
                                    type: 'header',
                                    text: { type: 'plain_text', text: 'Processing hide request...', emoji: true },
                                },
                                {
                                    type: 'section',
                                    text: {
                                        type: 'mrkdwn',
                                        text: `⏳ Hiding *${eventTitle}*\\n\\nPlease wait while we process your request...`,
                                    },
                                },
                            ];
                            try {
                                await sendSlackResponse(responseUrl, `Processing hide request for ${eventTitle}`, processingBlocks);
                            } catch (responseError) {
                                console.error('[Slack] Failed to replace message after hide enqueue:', responseError.message);
                            }
                        }
                    } catch (error) {
                        console.error('[Slack] Failed to send hide to scoutsRequests queue:', error.message);
                    }

                    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
                }

'''
slack.write_text(text[:start] + new_hide + text[end:])

# Preserve Slack callback metadata through compact persist routing so the canonical
# persistence worker can reconcile the originating review card after success.
router = 'lambdas/scouts2sqs/function/request-router.mjs'
old = '''    source: text(message?.source) || 'scouts2sqs',
    ...(occurrenceId ? { occurrenceId } : {}),
  };
}'''
new = '''    source: text(message?.source) || 'scouts2sqs',
    ...(occurrenceId ? { occurrenceId } : {}),
    ...(text(message?.decisionSource) ? { decisionSource: text(message.decisionSource) } : {}),
    ...(message?.slackMetadata && typeof message.slackMetadata === 'object'
      ? { slackMetadata: { ...message.slackMetadata } }
      : {}),
  };
}'''
replace_once(router, old, new, 'compact persist Slack metadata propagation')

# Approval is shared-content state. Never write occurrence visibility back into
# the shared HEX object as a side effect of approving content.
review = 'lambdas/shared-layer/nodejs/event-review.mjs'
old = '''      status: {
        isHidden: bool(snapshot.isHidden),
        isApproved: Boolean(imageUrl),
      },'''
new = '''      status: {
        isApproved: Boolean(imageUrl),
      },'''
replace_once(review, old, new, 'approval patch excludes visibility')

# Update the unit expectation and add an explicit regression for hidden occurrence review.
review_test = 'lambdas/shared-layer/nodejs/event-review.test.mjs'
old = '''    status: {
      isHidden: false,
      isApproved: false,
    },'''
new = '''    status: {
      isApproved: false,
    },'''
replace_once(review_test, old, new, 'approval patch test expectation')
p = Path(review_test)
text = p.read_text()
marker = "test('approval patch never writes occurrence visibility into shared metadata'"
if marker not in text:
    text += '''\n\ntest('approval patch never writes occurrence visibility into shared metadata', () => {
  const hidden = event({
    metadata: {
      ...event().metadata,
      status: { ...event().metadata.status, isHidden: true },
    },
  });
  const snapshot = buildEventReviewSnapshot(hidden);
  const patch = buildApprovedSnapshotPatch(snapshot);
  assert.equal(Object.prototype.hasOwnProperty.call(patch.metadata.status, 'isHidden'), false);
  assert.equal(patch.metadata.status.isApproved, false);
});
'''
    p.write_text(text)

# Lock the Slack contract in the existing cross-channel integration test.
issue94 = 'tests/issue-94-admin-slack-sync.integration.test.mjs'
p = Path(issue94)
text = p.read_text()
marker = "test('Slack hide requires and forwards a canonical occurrence selector'"
if marker not in text:
    text += r'''

test('Slack hide requires and forwards a canonical occurrence selector', () => {
  const handler = readFileSync('lambdas/scouts-slack-handler/function/slack-handler.mjs', 'utf8');
  const router = readFileSync('lambdas/scouts2sqs/function/request-router.mjs', 'utf8');
  assert.match(handler, /actionMeta\?\.occurrenceId \?\? eventData\?\.occurrenceId/);
  assert.match(handler, /error: 'visibility_selector_required'/);
  assert.match(handler, /realm: 'persist'[\s\S]*status: \{ isHidden: true \}[\s\S]*action: 'persist'/);
  assert.match(router, /slackMetadata:[\s\S]*message\.slackMetadata/);
  assert.match(router, /decisionSource/);
});
'''
    p.write_text(text)
