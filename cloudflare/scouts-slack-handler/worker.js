const ALLOWED_HOST = "slack.2ndtolworth.org.uk";
const INTERACTIVE_PATH = "/interactive";
const SLACK_REQUEST_TTL_SECONDS = 60 * 5;
const MODAL_ACTION_IDS = new Set(["scouts_request_edit"]);
const WORKER_PROOF_VERSION = "v1";

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function encodeUtf8(value) {
  return new TextEncoder().encode(value);
}

function timingSafeEqual(left, right) {
  const leftBytes = encodeUtf8(left);
  const rightBytes = encodeUtf8(right);
  if (leftBytes.length !== rightBytes.length) return false;

  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }
  return diff === 0;
}

async function hmacSha256(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encodeUtf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encodeUtf8(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseSlackPayload(rawBody) {
  const params = new URLSearchParams(rawBody);
  const payload = params.get("payload");
  if (!payload) throw new Error("Missing Slack payload");
  return JSON.parse(payload);
}

export function classifySlackInteraction(payload) {
  const actionId = payload?.actions?.[0]?.action_id || "";
  return MODAL_ACTION_IDS.has(actionId) ? "modal" : "background";
}

export async function verifySlackRequest(request, rawBody, signingSecret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!signingSecret) throw new Error("SLACK_SIGNING_SECRET is not configured");

  const timestamp = request.headers.get("x-slack-request-timestamp");
  const slackSignature = request.headers.get("x-slack-signature");
  if (!timestamp || !slackSignature) return false;

  const requestTimestamp = Number(timestamp);
  if (!Number.isFinite(requestTimestamp)) return false;

  const requestAge = Math.abs(nowSeconds - requestTimestamp);
  if (requestAge > SLACK_REQUEST_TTL_SECONDS) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const computed = `v0=${await hmacSha256(signingSecret, baseString)}`;
  return timingSafeEqual(computed, slackSignature);
}

async function createWorkerProof(signingSecret, rawBody, slackTimestamp, slackSignature, nowSeconds) {
  const timestamp = String(nowSeconds);
  const payload = `${WORKER_PROOF_VERSION}:${timestamp}:${slackTimestamp}:${slackSignature}:${rawBody}`;
  const signature = `${WORKER_PROOF_VERSION}=${await hmacSha256(signingSecret, payload)}`;
  return { timestamp, signature };
}

async function forwardToAws({ request, rawBody, upstreamUrl, signingSecret, interactionClass }) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cookie");
  headers.delete("cf-connecting-ip");
  headers.delete("x-forwarded-for");
  headers.delete("cf-worker");

  const slackTimestamp = request.headers.get("x-slack-request-timestamp") || "";
  const slackSignature = request.headers.get("x-slack-signature") || "";
  const proof = await createWorkerProof(
    signingSecret,
    rawBody,
    slackTimestamp,
    slackSignature,
    Math.floor(Date.now() / 1000),
  );

  headers.set("x-scouts-worker-timestamp", proof.timestamp);
  headers.set("x-scouts-worker-signature", proof.signature);
  headers.set("x-scouts-interaction-class", interactionClass);

  const response = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: rawBody,
    redirect: "manual",
  });

  if (!response.ok) {
    console.error("[Slack edge] AWS hand-off failed", {
      status: response.status,
      interactionClass,
    });
  }

  return response;
}

function acknowledgedResponse(interactionClass) {
  return new Response("", {
    status: 200,
    headers: {
      "x-scouts-slack-ack": "edge",
      "x-scouts-interaction-class": interactionClass,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const upstreamUrl = (env.SCOUTS_SLACK_HANDLER_URL || "").trim();
    const signingSecret = (env.SLACK_SIGNING_SECRET || "").trim();

    if (url.host !== ALLOWED_HOST) {
      return jsonError(400, `Unhandled host: ${url.host}`);
    }

    if (url.pathname !== INTERACTIVE_PATH) {
      return jsonError(404, "Not found");
    }

    if (request.method !== "POST") {
      return jsonError(405, "Method not allowed");
    }

    if (!upstreamUrl) {
      return jsonError(500, "SCOUTS_SLACK_HANDLER_URL is not configured");
    }

    if (!signingSecret) {
      return jsonError(500, "SLACK_SIGNING_SECRET is not configured");
    }

    const rawBody = await request.text();
    if (!await verifySlackRequest(request, rawBody, signingSecret)) {
      return jsonError(403, "Invalid or stale Slack request");
    }

    let payload;
    try {
      payload = parseSlackPayload(rawBody);
    } catch (error) {
      return jsonError(400, error.message || "Invalid Slack payload");
    }

    const interactionClass = classifySlackInteraction(payload);

    if (interactionClass === "modal") {
      // Modal trigger_ids are short-lived. Start the AWS request immediately,
      // before constructing the Slack acknowledgement, and keep it alive after
      // the 200 response without inserting a queue or other asynchronous hop.
      const modalFastPath = forwardToAws({
        request,
        rawBody,
        upstreamUrl,
        signingSecret,
        interactionClass,
      });
      ctx.waitUntil(modalFastPath);
      return acknowledgedResponse(interactionClass);
    }

    // Non-modal work does not require a trigger_id. Acknowledge Slack at the
    // edge and let Cloudflare keep the AWS hand-off alive in the background.
    ctx.waitUntil((async () => {
      await forwardToAws({
        request,
        rawBody,
        upstreamUrl,
        signingSecret,
        interactionClass,
      });
    })());

    return acknowledgedResponse(interactionClass);
  },
};
