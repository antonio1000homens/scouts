const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
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

  // Validate required secrets
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

  // Parse request body
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

  // Validate required fields
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

  // Verify Turnstile CAPTCHA
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

  // Forward to IFTTT webhook
  const iftttUrl = `https://maker.ifttt.com/trigger/${encodeURIComponent(iftttEvent)}/with/key/${encodeURIComponent(iftttKey)}`;
  const iftttResp = await fetch(iftttUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      value1: name,
      value2: email,
      value3: message,
    }),
  });

  if (!iftttResp.ok) {
    return new Response(
      JSON.stringify({
        ok: false,
        code: "NOTIFICATION_FAILED",
        message: "Failed to send notification. Please try again later.",
      }),
      { status: 502, headers: { ...JSON_HEADERS, ...corsHeaders } },
    );
  }

  return new Response(
    JSON.stringify({ ok: true, message: "Message sent successfully." }),
    { status: 200, headers: { ...JSON_HEADERS, ...corsHeaders } },
  );
}

function isAccessAuthenticated(request) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  return Boolean(jwt && jwt.trim());
}

function requireAccess(request, env) {
  const mustRequire = (env.REQUIRE_CF_ACCESS || "true").toLowerCase() === "true";
  if (!mustRequire) return null;
  if (isAccessAuthenticated(request)) return null;
  return json(
    {
      ok: false,
      code: "ACCESS_UNAUTHENTICATED",
      message: "Cloudflare Access session missing or expired. Re-login required.",
    },
    401,
  );
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
  if (!env.SCOUTS2SQS_URL || !env.SCOUTS_REFRESH_URL) {
    return json(
      {
        ok: false,
        code: "MISSING_ENDPOINT",
        message: "SCOUTS2SQS_URL and SCOUTS_REFRESH_URL must be configured.",
      },
      500,
    );
  }
  return null;
}

function keySuffix(value) {
  const key = (value || "").trim();
  if (!key) return "";
  if (key.length <= 4) return key;
  return key.slice(-4);
}

async function proxyToLambda(request, lambdaBaseUrl, apiKey) {
  const safeApiKey = (apiKey || "").trim();
  const upstreamUrl = new URL(lambdaBaseUrl);
  upstreamUrl.searchParams.set("apiKey", safeApiKey);

  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("host");
  headers.delete("cf-access-jwt-assertion");
  headers.delete("cf-access-authenticated-user-email");
  headers.delete("cf-connecting-ip");
  headers.delete("x-forwarded-for");
  // Support Lambdas expecting either query-string apiKey or x-api-key header.
  headers.set("x-api-key", safeApiKey);

  const init = {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
  };

  return fetch(upstreamUrl.toString(), init);
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
  async fetch(request, env) {
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

    if (!url.pathname.startsWith("/admin-api/")) {
      return json({ ok: false, code: "NOT_FOUND", message: "Not found" }, 404);
    }

    const accessErr = requireAccess(request, env);
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
          scouts2sqsEndpoint: "/admin-api/scouts2sqs",
          apiKeyLast4: keySuffix(env.SCOUTS_LAMBDA_API_KEY),
        },
        200,
      );
    }

    if (url.pathname === "/admin-api/scouts2sqs" && request.method === "POST") {
      return proxyToLambda(request, env.SCOUTS2SQS_URL, env.SCOUTS_LAMBDA_API_KEY);
    }

    if (url.pathname === "/admin-api/queue" && request.method === "POST") {
      return proxyToLambda(request, env.SCOUTS2SQS_URL, env.SCOUTS_LAMBDA_API_KEY);
    }

    if (url.pathname === "/admin-api/persist" && request.method === "POST") {
      return proxyToLambda(request, env.SCOUTS2SQS_URL, env.SCOUTS_LAMBDA_API_KEY);
    }

    if (url.pathname === "/admin-api/scouts" && request.method === "POST") {
      return proxyToLambda(request, env.SCOUTS_REFRESH_URL, env.SCOUTS_LAMBDA_API_KEY);
    }

    if (url.pathname === "/admin-api/refresh" && request.method === "POST") {
      return proxyToLambda(request, env.SCOUTS_REFRESH_URL, env.SCOUTS_LAMBDA_API_KEY);
    }

    return json({ ok: false, code: "METHOD_OR_PATH_NOT_ALLOWED" }, 405);
  },
};
