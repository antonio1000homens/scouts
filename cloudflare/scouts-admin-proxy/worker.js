const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const ACCESS_JWKS_TTL_MS = 5 * 60 * 1000;
let accessJwksCache = {
  url: "",
  expiresAt: 0,
  keys: [],
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function verifyTurnstile(token, secretKey, remoteIp) {
  const body = new URLSearchParams({
    secret: secretKey,
    response: token,
  });
  if (remoteIp) body.set("remoteip", remoteIp);

  const resp = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body },
  );
  const data = await resp.json();
  return data.success === true;
}

async function handleContact(request, env) {
  const corsHeaders = {
    "access-control-allow-origin": "https://2ndtolworth.org.uk",
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, code: "METHOD_NOT_ALLOWED" }),
      { status: 405, headers: { ...JSON_HEADERS, ...corsHeaders } },
    );
  }

  const turnstileSecret = (env.TURNSTILE_SECRET_KEY || "").trim();
  const iftttKey = (env.IFTTT_WEBHOOK_KEY || "").trim();
  const iftttEvent = (env.IFTTT_EVENT_NAME || "scouts_contact").trim();

  if (!turnstileSecret) {
    return new Response(
      JSON.stringify({
        ok: false,
        code: "MISSING_CONFIG",
        message: "TURNSTILE_SECRET_KEY is not configured.",
      }),
      { status: 500, headers: { ...JSON_HEADERS, ...corsHeaders } },
    );
  }
  if (!iftttKey) {
    return new Response(
      JSON.stringify({
        ok: false,
        code: "MISSING_CONFIG",
        message: "IFTTT_WEBHOOK_KEY is not configured.",
      }),
      { status: 500, headers: { ...JSON_HEADERS, ...corsHeaders } },
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ ok: false, code: "INVALID_BODY", message: "Request body must be JSON." }),
      { status: 400, headers: { ...JSON_HEADERS, ...corsHeaders } },
    );
  }

  const { name, email, message, turnstileToken } = body;

  if (!name || !email || !message || !turnstileToken) {
    return new Response(
      JSON.stringify({
        ok: false,
        code: "MISSING_FIELDS",
        message: "name, email, message, and turnstileToken are all required.",
      }),
      { status: 400, headers: { ...JSON_HEADERS, ...corsHeaders } },
    );
  }

  const remoteIp =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "";
  const captchaOk = await verifyTurnstile(turnstileToken, turnstileSecret, remoteIp);

  if (!captchaOk) {
    return new Response(
      JSON.stringify({
        ok: false,
        code: "CAPTCHA_FAILED",
        message: "CAPTCHA verification failed. Please try again.",
      }),
      { status: 400, headers: { ...JSON_HEADERS, ...corsHeaders } },
    );
  }

  const iftttUrl = `https://maker.ifttt.com/trigger/${encodeURIComponent(iftttEvent)}/json/with/key/${encodeURIComponent(iftttKey)}`;
  const iftttResp = await fetch(iftttUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      email,
      message,
      submittedAt: new Date().toISOString(),
      source: "2ndtolworth-contact-form",
    }),
  });

  if (!iftttResp.ok) {
    return new Response(
      JSON.stringify({
        ok: false,
        code: "NOTIFICATION_FAILED",
        message: "Failed to send notification. Please try again later.",
        upstreamStatus: iftttResp.status,
      }),
      { status: 502, headers: { ...JSON_HEADERS, ...corsHeaders } },
    );
  }

  return new Response(
    JSON.stringify({ ok: true, message: "Message sent successfully." }),
    { status: 200, headers: { ...JSON_HEADERS, ...corsHeaders } },
  );
}

function normalizeTeamDomain(value) {
  const raw = (value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";

  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (url.protocol !== "https:") return "";
    if (!url.hostname.endsWith(".cloudflareaccess.com")) return "";
    if (url.pathname !== "/" || url.search || url.hash) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function base64UrlBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJwtJson(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(value)));
}

function audienceMatches(actual, expected) {
  if (typeof actual === "string") return actual === expected;
  return Array.isArray(actual) && actual.includes(expected);
}

