import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const runtimeActivity = readFileSync('lambdas/scouts/function/runtime-activity.mjs', 'utf8');
const activityCentre = readFileSync('website/admin/admin-activity-centre.js', 'utf8');
const approvalWorkflow = readFileSync('website/admin/admin-approval-workflow.js', 'utf8');
const slackProxy = readFileSync('lambdas/scouts-slack-handler/function/slack-handler-proxy.mjs', 'utf8');

function assertSyntax(path) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path} syntax check failed:\n${result.stderr}`);
}

test('issue 91 backend owns canonical user-facing workflow presentation', () => {
  assert.match(runtimeActivity, /function canonicalDisplay\(request = \{\}\)/);
  assert.match(runtimeActivity, /awaiting_review[\s\S]*Published — awaiting image approval/);
  assert.match(runtimeActivity, /awaiting_image[\s\S]*Generating image — final review required/);
  assert.match(runtimeActivity, /displayState/);
  assert.match(runtimeActivity, /displayMessage/);
  assert.match(runtimeActivity, /timeline[\s\S]*canonicalDisplay\(entry\)/);
});

test('issue 91 admin activity consumes canonical display state and refreshes reviewable publication', () => {
  assert.match(activityCentre, /request\?\.displayMessage/);
  assert.match(activityCentre, /request\.state === 'awaiting_review'/);
  assert.match(activityCentre, /request\.publication === 'published'/);
  assert.match(activityCentre, /await window\.loadEvents/);
  assert.match(activityCentre, /window\.updateModalContent\(\)/);
  assert.match(activityCentre, /const changed = \[\]/);
  assert.match(activityCentre, /await reconcileAgenda\(changed\)/);
  assert.match(activityCentre, /result\?\.rootRequestId \|\| result\?\.requestId/);
  assert.doesNotMatch(activityCentre, /request\.action \|\| 'change' ·/);
});

test('issue 91 admin final generated-image review keeps the original root and uses specific copy', () => {
  assert.match(approvalWorkflow, /workflow\?\.state === 'awaiting_review'/);
  assert.match(approvalWorkflow, /workflow\?\.source === 'generated_image'/);
  assert.match(approvalWorkflow, /Approve generated image/);
  assert.match(approvalWorkflow, /rootRequestId: workflow\.rootRequestId/);
  assert.match(approvalWorkflow, /!result\?\.requiresGeneratedImage/);
  assert.match(approvalWorkflow, /Activity Centre owns that long-lived phase/);
});

test('issue 91 Slack labels generated review only when the action explicitly identifies it', () => {
  assert.match(slackProxy, /generatedReview = meta\?\.action === 'approve_generated_image'/);
  assert.match(slackProxy, /generatedReview \? 'Approve generated image' : 'Approve shown changes'/);
  assert.match(slackProxy, /action: generatedReview \? 'approve_generated_image' : 'approve_shown_changes'/);
  assert.doesNotMatch(slackProxy, /text: \{ type: 'plain_text', text: imageUrl \? 'Approve generated image'/);
});

test('issue 91 presentation files remain syntactically valid', () => {
  for (const path of [
    'lambdas/scouts/function/runtime-activity.mjs',
    'website/admin/admin-activity-centre.js',
    'website/admin/admin-approval-workflow.js',
    'lambdas/scouts-slack-handler/function/slack-handler-proxy.mjs',
  ]) assertSyntax(path);
});