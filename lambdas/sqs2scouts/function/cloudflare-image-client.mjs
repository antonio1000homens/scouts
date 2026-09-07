export const DEFAULT_CLOUDFLARE_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

function text(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result || null;
}

export function normaliseImageProvider(value) {
  const provider = text(value)?.toLowerCase() || 'disabled';
  if (!['cloudflare', 'gemini', 'disabled'].includes(provider)) {
    throw new Error(`Unsupported image generation provider: ${provider}`);
  }
  return provider;
}

export function normaliseCloudflareSteps(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 4;
  return Math.min(8, Math.max(1, Math.floor(parsed)));
}

export function cloudflareImageEndpoint(accountId, model = DEFAULT_CLOUDFLARE_IMAGE_MODEL) {
  const account = text(accountId);
  const selectedModel = text(model) || DEFAULT_CLOUDFLARE_IMAGE_MODEL;
  if (!account) throw new Error('CLOUDFLARE_ACCOUNT_ID is not configured');
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${selectedModel.replace(/^\/+/, '')}`;
}

export function cloudflareApiError(response, payload) {
  const firstError = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  const error = new Error(
    text(firstError?.message)
      || text(payload?.message)
      || `Cloudflare Workers AI HTTP ${Number(response?.status || 0) || 'unknown'}`,
  );
  error.status = Number(response?.status || 0) || undefined;
  const providerCode = Number(firstError?.code ?? payload?.code);
  if (Number.isFinite(providerCode)) error.providerCode = providerCode;
  return error;
}

function decodeBase64Image(value) {
  const encoded = text(value);
  if (!encoded) {
    const error = new Error('Cloudflare Workers AI returned no image data');
    error.status = 400;
    error.providerCode = 'MALFORMED_RESPONSE';
    throw error;
  }
  const normalized = encoded.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    const error = new Error('Cloudflare Workers AI returned invalid base64 image data');
    error.status = 400;
    error.providerCode = 'MALFORMED_RESPONSE';
    throw error;
  }
  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.length === 0) {
    const error = new Error('Cloudflare Workers AI returned an empty image');
    error.status = 400;
    error.providerCode = 'MALFORMED_RESPONSE';
    throw error;
  }
  return buffer;
}

export function decodeCloudflareImagePayload(payload) {
  return decodeBase64Image(payload?.result?.image ?? payload?.image ?? null);
}

export async function generateCloudflareImageAsset({
  prompt,
  accountId,
  apiToken,
  model = DEFAULT_CLOUDFLARE_IMAGE_MODEL,
  steps = 4,
  fetchImpl = globalThis.fetch,
}) {
  const normalizedPrompt = text(prompt);
  const token = text(apiToken);
  if (!normalizedPrompt) throw new Error('Cloudflare image prompt is required');
  if (!token) throw new Error('Cloudflare Workers AI API token is not configured');
  if (typeof fetchImpl !== 'function') throw new Error('Cloudflare fetch implementation is unavailable');

  const selectedModel = text(model) || DEFAULT_CLOUDFLARE_IMAGE_MODEL;
  const selectedSteps = normaliseCloudflareSteps(steps);
  const endpoint = cloudflareImageEndpoint(accountId, selectedModel);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt: normalizedPrompt, steps: selectedSteps }),
  });

  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    if (response.ok) {
      const error = new Error('Cloudflare Workers AI returned malformed JSON');
      error.status = 400;
      error.providerCode = 'MALFORMED_RESPONSE';
      throw error;
    }
  }

  if (!response.ok || payload?.success === false) throw cloudflareApiError(response, payload);

  return {
    buffer: decodeCloudflareImagePayload(payload),
    contentType: 'image/jpeg',
    provider: 'cloudflare',
    model: selectedModel,
    httpStatus: Number(response.status || 200),
    steps: selectedSteps,
  };
}

export async function dispatchImageGeneration(providerValue, handlers = {}) {
  const provider = normaliseImageProvider(providerValue);
  if (provider === 'disabled') return null;
  const handler = provider === 'cloudflare' ? handlers.cloudflare : handlers.gemini;
  if (typeof handler !== 'function') {
    throw new Error(`Image generation handler is not configured for provider: ${provider}`);
  }
  return handler();
}
