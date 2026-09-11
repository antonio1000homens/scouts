import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean);

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

  for (const path of trackedFiles) {
    const bytes = readFileSync(path);

    // Git-tracked text files do not necessarily have a conventional extension
    // (.gitignore, .env.example, Dockerfile, etc.). Inspect every tracked file
    // and skip only files that are clearly binary based on an embedded NUL byte.
    if (bytes.includes(0)) continue;

    const content = bytes.toString('utf8');
    if (/\/Users\/[A-Za-z0-9._-]+\//.test(content) || /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/i.test(content)) {
      offenders.push(path);
    }
  }

  assert.deepEqual(offenders, [], `Developer home-directory paths found in:\n${offenders.join('\n')}`);
});

test('workflow actions are pinned to immutable commit SHAs', () => {
  const offenders = [];

  for (const path of trackedFiles.filter((value) => value.startsWith('.github/workflows/'))) {
    const content = readFileSync(path, 'utf8');
    const actionRefs = [...content.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)/gm)].map((match) => match[1]);

    for (const actionRef of actionRefs) {
      if (!/@[0-9a-f]{40}$/i.test(actionRef)) offenders.push(`${path}: ${actionRef}`);
    }
  }

  assert.deepEqual(offenders, [], `Unpinned GitHub Actions:\n${offenders.join('\n')}`);
});

test('private calendar feeds are sourced from masked GitHub Secrets, never ordinary vars', () => {
  const workflow = readFileSync('.github/workflows/deploy-to-s3.yml', 'utf8');
  const calendarNames = [
    'CUBS_EVENTS_CALENDAR_URL',
    'CUBS_PROGRAMME_CALENDAR_URL',
    'CUBS_PROGRAME_CALENDAR_URL',
    'SCOUTS_EVENTS_CALENDAR_URL',
    'SCOUTS_PROGRAMME_CALENDAR_URL',
    'BEAVERS_EVENTS_CALENDAR_URL',
    'BEAVERS_PROGRAMME_CALENDAR_URL',
  ];

  for (const name of calendarNames) {
    assert.doesNotMatch(workflow, new RegExp(`\\$\\{\\{\\s*vars\\.${name}\\s*\\}\\}`));
    assert.match(workflow, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`));
  }
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
  assert.match(worker, /requireAccess\(request, env\)/);
  assert.match(worker, /subject: "snapshot"/);
  assert.match(worker, /subject: "event"/);

  assert.match(scoutsEntry, /PRIVATE_RUNTIME_SNAPSHOT_KEYS/);
  assert.match(scoutsEntry, /readPrivateJsonObject/);
  assert.match(scoutsEntry, /command\.subject === 'snapshot'/);
  assert.match(scoutsEntry, /command\.subject === 'event'/);
  assert.match(scoutsEntry, /`events\/\$\{hex\}\.json`/);
});

test('formerly public private prefixes are explicitly purged from the documented CloudFront distribution', () => {
  const workflow = readFileSync('.github/workflows/purge-private-s3-cache.yml', 'utf8');
  const cloudfrontDoc = readFileSync('CLOUDFRONT.md', 'utf8');
  const documentedId = cloudfrontDoc.match(/\*\*Distribution ID\*\*:\s*`([^`]+)`/)?.[1] || '';

  assert.ok(documentedId, 'CLOUDFRONT.md must document the active distribution ID');
  assert.match(workflow, new RegExp(`CLOUDFRONT_DISTRIBUTION_ID: ${documentedId}`));
  assert.match(workflow, /aws cloudfront get-distribution/);
  assert.match(workflow, /aws cloudfront create-invalidation/);
  assert.match(workflow, /aws cloudfront wait invalidation-completed/);
  assert.match(workflow, /"\/calendar\/\*"/);
  assert.match(workflow, /"\/runtime\/\*"/);
  assert.match(workflow, /"\/events\/\*"/);
  assert.match(workflow, /Verify anonymous access boundary/);
  assert.match(workflow, /assert_public/);
  assert.match(workflow, /assert_private/);
  assert.match(workflow, /origin\/agenda\.json|\$\{origin\}\/agenda\.json/);
  assert.match(workflow, /configure-aws-credentials@[0-9a-f]{40}/i);
});
