#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');

const adapter = read('lambdas/sqs2scouts/function/image-provider-adapter.mjs');
const client = read('lambdas/sqs2scouts/function/cloudflare-image-client.mjs');
const helpers = read('lambdas/sqs2scouts/function/full-enrich-helpers.mjs');
const template = read('lambdas/cloudformation/templates/sqs2scouts.yaml');
const stateMachine = read('lambdas/cloudformation/templates/scouts-full-enrich.yaml');
const deploy = read('lambdas/sqs2scouts/deploy.sh');

test('CloudFormation has fail-closed provider defaults and SSM-only Cloudflare token wiring', () => {
  assert.match(template, /ImageGenerationProvider:\s*[\s\S]*?Default:\s*disabled[\s\S]*?AllowedValues:\s*\[disabled, cloudflare, gemini\]/);
  assert.doesNotMatch(template, /ImageGenerationDailyRequestLimit|IMAGE_GENERATION_DAILY_REQUEST_LIMIT/);
  assert.match(template, /CloudflareAiModel:\s*[\s\S]*?Default:\s*'@cf\/black-forest-labs\/flux-1-schnell'/);
  assert.match(template, /CloudflareAiSteps:\s*[\s\S]*?Default:\s*4[\s\S]*?MinValue:\s*1[\s\S]*?MaxValue:\s*8/);
  assert.match(template, /IMAGE_GENERATION_PROVIDER:\s*!Ref ImageGenerationProvider/);
  assert.match(template, /CLOUDFLARE_AI_API_TOKEN_PARAMETER:\s*!Ref CloudflareAiApiTokenParameter/);
  assert.doesNotMatch(template, /CLOUDFLARE_AI_API_TOKEN:\s*!Ref/);
  assert.match(template, /parameter\$\{CloudflareAiApiTokenParameter\}/);
});

test('deploy packages the direct provider worker and forces Gemini images off for Cloudflare', () => {
  assert.doesNotMatch(deploy, /full-enrich-adapter\.mjs/);
  assert.match(deploy, /full-enrich-core\.mjs/);
  assert.match(deploy, /image-provider-adapter\.mjs/);
  assert.match(deploy, /cloudflare-image-client\.mjs/);
  assert.match(deploy, /HANDLER="\$\{HANDLER:-image-provider-adapter\.lambdaHandler\}"/);
  assert.match(deploy, /ImageGenerationProvider="\$\{IMAGE_GENERATION_PROVIDER\}"/);
  assert.match(deploy, /IMAGE_GENERATION_PROVIDER.*cloudflare[\s\S]*?GEMINI_IMAGES_ENABLED='false'/);
});

test('deploy preserves an existing image provider configuration and defaults a new stack to disabled', () => {
  assert.match(deploy, /Environment\.Variables\.IMAGE_GENERATION_PROVIDER/);
  assert.match(deploy, /disabled\|cloudflare\|gemini\) IMAGE_GENERATION_PROVIDER="\$\{CURRENT_IMAGE_GENERATION_PROVIDER\}"/);
  assert.match(deploy, /\*\) IMAGE_GENERATION_PROVIDER="disabled"/);
  assert.match(deploy, /Environment\.Variables\.CLOUDFLARE_ACCOUNT_ID/);
  assert.match(deploy, /Environment\.Variables\.CLOUDFLARE_AI_MODEL/);
});

test('provider adapter is the stable Lambda entrypoint and delegates non-image work to full-enrich core', () => {
  assert.match(adapter, /import \{ lambdaHandler as fullEnrichHandler \} from '\.\/full-enrich-core\.mjs'/);
  assert.match(adapter, /export async function lambdaHandler\(event\)/);
  assert.match(adapter, /if \(records\.length === 0\) return fullEnrichHandler\(event\)/);
});

test('Cloudflare path reserves stage before the external inference call', () => {
  const reservation = adapter.indexOf('await reserveEnrichmentAttempt');
  const provider = adapter.indexOf('await generateCloudflareImageAsset', reservation);
  assert.ok(reservation >= 0, 'stage reservation must exist');
  assert.ok(provider > reservation, 'external provider call must occur only after stage ownership');
});

test('application-level daily request caps are absent while the provider quota circuit remains', () => {
  assert.doesNotMatch(adapter, /IMAGE_DAILY_REQUEST_LIMIT|image-requests|image-cap-alert|application_daily_cap/);
  assert.match(adapter, /provider#cloudflare#daily-quota/);
});

test('cached image is stored before final S3/event persistence', () => {
  const provider = adapter.indexOf('await generateCloudflareImageAsset');
  const cache = adapter.indexOf('await markGeminiSucceeded', provider);
  const persist = adapter.indexOf('await persistCachedImage', cache);
  assert.ok(provider >= 0 && cache > provider, 'provider result must be cached');
  assert.ok(persist > cache, 'final persistence must happen after durable generated-result cache');
  assert.match(adapter, /reusable\?\.generatedValue\?\.relativeUrl[\s\S]*?generatedValue\?\.imageBase64[\s\S]*?persistCachedImage/);
});

test('Cloudflare daily allocation exhaustion is a provider/day circuit, not an event attempt loop', () => {
  assert.match(adapter, /provider#cloudflare#daily-quota/);
  assert.match(adapter, /markProviderQuotaExhausted/);
  assert.match(adapter, /nextProviderReset/);
  assert.match(adapter, /attemptWasReserved:\s*true/);
  assert.match(client, /providerCode/);
  assert.match(helpers, /3036/);
  assert.match(helpers, /PROVIDER_QUOTA/);
});

test('disabled provider makes no image callback task and no provider fallback is encoded in Step Functions', () => {
  assert.match(stateMachine, /"StringEquals":\s*"disabled"[\s\S]{0,120}?"Next":\s*"ImageGenerationDisabled"/);
  assert.match(stateMachine, /"ImageGenerationDisabled"/);
  assert.doesNotMatch(stateMachine, /Cloudflare[\s\S]{0,300}(Fallback|fallback)[\s\S]{0,300}Gemini/);
});

test('image-specific provider and failure alarms exist without application-cap alarms', () => {
  assert.doesNotMatch(template, /MetricName:\s*QuotaRejected|daily-cap-reached/);
  assert.match(template, /MetricName:\s*ProviderQuotaExhausted/);
  assert.match(template, /MetricName:\s*Failure[\s\S]*?Period:\s*3600[\s\S]*?Threshold:\s*3/);
  assert.match(template, /GeminiEnrichmentQuarantineAlarm/);
  assert.match(template, /GeminiEnrichmentRetryBurstAlarm/);
});

test('Cloudflare REST client has no logging path for authorization/token material', () => {
  assert.match(client, /headers:\s*\{/);
  assert.match(client, /apiToken/);
  assert.doesNotMatch(client, /console\.(log|warn|error)/);
  assert.doesNotMatch(client, /Global API Key/i);
});
