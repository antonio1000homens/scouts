#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');

const adapter = read('lambdas/sqs2scouts/function/image-provider-adapter.mjs');
const client = read('lambdas/sqs2scouts/function/cloudflare-image-client.mjs');
const template = read('lambdas/cloudformation/templates/sqs2scouts.yaml');
const stateMachine = read('lambdas/cloudformation/templates/scouts-full-enrich.yaml');
const deploy = read('lambdas/sqs2scouts/deploy.sh');
const entrypoint = read('lambdas/sqs2scouts/function/full-enrich-adapter.mjs');

test('CloudFormation has fail-closed provider defaults and SSM-only Cloudflare token wiring', () => {
  assert.match(template, /ImageGenerationProvider:\s*[\s\S]*?Default:\s*disabled[\s\S]*?AllowedValues:\s*\[disabled, cloudflare, gemini\]/);
  assert.match(template, /ImageGenerationDailyRequestLimit:\s*[\s\S]*?Default:\s*10/);
  assert.match(template, /CloudflareAiModel:\s*[\s\S]*?Default:\s*'@cf\/black-forest-labs\/flux-1-schnell'/);
  assert.match(template, /CloudflareAiSteps:\s*[\s\S]*?Default:\s*4[\s\S]*?MinValue:\s*1[\s\S]*?MaxValue:\s*8/);
  assert.match(template, /IMAGE_GENERATION_PROVIDER:\s*!Ref ImageGenerationProvider/);
  assert.match(template, /CLOUDFLARE_AI_API_TOKEN_PARAMETER:\s*!Ref CloudflareAiApiTokenParameter/);
  assert.doesNotMatch(template, /CLOUDFLARE_AI_API_TOKEN:\s*!Ref/);
  assert.match(template, /parameter\$\{CloudflareAiApiTokenParameter\}/);
});

test('deploy packages provider modules and forces Gemini images off for Cloudflare', () => {
  assert.match(deploy, /full-enrich-adapter\.mjs/);
  assert.match(deploy, /full-enrich-core\.mjs/);
  assert.match(deploy, /image-provider-adapter\.mjs/);
  assert.match(deploy, /cloudflare-image-client\.mjs/);
  assert.match(deploy, /ImageGenerationProvider="\$\{IMAGE_GENERATION_PROVIDER\}"/);
  assert.match(deploy, /IMAGE_GENERATION_PROVIDER.*cloudflare[\s\S]*?GEMINI_IMAGES_ENABLED="false"/);
});

test('stable Lambda entrypoint delegates through provider adapter', () => {
  assert.match(entrypoint, /export \{ lambdaHandler \} from '\.\/image-provider-adapter\.mjs'/);
  assert.match(template, /Handler:\s*[\s\S]*?Default:\s*full-enrich-adapter\.lambdaHandler/);
});

test('Cloudflare path reserves stage before application inference budget', () => {
  const reservation = adapter.indexOf('await reserveEnrichmentAttempt');
  const budget = adapter.indexOf('await reserveImageBudget', reservation);
  const provider = adapter.indexOf('await generateCloudflareImageAsset', budget);
  assert.ok(reservation >= 0, 'stage reservation must exist');
  assert.ok(budget > reservation, 'budget must be reserved after stage ownership');
  assert.ok(provider > budget, 'external provider call must occur only after both reservations');
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
  assert.match(client, /3036/);
});

test('disabled provider makes no image callback task and no provider fallback is encoded in Step Functions', () => {
  assert.match(stateMachine, /"StringEquals": "disabled", "Next": "ImageGenerationDisabled"/);
  assert.match(stateMachine, /"ImageGenerationDisabled"/);
  assert.doesNotMatch(stateMachine, /Cloudflare[\s\S]{0,300}(Fallback|fallback)[\s\S]{0,300}Gemini/);
});

test('image-specific alarms exist without removing issue 16 alarms', () => {
  assert.match(template, /MetricName:\s*QuotaRejected/);
  assert.match(template, /MetricName:\s*ProviderQuotaExhausted/);
  assert.match(template, /MetricName:\s*Failure[\s\S]*?Period:\s*3600[\s\S]*?Threshold:\s*3/);
  assert.match(template, /GeminiEnrichmentQuarantineAlarm/);
  assert.match(template, /GeminiEnrichmentRetryBurstAlarm/);
});

test('Cloudflare REST client contains no logging of authorization/token material', () => {
  assert.match(client, /Authorization:\s*`Bearer \$\{apiToken\}`/);
  assert.doesNotMatch(client, /console\.(log|warn|error)/);
  assert.doesNotMatch(client, /Global API Key/i);
});