async function getAccessJwks(teamDomain) {
  const certsUrl = `${teamDomain}/cdn-cgi/access/certs`;
  const now = Date.now();
  if (
    accessJwksCache.url === certsUrl &&
    accessJwksCache.expiresAt > now &&
    accessJwksCache.keys.length > 0
  ) {
    return accessJwksCache.keys;
  }

  const response = await fetch(certsUrl, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("Unable to retrieve Cloudflare Access signing keys");

  const payload = await response.json();
  if (!Array.isArray(payload?.keys) || payload.keys.length === 0) {
    throw new Error("Cloudflare Access signing keys are unavailable");
  }

  accessJwksCache = {
    url: certsUrl,
    expiresAt: now + ACCESS_JWKS_TTL_MS,
    keys: payload.keys,
  };
  return payload.keys;
}

async function verifyAccessJwt(token, env) {
  const teamDomain = normalizeTeamDomain(env.TEAM_DOMAIN);
  const policyAudience = (env.POLICY_AUD || "").trim();
  if (!teamDomain || !policyAudience) {
    return { ok: false, configError: true };
  }

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false };

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = decodeJwtJson(encodedHeader);
    const payload = decodeJwtJson(encodedPayload);

    if (header?.alg !== "RS256" || typeof header?.kid !== "string" || !header.kid) {
      return { ok: false };
    }

    const keys = await getAccessJwks(teamDomain);
    const jwk = keys.find((key) => key?.kid === header.kid && key?.kty === "RSA");
    if (!jwk) return { ok: false };

    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64UrlBytes(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!signatureValid) return { ok: false };

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload?.iss !== teamDomain) return { ok: false };
    if (!audienceMatches(payload?.aud, policyAudience)) return { ok: false };
    if (typeof payload?.exp !== "number" || payload.exp <= nowSeconds) return { ok: false };
    if (typeof payload?.nbf === "number" && payload.nbf > nowSeconds + 30) return { ok: false };

    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function accessUnauthorized() {
  return json(
    {
      ok: false,
      code: "ACCESS_UNAUTHENTICATED",
      message: "Cloudflare Access session missing or expired. Re-login required.",
    },
    401,
  );
}

async function requireAccess(request, env, ctx = null) {
  const mustRequire = (env.REQUIRE_CF_ACCESS || "true").toLowerCase() === "true";
  if (!mustRequire) return null;

  // Cloudflare Access evaluates protected Worker invocations before user code
  // runs. When that platform-authenticated context is present, prefer it over
  // re-parsing the assertion and depending on separately managed Worker vars.
  // If POLICY_AUD is configured, retain the explicit application pin as an
  // additional check; otherwise ctx.access itself remains authoritative.
  if (ctx?.access) {
    const expectedAudience = (env.POLICY_AUD || "").trim();
    const actualAudience = typeof ctx.access.aud === "string" ? ctx.access.aud.trim() : "";
    if (expectedAudience && actualAudience !== expectedAudience) return accessUnauthorized();
    return null;
  }

  // Fallback for legacy/test invocation contexts that expose only the raw JWT.
  // This path deliberately retains the original cryptographic verification and
  // fails closed unless TEAM_DOMAIN and POLICY_AUD are both pinned.
  const jwt = (request.headers.get("cf-access-jwt-assertion") || "").trim();
  if (!jwt) return accessUnauthorized();

  const verification = await verifyAccessJwt(jwt, env);
  if (verification.ok) return null;
  if (verification.configError) {
    return json(
      {
        ok: false,
        code: "ACCESS_CONFIG_MISSING",
        message: "Cloudflare Access JWT validation fallback is not configured.",
      },
      500,
    );
  }

  return accessUnauthorized();
}

function requireConfig(env) {
  const apiKey = (env.SCOUTS_LAMBDA_API_KEY || "").trim();
  if (!apiKey) {
    return json(
      {
        ok: false,
        code: "MISSING_API_KEY",
        message: "SCOUTS_LAMBDA_API_KEY is not configured in Worker secrets.",
      },
      500,
    );
  }
  if (!env.SCOUTS_URL) {
    return json(
      {
        ok: false,
        code: "MISSING_ENDPOINT",
        message: "SCOUTS_URL must be configured.",
      },
      500,
    );
  }
  return null;
}

