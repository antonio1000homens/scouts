from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected 1 occurrence, got {count}')
    return text.replace(old, new, 1)


# Preserve the legacy image-prompt compatibility that previously lived in the
# diagnostics render enhancer, but put it in the canonical event action model.
path = Path('website/admin/admin-script.js')
text = path.read_text()
text = replace_once(
    text,
    "    if (missingFields.length === 1 && missingFields[0] === 'Image URL' && hasText(getImageTheme(event))) {",
    "    if (missingFields.length === 1 && missingFields[0] === 'Image URL' && hasText(getImageThemeOrLegacyPrompt(event))) {",
    'canonical direct-image prerequisite',
)
path.write_text(text)

# isEventReadyForApproval is internal to the approval owner; consumers use the
# registered controller instead of another mutable global hook.
path = Path('website/admin/admin-approval-workflow.js')
text = path.read_text()
text = text.replace('    window.isEventReadyForApproval = isEventReadyForApproval;\n', '')
path.write_text(text)

# Issue 43 assertions now follow the consolidated ownership boundaries.
path = Path('tests/issue-43-dlq-admin-enhancements.test.mjs')
text = path.read_text()
text = replace_once(
    text,
    "const adminEnhancements = readFileSync('website/admin/admin-diagnostics-enhancements.js', 'utf8');\nconst adminHtml = readFileSync('website/admin/index.html', 'utf8');",
    "const adminEnhancements = readFileSync('website/admin/admin-diagnostics-enhancements.js', 'utf8');\nconst adminScript = readFileSync('website/admin/admin-script.js', 'utf8');\nconst activityCentre = readFileSync('website/admin/admin-activity-centre.js', 'utf8');\nconst adminHtml = readFileSync('website/admin/index.html', 'utf8');",
    'issue43 source ownership',
)
old = '''test('status polling remains read-only and browser Auto Lambda is replaced by AWS scheduled refresh', () => {
  assert.match(adminEnhancements, /setAutoLambdaInvocationEnabled\\(false, true\\)/);
  assert.match(adminEnhancements, /Scheduled refresh/);
  assert.match(adminEnhancements, /EventBridge scheduled calendar refresh/);
  assert.match(adminEnhancements, /Status polling refreshes the canonical request lifecycle, queue counts and Step Functions status/);
  assert.match(adminEnhancements, /It does not invoke workers, create requests or process queues/);
  assert.match(adminEnhancements, /label\\.append\\(document\\.createTextNode\\(' Status polling'\\)\\)/);
});'''
new = '''test('status polling remains read-only and browser Auto Lambda is replaced by AWS scheduled refresh', () => {
  assert.match(adminEnhancements, /setAutoLambdaInvocationEnabled\\(false, false\\)/);
  assert.match(adminEnhancements, /Scheduled calendar refresh/);
  assert.match(adminEnhancements, /EventBridge refreshes all configured calendars/);
  assert.match(activityCentre, /activityCommand\\('status'\\)/);
  assert.match(activityCentre, /sendScoutsReadCommand/);
  assert.doesNotMatch(activityCentre, /window\\.sendScoutsCommand\\s*=(?!=)/);
});'''
text = replace_once(text, old, new, 'issue43 polling assertions')
old = '''test('event cards expose Request Image only when image is absent and theme or prompt exists', () => {
  assert.match(adminEnhancements, /getImageThemeOrLegacyPrompt/);
  assert.match(adminEnhancements, /imageMissing: !imageUrl/);
  assert.match(adminEnhancements, /ready: Boolean\\(hex && !imageUrl && imageThemeOrPrompt\\)/);
  assert.match(adminEnhancements, /event-direct-image-request/);
  assert.match(adminEnhancements, /Request Image/);
  assert.match(adminEnhancements, /action: 'generateImage'/);
  assert.match(adminEnhancements, /subject: \\{ hex: prerequisites\\.hex \\}/);
});'''
new = '''test('event cards expose direct image generation only when image is absent and theme or legacy prompt exists', () => {
  assert.match(adminScript, /missingFields\\.length === 1/);
  assert.match(adminScript, /missingFields\\[0\\] === 'Image URL'/);
  assert.match(adminScript, /hasText\\(getImageThemeOrLegacyPrompt\\(event\\)\\)/);
  assert.match(adminScript, /onclick: 'generateImage'/);
  assert.match(adminScript, /value="generateImage"/);
  assert.match(adminScript, /requestGeneratedField\\('imageUrl'/);
  assert.doesNotMatch(adminEnhancements, /installEventCardRenderHook|event-direct-image-request/);
});'''
text = replace_once(text, old, new, 'issue43 direct image assertions')
path.write_text(text)

# Keep comments aligned with the renamed Operations surface.
path = Path('website/admin/admin-diagnostics-enhancements.js')
text = path.read_text()
text = text.replace('admin-simplify builds the Diagnostics drawer', 'admin-simplify builds the Operations drawer')
text = text.replace('those canonical controls exist first', 'those controls exist first')
path.write_text(text)
