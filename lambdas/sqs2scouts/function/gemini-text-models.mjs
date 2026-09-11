// Text-only Gemini model selection. Keep the fallback policy independent from
// the SDK so quota handling can be tested without making provider calls.
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

export function isRetryableGeminiTextError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.code);
  const statusText = text(error?.statusText).toLowerCase();
  const message = text(error?.message).toLowerCase();
  return [429, 500, 502, 503, 504].includes(status)
    || /too many requests|rate.?limit|resource_exhausted|quota|service (is )?unavailable/.test(`${statusText} ${message}`);
}

export async function generateGeminiTextWithFallback({ models, generate, onAttempt, onSuccess, onFailure } = {}) {
  if (typeof generate !== 'function') throw new TypeError('generate must be a function');
  const candidates = parseGeminiTextModels(models);
  let lastError = null;
  const attemptedModels = [];

  for (const model of candidates) {
    attemptedModels.push(model);
    onAttempt?.(model);
    try {
      const result = await generate(model);
      onSuccess?.(model);
      return { result, model, attemptedModels };
    } catch (error) {
      lastError = error;
      onFailure?.(model, error);
      if (!isRetryableGeminiTextError(error)) throw error;
    }
  }

  if (lastError && typeof lastError === 'object') lastError.attemptedModels = attemptedModels;
  throw lastError || new Error('Gemini generation failed before a model was attempted');
}
