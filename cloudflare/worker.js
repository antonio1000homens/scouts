const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

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
  if (!env.SCOUTS_LAMBDA_API_KEY) {
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

async function proxyToLambda(request, lambdaBaseUrl, apiKey) {
  const upstreamUrl = new URL(lambdaBaseUrl);
  upstreamUrl.searchParams.set("apiKey", apiKey);

  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("host");
  headers.delete("cf-access-jwt-assertion");
  headers.delete("cf-access-authenticated-user-email");
  headers.delete("cf-connecting-ip");
  headers.delete("x-forwarded-for");

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

    if (!url.pathname.startsWith("/admin-api/")) {
      return json({ ok: false, code: "NOT_FOUND", message: "Not found" }, 404);
    }

    const accessErr = requireAccess(request, env);
    if (accessErr) return accessErr;

    const configErr = requireConfig(env);
    if (configErr) return configErr;

    if (url.pathname === "/admin-api/auth-status" && request.method === "GET") {
      return json({ ok: true, code: "READY", message: "Proxy and API key are configured." }, 200);
    }

    if (url.pathname === "/admin-api/persist" && request.method === "POST") {
      return proxyToLambda(request, env.SCOUTS2SQS_URL, env.SCOUTS_LAMBDA_API_KEY);
    }

    if (url.pathname === "/admin-api/refresh" && request.method === "POST") {
      return proxyToLambda(request, env.SCOUTS_REFRESH_URL, env.SCOUTS_LAMBDA_API_KEY);
    }

    return json({ ok: false, code: "METHOD_OR_PATH_NOT_ALLOWED" }, 405);
  },
};

