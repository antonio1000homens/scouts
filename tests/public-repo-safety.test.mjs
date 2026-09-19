import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean);

const existingTrackedFiles = trackedFiles.filter((path) => existsSync(path));

const prohibitedTrackedPath = (path) => {
  if (path.includes('/.wrangler/') || path.startsWith('.wrangler/')) return true;
  if (path.startsWith('lambdas/tools/tmp/')) return true;
  if (path === '.env' || path.endsWith('/.env')) return true;
  if (/^distribution-config(?:-[^.]+)?\.json$/.test(path)) return true;
  if (['etag.txt', 'resources-to-import.json', 'iam_policy.json', 'vsstudio-policy-updated.json'].includes(path)) return true;
  return false;
};

test('private/generated deployment artefacts are not tracked', () => {
  const prohibited = trackedFiles.filter(prohibitedTrackedPath);
  assert.deepEqual(prohibited, [], `Prohibited tracked files:\n${prohibited.join('\n')}`);
});

test('calendar parser fixture is explicitly synthetic and contains no obvious UK mobile number', () => {
  const fixture = readFileSync('lambdas/scouts/function/tests/cubs-programme.ics', 'utf8');

  assert.match(fixture, /Synthetic/i);
  assert.match(fixture, /example\.invalid/i);
  assert.doesNotMatch(fixture, /(?:\+44\s?7|\b07)\d(?:[\s-]?\d){8}/);
  assert.doesNotMatch(fixture, /what\s*3\s*words|what3words/i);
});

test('tracked text does not contain developer home-directory paths', () => {
  const offenders = [];

  for (const path of existingTrackedFiles) {
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;

    const content = bytes.toString('utf8');
    if (/\/Users\/[A-Za-z0-9._-]+\//.test(content) || /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/i.test(content)) {
      offenders.push(path);
    }
  }

  assert.deepEqual(offenders, [], `Developer home-directory paths found in:\n${offenders.join('\n')}`);
});

test('deployment targets come from environment configuration rather than public deployment literals', () => {
  const workflows = [
    readFileSync('.github/workflows/deploy-to-s3.yml', 'utf8'),
    readFileSync('.github/workflows/live-regression-canary.yml', 'utf8'),
  ];
  const deploymentFiles = [
    '.github/workflows/deploy-to-s3.yml',
    '.github/workflows/live-regression-canary.yml',
    'aws/bootstrap/deploy.sh',
    'lambdas/shared-layer/deploy.sh',
    'lambdas/scouts-queues/deploy.sh',
    'lambdas/scouts-full-enrich/deploy.sh',
    'lambdas/scouts2sqs/deploy.sh',
    'lambdas/scouts-slack-handler/deploy.sh',
    'lambdas/scouts/deploy.sh',
    'lambdas/sqs2scouts/deploy.sh',
  ];

  for (const workflow of workflows) {
    assert.match(workflow, /EXPECTED_AWS_ACCOUNT: \$\{\{ vars\.EXPECTED_AWS_ACCOUNT \}\}/);
    assert.match(workflow, /WEBSITE_BUCKET: \$\{\{ vars\.WEBSITE_BUCKET \}\}/);
  }

  for (const path of deploymentFiles) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /553490163883/, `${path} must not hardcode the production AWS account`);
    assert.doesNotMatch(source, /scouts-2ndtolworth-prod-553490163883/, `${path} must not hardcode the production website bucket`);
  }
});

test('workflow actions are pinned to immutable commit SHAs', () => {
  const offenders = [];

  for (const path of existingTrackedFiles.filter((value) => value.startsWith('.github/workflows/'))) {
    const content = readFileSync(path, 'utf8');
    const actionRefs = [...content.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)/gm)].map((match) => match[1]);

    for (const actionRef of actionRefs) {
      if (!/@[0-9a-f]{40}$/i.test(actionRef)) offenders.push(`${path}: ${actionRef}`);
    }
  }

  assert.deepEqual(offenders, [], `Unpinned GitHub Actions:\n${offenders.join('\n')}`);
});

