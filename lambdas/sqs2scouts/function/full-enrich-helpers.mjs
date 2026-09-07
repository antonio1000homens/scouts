export function text(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result || null;
}

export function normaliseStage(value) {
  const stage = text(value);
  if (stage === 'imageUrl') return 'image';
  return ['tagline', 'imageTheme', 'image'].includes(stage) ? stage : null;
}

export function isFullEnrichMessage(message) {
  return text(message?.orchestrationType) === 'fullEnrich'
    && Boolean(text(message?.taskToken))
    && Boolean(normaliseStage(message?.orchestrationStep ?? message?.realm));
}

export function normaliseImageProvider(value) {
  const provider = text(value)?.toLowerCase() || null;
  return ['cloudflare', 'gemini'].includes(provider) ? provider : null;
}

export function nextUtcDay(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

export function classifyCloudflareError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const code = Number(error?.code ?? error?.providerCode);
  const rawCode = error?.code ?? error?.providerCode;
  const message = String(error?.message || error || '').toLowerCase();

  if (code === 3036 || /daily.*neuron|neuron.*limit|free.*allocation|daily.*allocation/.test(message)) {
    return 'PROVIDER_QUOTA';
  }
  if ([5035, 5007, 3042].includes(code)
      || /paid.*plan|required.*paid|model.*plan|no such model|invalid model/.test(message)) {
    return 'MODEL_CONFIGURATION';
  }
  if (code === 3040 || status === 429 || /capacity|rate.?limit|too many requests/.test(message)) {
    return 'RATE_LIMIT';
  }
  if (status === 408 || [3007, 3008].includes(code)
      || /timeout|timed out|aborted|socket|network|connection/.test(message)) {
    return 'NETWORK_TIMEOUT';
  }
  if ([401, 403].includes(status) || /unauthori[sz]|api.?token|permission|account.*blocked/.test(message)) {
    return 'AUTH_FAILURE';
  }
  if ([500, 502, 503, 504].includes(status) || /temporar|unavailable|internal server/.test(message)) {
    return 'PROVIDER_5XX';
  }
  if (status === 400 || rawCode === 'MALFORMED_RESPONSE'
      || /invalid|missing|required|unsupported|prompt|malformed.*response|image data/.test(message)) {
    return 'INVALID_EVENT_DATA';
  }
  return 'UNKNOWN';
}

export function buildCallbackResultFromState({ state, stage, hex, provider = null, generationId = null, fallbackStatus = null, now = new Date() }) {
  const base = {
    stage,
    hex,
    ...(provider ? { provider } : {}),
    generationId: generationId ?? state?.generationId ?? null,
    attemptCount: Number(state?.attemptCount || 0),
  };

  if (state?.state === 'succeeded') {
    return { status: 'succeeded', ...base };
  }
  if (state?.state === 'manual_review') {
    return {
      status: 'manual_review',
      ...base,
      failureCategory: state?.lastErrorType ?? null,
    };
  }
  if (state?.state === 'retry_wait') {
    return {
      status: 'retry_wait',
      ...base,
      nextRetryAt: state?.nextRetryAt ?? nextUtcDay(now),
      failureCategory: state?.lastErrorType ?? null,
    };
  }
  if (state?.state === 'persist_pending') {
    return {
      status: 'deferred',
      ...base,
      reason: 'persistence_pending',
    };
  }
  if (state?.state === 'in_progress') {
    return {
      status: 'duplicate_in_progress',
      ...base,
      reason: 'stage_reservation_owned_elsewhere',
    };
  }
  if (fallbackStatus === 'quota') {
    return {
      status: 'retry_wait',
      ...base,
      nextRetryAt: nextUtcDay(now),
      failureCategory: 'GLOBAL_QUOTA',
    };
  }
  if (fallbackStatus === 'succeeded') {
    return { status: 'succeeded', ...base };
  }
  return {
    status: 'deferred',
    ...base,
    reason: fallbackStatus || 'no_stage_result',
  };
}

export function buildImageGenerationPrompt(theme, config = {}) {
  const normalizedTheme = text(theme);
  const template = text(config?.imageGenerationPromptTemplate);
  if (!normalizedTheme || !template) return null;
  const specifications = Array.isArray(config?.imageGenerationPromptSpecifications)
    ? config.imageGenerationPromptSpecifications.map(text).filter(Boolean).join(', ')
    : '';
  return template
    .replace(/{{IMAGE_THEME}}/g, normalizedTheme)
    .replace(/{{IMAGE_PROMPT_SPECIFICATIONS}}/g, specifications)
    .replace(/\s+/g, ' ')
    .trim();
}
