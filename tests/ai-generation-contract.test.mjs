import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker = readFileSync('lambdas/sqs2scouts/function/persistence-processor.mjs', 'utf8');
const config = JSON.parse(readFileSync('lambdas/sqs2scouts/scouts.conf', 'utf8'));

test('text generation uses JSON schemas and deterministic output limits', () => {
  assert.match(worker, /responseMimeType:\s*'application\/json'/);
  assert.match(worker, /responseSchema:\s*GEMINI_TEXT_RESPONSE_SCHEMAS\[stage\]/);
  assert.match(worker, /temperature:\s*0\.3/);
  assert.match(worker, /maxOutputTokens:\s*512/);
  assert.match(worker, /validateGeminiTextResponse\(parsed, stage\)/);
});

test('prompts state semantic constraints for both generation modes', () => {
  assert.match(config.taglineThemePromptTemplate, /energetic sentence/i);
  assert.match(config.taglineThemePromptTemplate, /at most 80 characters/i);
  assert.match(config.taglineThemePromptTemplate, /two to four lowercase descriptive words/i);
  assert.match(config.imageThemePromptTemplate, /no proper nouns, punctuation, or hyphens/i);
  assert.match(config.imageThemePromptTemplate, /no Markdown, code fences, labels, explanation, or extra content/i);
});

test('blocked generation has no success fallback in the worker lifecycle', () => {
  assert.match(worker, /runtimeOutcome = \{ status: result\.state === 'retry_wait' \? 'waiting_for_retry' : 'manual_review'/);
  assert.match(worker, /const succeeded = runtimeOutcome\.status === 'completed'/);
  assert.match(worker, /publication: succeeded \? 'published' : null/);
});
