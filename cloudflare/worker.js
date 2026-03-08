const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

// ---------------------------------------------------------------------------
// Contact-form helpers
// ---------------------------------------------------------------------------

async function validateTurnstile(token, remoteIp, secretKey) {
  const params = { secret: secretKey, response: token };
  if (remoteIp) {
    params.remoteip = remoteIp;
  }
  const body = new URLSearchParams(params);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  const data = await res.json();
  return data.success === true;
}

async function sendToIfttt(name, email, message, env) {
  const webhookKey = (env.IFTTT_WEBHOOK_KEY || "").trim();
  const webhookEvent = (env.IFTTT_WEBHOOK_EVENT || "").trim();
  if (!webhookKey || !webhookEvent) {
    return { ok: false, error: "IFTTT webhook not configured." };
  }
  const url = `https://maker.ifttt.com/trigger/${encodeURIComponent(webhookEvent)}/with/key/${encodeURIComponent(webhookKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value1: name, value2: email, value3: message }),
  });
  if (res.ok) {
    return { ok: true };
  }
  const text = await res.text();
  return { ok: false, error: `IFTTT responded with ${res.status}: ${text}` };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
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
      return handleOptions();
    }

    // ------------------------------------------------------------------
    // Public contact-form endpoint – no Cloudflare Access required,
    // but protected by Cloudflare Turnstile captcha.
    // ------------------------------------------------------------------
    if (url.pathname === "/contact-api/submit" && request.method === "POST") {
      const turnstileSecret = (env.TURNSTILE_SECRET_KEY || "").trim();
      if (!turnstileSecret) {
        return json(
          { ok: false, code: "MISSING_TURNSTILE_SECRET", message: "Captcha verification is not configured." },
          500,
        );
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, code: "INVALID_JSON", message: "Request body must be valid JSON." }, 400);
      }

      const { name, email, message } = body;
      const token = body["cf-turnstile-response"] || "";

      if (!name || !email || !message) {
        return json({ ok: false, code: "MISSING_FIELDS", message: "name, email and message are required." }, 400);
      }
      if (!token) {
        return json({ ok: false, code: "MISSING_CAPTCHA", message: "Captcha token is required." }, 400);
      }

      const remoteIp = request.headers.get("cf-connecting-ip") || "";
      const captchaOk = await validateTurnstile(token, remoteIp, turnstileSecret);
      if (!captchaOk) {
        return json({ ok: false, code: "CAPTCHA_FAILED", message: "Captcha verification failed. Please try again." }, 403);
      }

      const result = await sendToIfttt(name, email, message, env);
      if (!result.ok) {
        return json({ ok: false, code: "IFTTT_ERROR", message: result.error || "Failed to send message." }, 502);
      }

      return json({ ok: true, message: "Message sent successfully." });
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