test('configured private calendar feeds resolve from Bitwarden UID variables', () => {
  const workflow = readFileSync('.github/workflows/deploy-to-s3.yml', 'utf8');
  const calendarNames = [
    'CUBS_EVENTS_CALENDAR_URL',
    'CUBS_PROGRAMME_CALENDAR_URL',
    'SCOUTS_EVENTS_CALENDAR_URL',
    'SCOUTS_PROGRAMME_CALENDAR_URL',
    'BEAVERS_EVENTS_CALENDAR_URL',
    'BEAVERS_PROGRAMME_CALENDAR_URL',
  ];

  assert.match(workflow, /- name: Reject plaintext calendar URL variables/);
  assert.match(workflow, /uses: bitwarden\/sm-action@[0-9a-f]{40}/i);
  assert.match(workflow, /access_token: \$\{\{ secrets\.BW_ACCESS_TOKEN \}\}/);

  for (const name of calendarNames) {
    assert.doesNotMatch(workflow, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`));
    assert.match(workflow, new RegExp(`vars\\.${name} != ''`), `${name} should be optional when its UID variable is empty`);
    assert.match(workflow, new RegExp(`vars\\.${name} \\}\\} > ${name}`), `${name} should resolve through Bitwarden when configured`);
  }
  assert.doesNotMatch(workflow, /CUBS_PROGRAME_CALENDAR_URL/);
});

test('empty or pending calendar values disable feeds and Lambda reuse is explicit local recovery only', () => {
  const deployScript = readFileSync('lambdas/scouts/deploy.sh', 'utf8');

  assert.match(deployScript, /ALLOW_EXISTING_CALENDAR_ENV_REUSE="\$\{ALLOW_EXISTING_CALENDAR_ENV_REUSE:-false\}"/);
  assert.match(deployScript, /GITHUB_ACTIONS:-.*ALLOW_EXISTING_CALENDAR_ENV_REUSE/);
  assert.match(deployScript, /ALLOW_EXISTING_CALENDAR_ENV_REUSE.*manual\/local recovery option/);
  assert.match(deployScript, /if \[ "\$\{ALLOW_EXISTING_CALENDAR_ENV_REUSE\}" = "true" \]; then/);
  assert.match(deployScript, /"__PENDING_\$\{calendar_variable_name\}__"/);
  assert.match(deployScript, /export "\$\{calendar_variable_name\}="/);
  assert.match(deployScript, /Calendar source disabled:/);
  assert.doesNotMatch(deployScript, /missing_calendar_variables/);
  assert.doesNotMatch(deployScript, /Normal deployments fail closed/);

  assert.match(deployScript, /CUBS_PROGRAME_CALENDAR_URL/);
});

test('calendar CloudFormation parameters stay NoEcho and wire directly into Lambda', () => {
  const template = readFileSync('lambdas/cloudformation/templates/scouts.yaml', 'utf8');
  const mappings = [
    ['CUBS_EVENTS_CALENDAR_URL', 'CubsEventsCalendarUrl'],
    ['CUBS_PROGRAMME_CALENDAR_URL', 'CubsProgrammeCalendarUrl'],
    ['SCOUTS_EVENTS_CALENDAR_URL', 'ScoutsEventsCalendarUrl'],
    ['SCOUTS_PROGRAMME_CALENDAR_URL', 'ScoutsProgrammeCalendarUrl'],
    ['BEAVERS_EVENTS_CALENDAR_URL', 'BeaversEventsCalendarUrl'],
    ['BEAVERS_PROGRAMME_CALENDAR_URL', 'BeaversProgrammeCalendarUrl'],
  ];

  for (const [environmentName, parameterName] of mappings) {
    assert.match(
      template,
      new RegExp(`${parameterName}:\\n\\s+Type: String\\n\\s+Default: ''\\n\\s+NoEcho: true`),
      `${parameterName} must remain an empty-default NoEcho parameter`,
    );
    assert.match(
      template,
      new RegExp(`${environmentName}: !Ref ${parameterName}`),
      `${environmentName} must be populated from ${parameterName}`,
    );
  }
});

test('tracked files do not hardcode private calendar URLs', () => {
  const offenders = [];
  const plaintextCalendarAssignment = /(?:CUBS|SCOUTS|BEAVERS)_[A-Z_]*CALENDAR_URL\s*(?::|=)\s*["']?https?:\/\//i;
  const osmPrivateCalendarUrl = /onlinescoutmanager\.co\.uk\/ext\/cal\/\?/i;

  for (const path of existingTrackedFiles) {
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;

    const content = bytes.toString('utf8');
    if (plaintextCalendarAssignment.test(content) || osmPrivateCalendarUrl.test(content)) offenders.push(path);
  }

  assert.deepEqual(offenders, [], `Plaintext calendar URLs found in:\n${offenders.join('\n')}`);
});

test('anonymous S3 policy exposes only deliberate public website objects', () => {
  const workflow = readFileSync('.github/workflows/deploy-to-s3.yml', 'utf8');
  const policyBlock = workflow.match(/cat > bucket-policy\.json << 'EOF'([\s\S]*?)\n\s*EOF/)?.[1] || '';

  assert.ok(policyBlock, 'Unable to locate generated S3 bucket policy');
  assert.match(policyBlock, /PublicReadWebsiteAllowlist/);
  assert.match(policyBlock, /WEBSITE_BUCKET_PLACEHOLDER\/index\.html/);
  assert.match(policyBlock, /WEBSITE_BUCKET_PLACEHOLDER\/agenda\.json/);
  assert.match(policyBlock, /WEBSITE_BUCKET_PLACEHOLDER\/scouts\.conf/);
  assert.match(policyBlock, /WEBSITE_BUCKET_PLACEHOLDER\/website\/\*/);
  assert.doesNotMatch(policyBlock, /WEBSITE_BUCKET_PLACEHOLDER\/\*"/);
  assert.doesNotMatch(policyBlock, /WEBSITE_BUCKET_PLACEHOLDER\/(?:calendar|runtime|events)\/\*/);

  assert.match(workflow, /BlockPublicAcls=true,IgnorePublicAcls=true/);
});

test('private runtime and HEX objects are reachable only through the Access-protected admin proxy', () => {
  const wrangler = readFileSync('cloudflare/scouts-admin-proxy/wrangler.toml', 'utf8');
  const worker = readFileSync('cloudflare/scouts-admin-proxy/worker.js', 'utf8');
  const scoutsEntry = readFileSync('lambdas/scouts/function/scouts-entry.mjs', 'utf8');

  assert.match(wrangler, /2ndtolworth\.org\.uk\/runtime\/\*/);
  assert.match(wrangler, /2ndtolworth\.org\.uk\/events\/\*/);
  assert.match(worker, /privateObjectCommand/);
  assert.match(worker, /requireAccess\(request, env, ctx\)/);
  assert.match(worker, /subject: "snapshot"/);
  assert.match(worker, /subject: "event"/);

  assert.match(scoutsEntry, /PRIVATE_RUNTIME_SNAPSHOT_KEYS/);
  assert.match(scoutsEntry, /readPrivateJsonObject/);
  assert.match(scoutsEntry, /command\.subject === 'snapshot'/);
  assert.match(scoutsEntry, /command\.subject === 'event'/);
  assert.match(scoutsEntry, /`events\/\$\{hex\}\.json`/);
});

test('admin proxy prefers Cloudflare authenticated Access context and retains cryptographic JWT fallback', () => {
  const wrangler = readFileSync('cloudflare/scouts-admin-proxy/wrangler.toml', 'utf8');
  const worker = readFileSync('cloudflare/scouts-admin-proxy/worker.js', 'utf8');
  const deployScript = readFileSync('cloudflare/scouts-admin-proxy/deploy-ci.sh', 'utf8');

  assert.match(wrangler, /^workers_dev\s*=\s*false$/m);
  assert.match(worker, /async fetch\(request, env, ctx\)/);
  assert.match(worker, /if \(ctx\?\.access\)/);
  assert.match(worker, /ctx\.access\.aud/);
  assert.match(worker, /expectedAudience && actualAudience !== expectedAudience/);
  assert.match(worker, /await requireAccess\(request, env, ctx\)/);

  // The raw assertion fallback remains fully pinned and cryptographically checked.
  assert.match(worker, /TEAM_DOMAIN/);
  assert.match(worker, /POLICY_AUD/);
  assert.match(worker, /cloudflareaccess\.com/);
  assert.match(worker, /\/cdn-cgi\/access\/certs/);
  assert.match(worker, /crypto\.subtle\.importKey/);
  assert.match(worker, /crypto\.subtle\.verify/);
  assert.match(worker, /header\?\.alg !== "RS256"/);
  assert.match(worker, /payload\?\.iss !== teamDomain/);
  assert.match(worker, /audienceMatches\(payload\?\.aud, policyAudience\)/);
  assert.match(worker, /payload\.exp <= nowSeconds/);
  assert.doesNotMatch(worker, /isAccessAuthenticated/);
  assert.doesNotMatch(worker, /apiKeyLast4/);
  assert.match(deployScript, /wrangler deploy .*--keep-vars/);
});

test('private prefixes stay protected and normal deployment owns cache invalidation', () => {
  const workflow = readFileSync('.github/workflows/deploy-to-s3.yml', 'utf8');
  const bootstrapTemplate = readFileSync('aws/bootstrap/scouts-account-bootstrap.yaml', 'utf8');
  const cloudfrontDoc = readFileSync('CLOUDFRONT.md', 'utf8');
  const cloudfrontTemplate = readFileSync('cloudfront-stack.yaml', 'utf8');
  const documentedId = cloudfrontDoc.match(/\*\*Distribution ID\*\*:\s*`([^`]+)`/)?.[1] || '';

  assert.ok(documentedId, 'CLOUDFRONT.md must document the active distribution ID');
  assert.match(workflow, /aws cloudfront create-invalidation/);
  assert.match(workflow, /CLOUDFRONT_DISTRIBUTION_ID/);
  assert.match(bootstrapTemplate, /lambda:PublishLayerVersion/);
  assert.match(bootstrapTemplate, /lambda:GetLayerVersion/);
  assert.match(bootstrapTemplate, /events:PutRule/);
  assert.match(bootstrapTemplate, /events:TagResource/);
  assert.match(bootstrapTemplate, /cloudfront:CreateInvalidation/);
  assert.match(cloudfrontTemplate, /RestrictionType:\s*whitelist/);
  assert.match(cloudfrontTemplate, /- GB/);
  assert.match(workflow, /\/agenda\.json/);
  assert.doesNotMatch(workflow, /CLOUDFRONT_BASE_URL/);
  assert.doesNotMatch(workflow, /PUBLIC_SITE_BASE_URL/);
  assert.match(workflow, /configure-aws-credentials@[0-9a-f]{40}/i);
});


test('AWS OIDC permission is scoped to jobs that actually assume an AWS role', () => {
  const workflow = readFileSync('.github/workflows/deploy-to-s3.yml', 'utf8');
  const workflowPermissions = workflow.match(/permissions:\n([\s\S]*?)\nenv:/)?.[1] || '';
  const planJob = workflow.match(/  plan-and-test:[\s\S]*?\n  enforce-log-retention:/)?.[0] || '';
  const retentionJob = workflow.match(/  enforce-log-retention:[\s\S]*?\n  deploy-web:/)?.[0] || '';
  const webJob = workflow.match(/  deploy-web:[\s\S]*?\n  deploy-aws:/)?.[0] || '';
  const awsJob = workflow.match(/  deploy-aws:[\s\S]*$/)?.[0] || '';

  assert.match(workflowPermissions, /contents: read/);
  assert.doesNotMatch(workflowPermissions, /id-token:\s*write/);
  assert.doesNotMatch(planJob, /id-token:\s*write/);
  assert.match(retentionJob, /permissions:\n\s+contents: read\n\s+id-token: write/);
  assert.match(webJob, /permissions:\n\s+contents: read\n\s+id-token: write/);
  assert.match(awsJob, /permissions:\n\s+contents: read\n\s+id-token: write/);
});

test('Scouts Lambda log groups have bounded retention enforced and verified by deployment', () => {
  const workflow = readFileSync('.github/workflows/deploy-to-s3.yml', 'utf8');
  const bootstrap = readFileSync('aws/bootstrap/scouts-account-bootstrap.yaml', 'utf8');
  const expectedLogGroups = [
    '/aws/lambda/scouts',
    '/aws/lambda/scouts-dlq-activity',
    '/aws/lambda/scouts2sqs',
    '/aws/lambda/sqs2scouts',
  ];

  assert.match(bootstrap, /logs:PutRetentionPolicy/);
  assert.match(workflow, /retention_days=30/);
  assert.match(workflow, /aws logs put-retention-policy/);
  assert.match(workflow, /aws logs describe-log-groups/);
  assert.match(workflow, /Retention verification failed/);
  for (const logGroup of expectedLogGroups) {
    assert.ok(workflow.includes(logGroup), `Missing retention enforcement for ${logGroup}`);
  }
});

test('production operational logging avoids raw Slack, SQS, prompt and response payloads', () => {
  const slackHandler = readFileSync('lambdas/scouts-slack-handler/function/slack-handler.mjs', 'utf8');
  const persistence = readFileSync('lambdas/sqs2scouts/function/persistence-processor.mjs', 'utf8');
  const requestProcessor = readFileSync('lambdas/scouts2sqs/function/request-processor.mjs', 'utf8');
  const fullEnrich = readFileSync('lambdas/sqs2scouts/function/full-enrich-core.mjs', 'utf8');

  for (const pattern of [
    /Slack handler invoked:/,
    /Raw body \(first/,
    /Full parsed payload:/,
    /Response URL:/,
    /Response payload:/,
    /Parsed event data/,
    /\[SQS\] Payload:/,
    /requestApiKeyLast4/,
    /requiredApiKeyLast4/,
  ]) {
    assert.doesNotMatch(slackHandler, pattern);
  }

  for (const pattern of [
    /\[Gemini\] Request payload:/,
    /Raw response snippet:/,
    /Cleaned response was:/,
    /Generating image with model .*prompt/,
    /Downloading image from:/,
    /\[Slack\] Request payload:/,
    /Message that would have been sent:/,
    /Failed to parse SQS message body:",\s*sqsMessage\.body/,
    /Processing persist action for subject:/,
    /Sending notification to scoutsDecision queue:/,
  ]) {
    assert.doesNotMatch(persistence, pattern);
  }

  for (const pattern of [
    /Payload to be sent:/,
    /JSON\.stringify\(translatedPayload\)/,
    /JSON\.stringify\(finalScoutsPayload\)/,
    /SQS message missing required fields:', \{ rawRealm, rawAction, rawSubject \}/,
  ]) {
    assert.doesNotMatch(requestProcessor, pattern);
  }

  assert.doesNotMatch(fullEnrich, /Stage result', JSON\.stringify\(result\)/);

  const persistenceSummary = persistence.match(/function summarizeMessageBody\(messageBody\) \{[\s\S]*?\n\}/)?.[0] || '';
  const requestSummary = requestProcessor.match(/function summarizeMessageBody\(messageBody\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(persistenceSummary, /\b(?:title|subject):/);
  assert.doesNotMatch(requestSummary, /\b(?:title|subject):/);
});
