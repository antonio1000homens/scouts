import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker = readFileSync('lambdas/sqs2scouts/function/persistence-processor.mjs', 'utf8');
const config = JSON.parse(readFileSync('lambdas/sqs2scouts/scouts.conf', 'utf8'));
const scoutsConfig = JSON.parse(readFileSync('lambdas/scouts/scouts.conf', 'utf8'));

test('text generation uses JSON schemas and deterministic output limits', () => {
  assert.match(worker, /responseMimeType:\s*'application\/json'/);
  assert.match(worker, /responseJsonSchema:\s*GEMINI_TEXT_RESPONSE_SCHEMAS\[mode\]/);
  assert.match(worker, /import\('@google\/genai'\)/);
  assert.doesNotMatch(worker, /@google\/generative-ai/);
  assert.match(worker, /temperature:\s*0\.3/);
  assert.match(worker, /maxOutputTokens:\s*2048/);
  assert.match(worker, /validateGeminiTextResponse\(parsed, mode\)/);
});

test('prompts state semantic constraints for both generation modes', () => {
  assert.match(config.taglineThemePromptTemplate, /energetic sentence/i);
  assert.match(config.taglineThemePromptTemplate, /at most 80 characters/i);
  assert.match(config.taglinePromptTemplate, /energetic sentence/i);
  assert.match(config.taglinePromptTemplate, /at most 80 characters/i);
  assert.equal(config.taglinePromptTemplate.includes('\n\nEvent details:\n'), true);
  assert.equal(config.taglinePromptTemplate.includes('\\n'), false, 'prompt must contain real newlines, not literal backslash-n text');
  assert.match(config.taglineThemePromptTemplate, /two to four lowercase descriptive words/i);
  assert.match(config.imageThemePromptTemplate, /no proper nouns, punctuation, or hyphens/i);
  assert.match(config.imageThemePromptTemplate, /no Markdown, code fences, labels, explanation, or extra content/i);
});

test('image generation forbids rendered text unless the image theme explicitly requests it', () => {
  for (const [name, promptConfig] of [
    ['scouts source config', scoutsConfig],
    ['sqs2scouts runtime config', config],
  ]) {
    const specifications = promptConfig.imageGenerationPromptSpecifications.join(' ');
    assert.match(specifications, /do not render any words, lettering, captions, labels, signs, logos, or other readable text/i, name);
    assert.match(specifications, /words used to describe the image theme are visual instructions, not text to display/i, name);
    assert.match(specifications, /only render text when the image theme explicitly requests specific wording to appear/i, name);
    assert.match(specifications, /include only that requested wording and no additional text/i, name);
  }
});

test('blocked generation has no success fallback in the worker lifecycle', () => {
  assert.match(worker, /status: result\.state === 'retry_wait' \? 'waiting_for_retry' : 'manual_review'/);
  assert.match(worker, /const succeeded = runtimeOutcome\.status === 'completed'/);
  assert.match(worker, /publication: succeeded \? 'published' : null/);
});