async function proxyToLambda(request, lambdaBaseUrl, apiKey) {
  const safeApiKey = (apiKey || "").trim();
  const upstreamUrl = new URL(lambdaBaseUrl);
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("host");
  headers.delete("cf-access-jwt-assertion");
  headers.delete("cf-access-authenticated-user-email");
  headers.delete("cf-connecting-ip");
  headers.delete("x-forwarded-for");
  upstreamUrl.searchParams.set("apiKey", safeApiKey);
  headers.set("x-api-key", safeApiKey);

  const init = {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
  };

  return fetch(upstreamUrl.toString(), init);
}

function privateObjectCommand(pathname) {
  const runtimeSnapshots = new Map([
    ["/runtime/scoutsQueued.json", "queued"],
    ["/runtime/scoutsProcessing.json", "processing"],
    ["/runtime/scoutsComplete.json", "completed"],
  ]);
  const snapshot = runtimeSnapshots.get(pathname);
  if (snapshot) {
    return { realm: "runtime", subject: "snapshot", action: "get", snapshot };
  }

  const eventMatch = pathname.match(/^\/events\/([0-9a-fA-F]+)\.json$/);
  if (eventMatch) {
    return {
      realm: "runtime",
      subject: "event",
      action: "get",
      hex: eventMatch[1].toLowerCase(),
    };
  }

  return null;
}

async function fetchPrivateObject(command, env) {
  const apiKey = (env.SCOUTS_LAMBDA_API_KEY || "").trim();
  const upstreamUrl = new URL(env.SCOUTS_URL);
  upstreamUrl.searchParams.set("apiKey", apiKey);

  const upstream = await fetch(upstreamUrl.toString(), {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(command),
  });

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return json({ ok: false, code: "INVALID_UPSTREAM_RESPONSE" }, 502);
  }

  if (!upstream.ok) {
    return json(payload, upstream.status);
  }

  if (command.subject === "snapshot") {
    return json(payload?.snapshot ?? {}, 200);
  }
  if (command.subject === "event") {
    return json(payload?.event ?? {}, 200);
  }
  return json({ ok: false, code: "UNSUPPORTED_PRIVATE_OBJECT" }, 500);
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (url.pathname === "/api/contact") {
        return handleContact(request, env);
      }
      return handleOptions();
    }

    if (url.pathname === "/api/contact") {
      return handleContact(request, env);
    }

    const privateCommand = privateObjectCommand(url.pathname);
    if (privateCommand) {
      if (request.method !== "GET") {
        return json({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
      }
      const accessErr = await requireAccess(request, env, ctx);
      if (accessErr) return accessErr;
      const configErr = requireConfig(env);
      if (configErr) return configErr;
      return fetchPrivateObject(privateCommand, env);
    }

    if (!url.pathname.startsWith("/admin-api/")) {
      return json({ ok: false, code: "NOT_FOUND", message: "Not found" }, 404);
    }

    const accessErr = await requireAccess(request, env, ctx);
    if (accessErr) return accessErr;

    const configErr = requireConfig(env);
    if (configErr) return configErr;

    if (url.pathname === "/admin-api/auth-status" && request.method === "GET") {
      return json(
        {
          ok: true,
          code: "READY",
          message: "Proxy and API key are configured.",
          scoutsEndpoint: "/admin-api/scouts",
        },
        200,
      );
    }

    if (url.pathname === "/admin-api/queue" && request.method === "POST") {
      return proxyToLambda(request, env.SCOUTS_URL, env.SCOUTS_LAMBDA_API_KEY);
    }

    if (url.pathname === "/admin-api/persist" && request.method === "POST") {
      return proxyToLambda(request, env.SCOUTS_URL, env.SCOUTS_LAMBDA_API_KEY);
    }

    if (url.pathname === "/admin-api/scouts" && request.method === "POST") {
      return proxyToLambda(request, env.SCOUTS_URL, env.SCOUTS_LAMBDA_API_KEY);
    }

    if (url.pathname === "/admin-api/refresh" && request.method === "POST") {
      return proxyToLambda(request, env.SCOUTS_URL, env.SCOUTS_LAMBDA_API_KEY);
    }

    return json({ ok: false, code: "METHOD_OR_PATH_NOT_ALLOWED" }, 405);
  },
};