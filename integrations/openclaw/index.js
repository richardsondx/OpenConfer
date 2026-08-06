import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const DEFAULT_REPLAY_MS = 5 * 60_000;

export function webhookSignatureInput(timestamp, eventId, payload) {
  return `${timestamp}.${eventId}.${payload}`;
}

export function verifySignedWebhook({ timestamp, eventId, body, signature, secret, now = Date.now(), maxSkewMs = DEFAULT_REPLAY_MS }) {
  const age = Math.abs(now - Date.parse(timestamp));
  if (!Number.isFinite(age) || age > maxSkewMs) return false;
  const expected = createHmac("sha256", secret)
    .update(webhookSignatureInput(timestamp, eventId, body))
    .digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** In-memory routing of session results back to OpenClaw task/run ids. */
export function createResultRouter() {
  const bySession = new Map();
  const processedEvents = new Set();

  return {
    track(sessionId, task) {
      bySession.set(sessionId, task);
    },
    get(sessionId) {
      return bySession.get(sessionId);
    },
    async ingest({ eventId, sessionId, payload, acknowledge }) {
      if (processedEvents.has(eventId)) {
        return { duplicate: true, task: bySession.get(sessionId) };
      }
      processedEvents.add(eventId);
      const task = bySession.get(sessionId);
      if (task && acknowledge) {
        await acknowledge(sessionId, task.runId);
      }
      return { duplicate: false, task, payload };
    },
  };
}

export function createWebhookReceiver({ secret, router, acknowledge, onResult }) {
  return createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const timestamp = String(req.headers["x-openconfer-timestamp"] ?? "");
    const eventId = String(req.headers["x-openconfer-event-id"] ?? "");
    const signature = String(req.headers["x-openconfer-signature"] ?? "");
    if (!verifySignedWebhook({ timestamp, eventId, body, signature, secret })) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid signature" }));
      return;
    }
    const payload = JSON.parse(body);
    const sessionId = payload.session_id;
    const result = await router.ingest({
      eventId,
      sessionId,
      payload,
      acknowledge: acknowledge
        ? (id, runId) => acknowledge(id, runId)
        : undefined,
    });
    if (onResult && !result.duplicate) await onResult(result);
    res.writeHead(204).end();
  });
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OpenConfer request failed (${response.status}): ${JSON.stringify(result)}`);
  }
  return result;
}

const plugin = {
  id: "openconfer",
  name: "OpenConfer",
  description: "Requests structured human decision sessions and routes signed results",
  register(api) {
    const config = api.pluginConfig ?? {};
    const baseUrl = String(config.baseUrl ?? "http://localhost:8787").replace(/\/$/, "");
    const apiToken = String(config.apiToken ?? "");
    const webhookSecret = String(config.webhookSecret ?? "");
    const router = createResultRouter();
    let receiver;

    if (webhookSecret && config.webhookPort) {
      receiver = createWebhookReceiver({
        secret: webhookSecret,
        router,
        acknowledge: async (sessionId, runId) => {
          await requestJson(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/ack`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiToken}`,
            },
            body: JSON.stringify({ run_id: runId }),
          });
        },
        onResult: async ({ task, payload }) => {
          if (api.emit && task) {
            api.emit("openconfer.result", { task, payload });
          }
        },
      });
      receiver.listen(Number(config.webhookPort));
    }

    api.registerTool({
      name: "request_human_session",
      description: "Request a structured decision from a human through OpenConfer",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          objective: { type: "string" },
          brief: {
            type: "object",
            additionalProperties: true,
            properties: { reason: { type: "string" } },
            required: ["reason"],
          },
          result_schema: { type: "object", additionalProperties: true },
          continuity: {
            type: "object",
            description: "Optional source-agent identity, relationship, and active-thread context. Never include provider secrets.",
            additionalProperties: true,
          },
          type: { type: "string", enum: ["decision", "approval", "briefing", "incident"] },
          urgency: { type: "string", enum: ["normal", "high", "incident"] },
          run_id: { type: "string" },
          callback_url: { type: "string" },
        },
        required: ["objective", "brief", "result_schema"],
      },
      async execute(id, params) {
        if (!apiToken) throw new Error("OpenConfer apiToken is not configured");
        const runId = params.run_id ?? `openclaw-${id}`;
        const body = {
          type: params.type ?? "decision",
          urgency: params.urgency ?? "normal",
          objective: params.objective,
          brief: params.brief,
          result_schema: params.result_schema,
          ...(params.continuity ? { continuity: params.continuity } : {}),
          initiator: {
            agent_id: config.agentId ?? "openclaw",
            harness: "openclaw",
            ...(config.project ? { project: config.project } : {}),
          },
          participant: { operator_id: config.operatorId ?? "me" },
          continuation: { run_id: runId, opaque_token: String(id) },
        };
        if (params.callback_url || config.callbackUrl) {
          body.callback = {
            url: params.callback_url ?? config.callbackUrl,
            secret: webhookSecret || undefined,
          };
        }
        const result = await requestJson(`${baseUrl}/v1/sessions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
            "Idempotency-Key": String(id),
          },
          body: JSON.stringify(body),
        });
        router.track(result.id, { toolCallId: String(id), runId });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    });

    api.registerTool({
      name: "wait_human_session",
      description: "Wait until an OpenConfer session reaches a terminal result state",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          session_id: { type: "string" },
          timeout_ms: { type: "number" },
        },
        required: ["session_id"],
      },
      async execute(_id, params) {
        if (!apiToken) throw new Error("OpenConfer apiToken is not configured");
        const deadline = Date.now() + (params.timeout_ms ?? 15 * 60_000);
        while (Date.now() < deadline) {
          const session = await requestJson(`${baseUrl}/v1/sessions/${encodeURIComponent(params.session_id)}`, {
            headers: { Authorization: `Bearer ${apiToken}` },
          });
          if (["completed", "result_delivered", "result_acknowledged", "cancelled", "declined", "expired", "failed"].includes(session.status)) {
            return { content: [{ type: "text", text: JSON.stringify(session, null, 2) }], details: session };
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        throw new Error(`Timed out waiting for session ${params.session_id}`);
      },
    });

    api.registerTool({
      name: "acknowledge_human_session",
      description: "Acknowledge an OpenConfer result and resume the OpenClaw task",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          session_id: { type: "string" },
          run_id: { type: "string" },
        },
        required: ["session_id"],
      },
      async execute(id, params) {
        if (!apiToken) throw new Error("OpenConfer apiToken is not configured");
        const task = router.get(params.session_id);
        const result = await requestJson(`${baseUrl}/v1/sessions/${encodeURIComponent(params.session_id)}/ack`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
            "Idempotency-Key": `ack-${id}`,
          },
          body: JSON.stringify({ run_id: params.run_id ?? task?.runId }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      },
    });

    return () => {
      receiver?.close();
    };
  },
};

export default plugin;
