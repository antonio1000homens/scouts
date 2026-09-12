// Text-only Gemini model selection. Keep the fallback policy independent from
// the SDK so quota and malformed-output handling can be tested without making
// provider calls.
export const DEFAULT_GEMINI_TEXT_MODELS = Object.freeze([
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
]);

export const GEMINI_TEXT_RESPONSE_SCHEMAS = Object.freeze({
  tagline: {
    type: 'object',
    properties: {
      tagline: { type: 'string', description: 'One energetic sentence, no more than 80 characters.' },
      imageTag: { type: 'string', description: 'Two to four lowercase descriptive words separated by spaces.' },
    },
    required: ['tagline', 'imageTag'],
  },
  imageTheme: {
    type: 'object',
    properties: {
      imageTag: { type: 'string', description: 'Two to four lowercase descriptive words separated by spaces.' },
    },
    required: ['imageTag'],
  },
});

export function validateGeminiTextResponse(value, mode = 'tagline') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, reason: 'response_not_object' };
  if (mode === 'tagline') {
    if (typeof value.tagline !== 'string' || !value.tagline.trim()) return { valid: false, reason: 'missing_tagline' };
    if (value.tagline.trim().length > 80) return { valid: false, reason: 'tagline_too_long' };
    if (/["`]|(^|\s)[#*_>-]|\[[^\]]+\]\(/.test(value.tagline)) return { valid: false, reason: 'tagline_not_plain_text' };
  }
  if (typeof value.imageTag !== 'string' || !value.imageTag.trim()) return { valid: false, reason: 'missing_image_tag' };
  if (!/^[a-z0-9]+(?: [a-z0-9]+){1,3}$/.test(value.imageTag.trim())) return { valid: false, reason: 'invalid_image_tag' };
  return { valid: true, value: { ...value, ...(typeof value.tagline === 'string' ? { tagline: value.tagline.trim() } : {}), imageTag: value.imageTag.trim() } };
}

function text(value) { return value === undefined || value === null ? '' : String(value).trim(); }

export function parseGeminiTextModels(value, fallback = DEFAULT_GEMINI_TEXT_MODELS) {
  const models = text(value)
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  return Object.freeze([...new Set(models.length ? models : fallback)]);
}

function buildMalformedModelResponseError(message, details = {}) {
  const error = new Error(message);
  error.name = 'MALFORMED_MODEL_RESPONSE';
  error.code = 'MALFORMED_MODEL_RESPONSE';
  error.retryable = true;
  Object.assign(error, details);
  return error;
}

function getGeminiResponse(result) {
  return result?.response ?? result ?? null;
}

function extractResponseText(response) {
  if (!response) return null;
  if (typeof response.text === 'function') return text(response.text());
  if (typeof response.text === 'string') return text(response.text);
  return null;
}

function getCompletionMetadata(result) {
  const response = getGeminiResponse(result);
  const candidate = Array.isArray(response?.candidates) ? response.candidates[0] : null;
  const usageMetadata = response?.usageMetadata ?? result?.usageMetadata ?? null;
  return {
    finishReason: text(candidate?.finishReason) || null,
    finishMessage: text(candidate?.finishMessage) || null,
    candidateTokenCount: Number.isFinite(Number(usageMetadata?.candidatesTokenCount))
      ? Number(usageMetadata.candidatesTokenCount)
      : null,
    usageMetadata,
  };
}

export function assertGeminiStructuredTextResult(result, { model = null } = {}) {
  const response = getGeminiResponse(result);
  const metadata = getCompletionMetadata(result);
  const finishReason = text(metadata.finishReason).toUpperCase();

  // Keep these diagnostics beside the retry decision so the next truncated
  // response tells us whether Gemini stopped normally or hit a provider limit.
  if (response && (metadata.finishReason || metadata.usageMetadata)) {
    console.log('[Gemini] Completion metadata', {
      model,
      finishReason: metadata.finishReason,
      finishMessage: metadata.finishMessage,
      candidateTokenCount: metadata.candidateTokenCount,
      usageMetadata: metadata.usageMetadata,
    });
  }

  if (finishReason === 'MAX_TOKENS') {
    throw buildMalformedModelResponseError('Malformed model response: generation stopped at MAX_TOKENS', {
      finishReason: metadata.finishReason,
      model,
    });
  }

  const responseText = extractResponseText(response);
  // Some unit-test callers return opaque values rather than SDK responses. Only
  // enforce the structured-output contract when a textual Gemini response is
  // actually available.
  if (responseText === null) return result;
  if (!responseText) {
    throw buildMalformedModelResponseError('Malformed model response: empty structured output', {
      finishReason: metadata.finishReason,
      model,
    });
  }

  const cleaned = responseText.replace(/```json|```/gi, '').trim();
  try {
    JSON.parse(cleaned);
  } catch (cause) {
    throw buildMalformedModelResponseError('Malformed model response: invalid JSON structured output', {
      cause,
      finishReason: metadata.finishReason,
      model,
      responseSnippet: cleaned.slice(0, 500),
    });
  }

  return result;
}

export function isRetryableGeminiTextError(error) {
  if (error?.retryable === true || error?.name === 'MALFORMED_MODEL_RESPONSE' || error?.code === 'MALFORMED_MODEL_RESPONSE') {
    return true;
  }
  const status = Number(error?.status ?? error?.statusCode ?? error?.code);
  const statusText = text(error?.statusText).toLowerCase();
  const message = text(error?.message).toLowerCase();
  return [429, 500, 502, 503, 504].includes(status)
    || /too many requests|rate.?limit|resource_exhausted|quota|service (is )?unavailable/.test(`${statusText} ${message}`);
}

export async function generateGeminiTextWithFallback({
  models,
  generate,
  onAttempt,
  onSuccess,
  onFailure,
  malformedRetriesPerModel = 1,
} = {}) {
  if (typeof generate !== 'function') throw new TypeError('generate must be a function');
  const candidates = parseGeminiTextModels(models);
  const malformedRetryLimit = Math.max(0, Math.floor(Number(malformedRetriesPerModel) || 0));
  let lastError = null;
  const attemptedModels = [];

  for (const model of candidates) {
    attemptedModels.push(model);
    let malformedRetries = 0;

    while (true) {
      onAttempt?.(model);
      try {
        const result = await generate(model);
        assertGeminiStructuredTextResult(result, { model });
        onSuccess?.(model);
        return { result, model, attemptedModels };
      } catch (error) {
        lastError = error;
        onFailure?.(model, error);

        const malformed = error?.name === 'MALFORMED_MODEL_RESPONSE' || error?.code === 'MALFORMED_MODEL_RESPONSE';
        if (malformed && malformedRetries < malformedRetryLimit) {
          malformedRetries += 1;
          console.warn(`[Gemini] Text model ${model} returned malformed structured output; retrying the same model (${malformedRetries}/${malformedRetryLimit}).`);
          continue;
        }

        if (!isRetryableGeminiTextError(error)) throw error;
        break;
      }
    }
  }

  if (lastError && typeof lastError === 'object') lastError.attemptedModels = attemptedModels;
  throw lastError || new Error('Gemini generation failed before a model was attempted');
}
