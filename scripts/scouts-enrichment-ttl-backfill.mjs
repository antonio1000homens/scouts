#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const ACCOUNT_ID = '553490163883';
const REGION = 'eu-west-2';
const TABLE_NAME = 'scouts-enrichment-state';
const ACTIONABLE_STATES = new Set(['pending', 'in_progress', 'retry_wait', 'persist_pending', 'manual_review']);
const profileIndex = process.argv.indexOf('--profile');
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : process.env.AWS_PROFILE;
const limitIndex = process.argv.indexOf('--max-items');
const maxItems = Math.max(1, Math.min(500, Number(limitIndex >= 0 ? process.argv[limitIndex + 1] : 200) || 200));
const apply = process.argv.includes('--apply');
const env = { ...process.env, AWS_PROFILE: profile, AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION };
if (!profile) throw new Error('Set AWS_PROFILE or pass --profile for the Scouts account');

function aws(args) {
  const output = execFileSync('aws', [...args, '--region', REGION, '--no-cli-pager', '--output', 'json'], { env, encoding: 'utf8' });
  return JSON.parse(output);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const identity = aws(['sts', 'get-caller-identity']);
if (identity.Account !== ACCOUNT_ID) {
  throw new Error(`Refusing migration: profile ${profile} resolved to account ${identity.Account}, expected ${ACCOUNT_ID}`);
}

const candidates = [];
let exclusiveStartKey;
while (candidates.length < maxItems) {
  const args = [
    'dynamodb', 'scan', '--table-name', TABLE_NAME,
    '--projection-expression', 'hex,stage,#state,expiresAt',
    '--expression-attribute-names', '{"#state":"state"}',
    '--limit', String(Math.min(100, maxItems - candidates.length)), '--select', 'SPECIFIC_ATTRIBUTES',
  ];
  if (exclusiveStartKey) args.push('--exclusive-start-key', JSON.stringify(exclusiveStartKey));
  const page = aws(args);
  candidates.push(...(page.Items || []));
  exclusiveStartKey = page.LastEvaluatedKey;
  if (!exclusiveStartKey || !(page.Items || []).length) break;
  sleep(1000);
}

const complete = !exclusiveStartKey;
if (apply && !complete) throw new Error(`Refusing partial update: scan reached max-items=${maxItems} before the table scan completed`);

const nowSeconds = Math.floor(Date.now() / 1000);
const summary = { account: identity.Account, region: REGION, tableName: TABLE_NAME, mode: apply ? 'apply' : 'dry-run', scanned: candidates.length, scanComplete: complete, eligible: 0, alreadyMissingExpiry: 0, ignoredTerminalOrUnknown: 0, byState: {}, expiryHorizon: { expired: 0, within7Days: 0, within30Days: 0, later: 0 }, updated: 0, conditionalConflicts: 0 };
for (const item of candidates) {
  const state = item.state?.S || '(no state)';
  summary.byState[state] = (summary.byState[state] || 0) + 1;
  if (!ACTIONABLE_STATES.has(state)) {
    if (item.expiresAt?.N === undefined) summary.alreadyMissingExpiry += 1;
    else summary.ignoredTerminalOrUnknown += 1;
    continue;
  }
  if (item.expiresAt?.N === undefined) {
    summary.alreadyMissingExpiry += 1;
    continue;
  }
  const expiresAt = Number(item.expiresAt.N);
  if (!Number.isFinite(expiresAt) || !Number.isInteger(expiresAt)) {
    throw new Error('Refusing migration: an actionable record has a non-numeric expiresAt value');
  }
  summary.eligible += 1;
  if (expiresAt <= nowSeconds) summary.expiryHorizon.expired += 1;
  else if (expiresAt <= nowSeconds + 7 * 86400) summary.expiryHorizon.within7Days += 1;
  else if (expiresAt <= nowSeconds + 30 * 86400) summary.expiryHorizon.within30Days += 1;
  else summary.expiryHorizon.later += 1;

  if (apply) {
    try {
      aws([
        'dynamodb', 'update-item', '--table-name', TABLE_NAME,
        '--key', JSON.stringify({ hex: item.hex, stage: item.stage }),
        '--update-expression', 'REMOVE expiresAt',
        '--condition-expression', '#state = :state AND #expiresAt = :expiresAt',
        '--expression-attribute-names', '{"#state":"state","#expiresAt":"expiresAt"}',
        '--expression-attribute-values', JSON.stringify({ ':state': item.state, ':expiresAt': item.expiresAt }),
      ]);
      summary.updated += 1;
      sleep(1000);
    } catch (error) {
      if (/ConditionalCheckFailedException/.test(String(error?.stderr || error?.message || error))) summary.conditionalConflicts += 1;
      else throw error;
    }
  }
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
