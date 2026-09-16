export function text(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result || null;
}

function canonicalHex(value) {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && /^[0-9a-f]+$/i.test(normalized) ? normalized : null;
}

function nullableBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value).trim().toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value).trim().toLowerCase() === 'false') return false;
  return null;
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstBoolean(...values) {
  for (const value of values) {
    const normalized = nullableBoolean(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function firstHex(...values) {
  for (const value of values) {
    const normalized = canonicalHex(value);
    if (normalized) return normalized;
  }
  return null;
}

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function snapshotValue(snapshot) {
  return snapshot?.value ?? snapshot;
}

function eventHex(event) {
  return canonicalHex(event?.metadata?.hex);
}

function eventHidden(event) {
  return event?.metadata?.status?.isHidden;
}

export function extractVisibilityPersistMutation(message) {
  const actionPatch = parseObject(message?.action);
  const subjectPatch = parseObject(message?.subject);
  const patch = actionPatch || subjectPatch || {};
  const subject = message?.subject && typeof message.subject === 'object' && !Array.isArray(message.subject)
    ? message.subject
    : {};

  const isHidden = firstBoolean(
    actionPatch?.metadata?.status?.isHidden,
    actionPatch?.status?.isHidden,
    actionPatch?.isHidden,
    actionPatch?.hidden,
    subject?.metadata?.status?.isHidden,
    subject?.status?.isHidden,
    subject?.isHidden,
    subject?.hidden,
  );
  if (isHidden === null) return null;

  const hex = firstHex(
    typeof message?.subject === 'string' ? message.subject : null,
    message?.hex,
    message?.requestHex,
    actionPatch?.metadata?.hex,
    actionPatch?.hex,
    subject?.metadata?.hex,
    subject?.hex,
    patch?.requestHex,
  );
  if (!hex) {
    throw codedError('VISIBILITY_PERSIST_HEX_MISSING', 'Visibility persistence request is missing a canonical HEX identifier');
  }
  return { hex, isHidden };
}

export function buildVisibilityPersistGuard(message, agendaSnapshot, eventSnapshot) {
  const mutation = extractVisibilityPersistMutation(message);
  if (!mutation) return null;

  const agenda = snapshotValue(agendaSnapshot);
  const canonical = snapshotValue(eventSnapshot);
  const beforeETag = text(eventSnapshot?.eTag);
  const matching = Array.isArray(agenda?.events)
    ? agenda.events.filter((event) => eventHex(event) === mutation.hex)
    : [];

  if (matching.length === 0) {
    throw codedError(
      'VISIBILITY_TARGET_NOT_FOUND',
      `Visibility persistence target ${mutation.hex} is not present in agenda.json`,
      { hex: mutation.hex, matched: 0 },
    );
  }
  if (!canonical || typeof canonical !== 'object') {
    throw codedError(
      'VISIBILITY_CANONICAL_EVENT_NOT_FOUND',
      `Canonical event events/${mutation.hex}.json was not found`,
      { hex: mutation.hex },
    );
  }
  return {
    ...mutation,
    beforeETag,
    beforeHidden: eventHidden(canonical),
    beforeMatched: matching.length,
  };
}

export function verifyVisibilityPersistReadback(guard, agendaSnapshot, eventSnapshot) {
  if (!guard) return null;
  const agenda = snapshotValue(agendaSnapshot);
  const canonical = snapshotValue(eventSnapshot);
  const afterETag = text(eventSnapshot?.eTag);
  const actualHidden = eventHidden(canonical);

  if (actualHidden !== guard.isHidden) {
    throw codedError(
      'PERSISTENCE_READ_BACK_MISMATCH',
      `Canonical event ${guard.hex} read-back has metadata.status.isHidden=${String(actualHidden)}; expected ${guard.isHidden}`,
      { hex: guard.hex, expected: guard.isHidden, actual: actualHidden },
    );
  }
  if (guard.beforeHidden !== guard.isHidden && guard.beforeETag && afterETag === guard.beforeETag) {
    throw codedError(
      'PERSISTENCE_ETAG_UNCHANGED',
      `Canonical event ${guard.hex} changed visibility but its S3 ETag did not change`,
      { hex: guard.hex, eTag: afterETag },
    );
  }

  const matching = Array.isArray(agenda?.events)
    ? agenda.events.filter((event) => eventHex(event) === guard.hex)
    : [];
  if (matching.length === 0) {
    throw codedError(
      'PERSISTENCE_AGENDA_IDENTITY_MISMATCH',
      `Visibility persistence read-back for ${guard.hex} resolved no agenda occurrences`,
      { hex: guard.hex, matched: 0 },
    );
  }
  const mismatched = matching.filter((event) => eventHidden(event) !== guard.isHidden);
  if (mismatched.length > 0) {
    throw codedError(
      'PERSISTENCE_AGENDA_READ_BACK_MISMATCH',
      `Agenda visibility read-back for ${guard.hex} has ${mismatched.length} mismatched occurrences; expected ${guard.isHidden}`,
      { hex: guard.hex, expected: guard.isHidden, mismatched: mismatched.length, matched: matching.length },
    );
  }
  return {
    hex: guard.hex,
    isHidden: guard.isHidden,
    eTag: afterETag,
    matched: matching.length,
  };
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
