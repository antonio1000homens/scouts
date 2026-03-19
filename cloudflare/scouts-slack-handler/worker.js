const ALLOWED_HOST = "slack.2ndtolworth.org.uk";
const INTERACTIVE_PATH = "/interactive";

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const upstreamUrl = (env.SCOUTS_SLACK_HANDLER_URL || "").trim();

    if (url.host !== ALLOWED_HOST) {
      return jsonError(400, `Unhandled host: ${url.host}`);
    }

    if (url.pathname !== INTERACTIVE_PATH) {
      return jsonError(404, "Not found");
    }

    if (!upstreamUrl) {
      return jsonError(500, "SCOUTS_SLACK_HANDLER_URL is not configured");
    }

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("cookie");
    headers.delete("cf-connecting-ip");
    headers.delete("x-forwarded-for");
    headers.delete("cf-worker");

    const init = {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
    };

    return fetch(upstreamUrl, init);
  },
};
