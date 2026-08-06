import Fastify from "fastify";
import cors from "@fastify/cors";
import { createDatabase, SessionStore } from "@openconfer/storage-sqlite";
import { generateApiToken, verifyApiToken } from "@openconfer/auth-local";
import {
  CreateSessionSchema,
  ConfirmResultSchema,
  AckResultSchema,
  SettingsPatchSchema,
  SnoozeSessionSchema,
  PreviewDecisionSchema,
} from "@openconfer/schemas";
import { loadConfig, getDbPath } from "./config.js";
import {
  IdempotencyConflictError,
  PreviewConflictError,
  SessionService,
  SubmissionConflictError,
} from "./session-service.js";
import { startWebhookWorker } from "./webhook-worker.js";
import {
  applySettingsPatch,
  DEMO_SESSION_PAYLOADS,
  persistConfig,
  revealSettingsSecret,
  SETTINGS_SECRET_NAMES,
  toSettingsView,
  type SettingsSecretName,
} from "./settings.js";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export async function buildServer() {
  let config = loadConfig();
  const dbPath = getDbPath(config);
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  const db = createDatabase(dbPath);
  const store = new SessionStore(db);
  const jwtSecret = process.env.OPENCONFER_JWT_SECRET || process.env.OPENCONFER_EFFECTIVE_JWT_SECRET || config.auth.jwt_secret || config.auth.api_token;
  if (!jwtSecret) throw new Error("Configure auth.jwt_secret before starting OpenConfer");
  const sessions = new SessionService(store, config, jwtSecret);

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.addHook("onRequest", async (req, reply) => {
    if (
      req.url.startsWith("/v1/join/") ||
      req.url.startsWith("/health") ||
      req.method === "OPTIONS"
    ) {
      return;
    }
    // Allow human confirm/decline/cancel/snooze/seen with join token
    if (
      req.method === "POST" &&
      (/\/v1\/sessions\/[^/]+\/confirm$/.test(req.url.split("?")[0] ?? "") ||
        /\/v1\/sessions\/[^/]+\/decline$/.test(req.url.split("?")[0] ?? "") ||
        /\/v1\/sessions\/[^/]+\/cancel$/.test(req.url.split("?")[0] ?? "") ||
        /\/v1\/sessions\/[^/]+\/snooze$/.test(req.url.split("?")[0] ?? "") ||
        /\/v1\/sessions\/[^/]+\/seen$/.test(req.url.split("?")[0] ?? "") ||
        /\/v1\/sessions\/[^/]+\/phone\/call$/.test(req.url.split("?")[0] ?? "") ||
        /\/v1\/sessions\/[^/]+\/phone\/stop$/.test(req.url.split("?")[0] ?? ""))
    ) {
      const joinToken = req.headers["x-join-token"] as string | undefined;
      if (joinToken) {
        const id = req.url.split("/")[3];
        if (id && (await sessions.authorizeJoin(id, joinToken))) return;
      }
    }
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const expected = config.auth.api_token ?? process.env.OPENCONFER_API_TOKEN;
    if (!expected || !token || !verifyApiToken(token, expected)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.get("/health", async () => ({ status: "ok", service: "openconfer" }));

  app.get("/v1/settings", async () => toSettingsView(config));

  app.post("/v1/settings/secrets/reveal", async (req, reply) => {
    const name =
      req.body && typeof req.body === "object" && "name" in req.body
        ? (req.body as { name?: unknown }).name
        : undefined;
    if (typeof name !== "string" || !SETTINGS_SECRET_NAMES.includes(name as SettingsSecretName)) {
      return reply.code(400).send({ error: "Unknown settings secret" });
    }
    const value = revealSettingsSecret(config, name as SettingsSecretName);
    if (!value) return reply.code(404).send({ error: "That secret is not configured" });
    return reply.header("Cache-Control", "no-store").send({ value });
  });

  app.patch("/v1/settings", async (req, reply) => {
    const parsed = SettingsPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { config: next, restartRequired } = applySettingsPatch(config, parsed.data);
    persistConfig(next);
    config = next;
    sessions.replaceConfig(next);
    const view = await toSettingsView(config);
    view.status.restart_required = restartRequired;
    return view;
  });

  app.post("/v1/settings/token/rotate", async () => {
    const token = generateApiToken();
    const next = structuredClone(config);
    next.auth.api_token = token;
    persistConfig(next);
    config = next;
    sessions.replaceConfig(next);
    return {
      api_token: token,
      settings: await toSettingsView(config),
    };
  });

  app.post("/v1/sessions/demo", async (req, reply) => {
    const settings = await toSettingsView(config);
    if (!settings.status.voice_ready) {
      const missing =
        settings.status.livekit !== "ready"
          ? "LiveKit is not ready. Run openconfer serve and confirm the room is up."
          : "Add an OpenAI API key in Voice settings so the test call can speak.";
      return reply.code(503).send({
        error: `Sandbox test call needs LiveKit and an OpenAI key. ${missing}`,
      });
    }
    const requestedUseCase =
      req.body && typeof req.body === "object" && "use_case" in req.body
        ? (req.body as { use_case?: unknown }).use_case
        : "decision";
    if (
      requestedUseCase !== "decision" &&
      requestedUseCase !== "briefing" &&
      requestedUseCase !== "standup" &&
      requestedUseCase !== "approval"
    ) {
      return reply.code(400).send({ error: "Unknown sandbox use case" });
    }
    const parsed = CreateSessionSchema.safeParse(DEMO_SESSION_PAYLOADS[requestedUseCase]);
    if (!parsed.success) {
      return reply.code(500).send({ error: "Sandbox test call payload invalid" });
    }
    try {
      const session = await sessions.create(parsed.data);
      const delivery = config.routes.default.notify.includes("twilio")
        ? await sessions.getTelephonyDelivery(session.id)
        : null;
      return reply.code(201).send({
        id: session.id,
        status: session.status,
        created_at: session.createdAt,
        join_url: session.joinUrl,
        objective: session.objective,
        pending_decision: serializePendingDecision(session),
        phone_retry: serializePhoneRetry(session),
        ...(delivery ? { delivery } : {}),
        links: { self: `/v1/sessions/${session.id}` },
      });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Invalid session",
      });
    }
  });

  app.get("/v1/sessions/:id/delivery/twilio", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!sessions.get(id)) return reply.code(404).send({ error: "Session not found" });
    const delivery = await sessions.getTelephonyDelivery(id);
    if (!delivery) return reply.code(404).send({ error: "No phone delivery exists for this session" });
    return delivery;
  });

  app.post("/v1/sessions", async (req, reply) => {
    const parsed = CreateSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const headerKey = req.headers["idempotency-key"];
    if (Array.isArray(headerKey)) return reply.code(400).send({ error: "Invalid Idempotency-Key" });
    if (headerKey && parsed.data.idempotency_key && headerKey !== parsed.data.idempotency_key) {
      return reply.code(400).send({ error: "Idempotency keys do not match" });
    }
    const idempotencyKey = headerKey ?? parsed.data.idempotency_key;
    const existing = idempotencyKey ? store.getByIdempotencyKey(idempotencyKey) : null;
    let session;
    try {
      session = await sessions.create({ ...parsed.data, idempotency_key: idempotencyKey });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid session" });
    }
    return reply.code(existing ? 200 : 201).send({
      id: session.id,
      status: session.status,
      created_at: session.createdAt,
      join_url: session.joinUrl,
      continuity: session.continuity,
      continuity_trace: session.continuityTrace,
      pending_decision: serializePendingDecision(session),
      phone_retry: serializePhoneRetry(session),
      links: { self: `/v1/sessions/${session.id}` },
    });
  });

  app.get("/v1/sessions", async () => {
    const list = sessions.list();
    return { sessions: list.map(toApiSession) };
  });

  app.get("/v1/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessions.get(id);
    if (!session) return reply.code(404).send({ error: "Not found" });
    return toApiSession(session);
  });

  app.post("/v1/sessions/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessions.cancel(id);
    if (!session) return reply.code(404).send({ error: "Not found" });
    return toApiSession(session);
  });

  app.post("/v1/sessions/:id/decline", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body as { reason?: string }) ?? {};
    const session = sessions.decline(id, body.reason);
    if (!session) return reply.code(404).send({ error: "Not found" });
    return toApiSession(session);
  });

  app.post("/v1/sessions/:id/snooze", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = SnoozeSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const session = sessions.snooze(id, parsed.data.minutes);
      if (!session) return reply.code(404).send({ error: "Not found or not awaiting you" });
      return toApiSession(session);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Invalid snooze request",
      });
    }
  });

  app.post("/v1/sessions/:id/seen", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessions.seen(id);
    if (!session) return reply.code(404).send({ error: "Not found or not awaiting you" });
    return toApiSession(session);
  });

  app.post("/v1/sessions/:id/confirm", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ConfirmResultSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const session = sessions.confirm(
        id,
        parsed.data.result,
        parsed.data.summary,
        parsed.data.method,
        parsed.data.captured_context,
        parsed.data.submission_id,
        parsed.data.preview_revision,
      );
      if (!session) return reply.code(404).send({ error: "Not found or invalid state" });
      return toResult(session);
    } catch (err) {
      if (err instanceof SubmissionConflictError || err instanceof PreviewConflictError) {
        return reply.code(409).send({ error: err.message });
      }
      return reply.code(400).send({
        error: err instanceof Error ? err.message : "Validation failed",
      });
    }
  });

  app.post("/v1/sessions/:id/preview", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PreviewDecisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const preview = sessions.preview(
        id,
        parsed.data.result,
        parsed.data.summary,
        parsed.data.captured_context,
        parsed.data.expected_revision,
      );
      if (!preview) return reply.code(404).send({ error: "Not found or invalid state" });
      return {
        result: preview.result,
        summary: preview.summary,
        captured_context: preview.capturedContext,
        revision: preview.revision,
        previewed_at: preview.previewedAt,
      };
    } catch (error) {
      if (error instanceof PreviewConflictError) return reply.code(409).send({ error: error.message });
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid preview" });
    }
  });

  app.post("/v1/sessions/:id/phone/call", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const session = await sessions.callAgain(id);
      if (!session) return reply.code(404).send({ error: "Not found or session is closed" });
      return toApiSession(session);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Could not start call" });
    }
  });

  app.post("/v1/sessions/:id/phone/stop", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessions.stopPhoneRetries(id);
    if (!session) return reply.code(404).send({ error: "Not found or session is closed" });
    return toApiSession(session);
  });

  app.post("/v1/sessions/:id/voice/stop", async (req, reply) => {
    const { id } = req.params as { id: string };
    const requestedReason =
      req.body && typeof req.body === "object" && "reason" in req.body
        ? (req.body as { reason?: unknown }).reason
        : undefined;
    const allowedReasons = ["idle_timeout", "max_duration", "operator_request"] as const;
    const reason = allowedReasons.find((candidate) => candidate === requestedReason) ?? "operator_request";
    const session = await sessions.disconnectVoice(id, reason);
    if (!session) return reply.code(404).send({ error: "Not found" });
    return toApiSession(session);
  });

  app.post("/v1/sessions/:id/ack", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = AckResultSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const session = sessions.acknowledge(id, parsed.data.run_id);
    if (!session) return reply.code(404).send({ error: "Not found or invalid state" });
    return toApiSession(session);
  });

  app.get("/v1/sessions/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessions.get(id);
    if (!session) return reply.code(404).send({ error: "Not found" });
    return { events: store.getEvents(id) };
  });

  app.get("/v1/join/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const token = req.headers["x-join-token"] as string | undefined;
    const session = token ? await sessions.authorizeJoin(id, token) : null;
    if (!session) {
      return reply.code(404).send({ error: "Invalid join link" });
    }
    return {
      session: toJoinSession(session),
      acknowledged: store.isAcknowledged(id),
    };
  });

  app.post("/v1/join/:id/connect", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { token } = (req.body as { token?: string }) ?? {};
    if (!token) return reply.code(400).send({ error: "Token required" });
    try {
      if (!(await sessions.authorizeJoin(id, token))) {
        return reply.code(404).send({ error: "Invalid join link or session is no longer joinable." });
      }
      await sessions.prepareBrowserJoin(id);
      const connection = await sessions.join(id, token);
      if (!connection) return reply.code(404).send({ error: "Invalid join link or session is no longer joinable." });
      return {
        session: toJoinSession(connection.session),
        room: {
          room_name: connection.room.roomName,
          url: connection.room.url,
          token: connection.room.token,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not open the voice room.";
      if (/invalid api key|unauthorized/i.test(message)) {
        return reply.code(502).send({
          error:
            "LiveKit rejected the API key. Local openconfer serve needs the built-in devkey credentials against ws://127.0.0.1:7880 — restart serve to restore them, or paste matching LiveKit Cloud URL + keys in Settings → Voice.",
        });
      }
      return reply.code(502).send({
        error: /livekit|credential|api key|api secret/i.test(message)
          ? `${message} Check Settings → Voice, then restart openconfer serve.`
          : message,
      });
    }
  });

  app.post("/v1/join/:id/active", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { token } = (req.body as { token?: string }) ?? {};
    if (!token || !(await sessions.authorizeJoin(id, token))) {
      return reply.code(404).send({ error: "Invalid join link" });
    }
    const session = sessions.activate(id);
    if (!session) return reply.code(409).send({ error: "Session is not joining" });
    return { session: toJoinSession(session) };
  });

  const worker = startWebhookWorker(store);
  const expirySweep = setInterval(() => sessions.expireDueSessions(), 30_000);
  const snoozeSweep = setInterval(() => {
    void sessions.wakeDueSnoozes();
  }, 15_000);
  let telephonySweepRunning = false;
  const telephonySweep = setInterval(() => {
    if (telephonySweepRunning) return;
    telephonySweepRunning = true;
    void sessions.reconcileTelephonyDeliveries().finally(() => {
      telephonySweepRunning = false;
    });
  }, 3_000);

  app.addHook("onClose", async () => {
    clearInterval(worker);
    clearInterval(expirySweep);
    clearInterval(snoozeSweep);
    clearInterval(telephonySweep);
  });

  return { app, config, store, sessions };
}

function toApiSession(session: import("@openconfer/core").ConferSession) {
  return {
    id: session.id,
    type: session.type,
    status: session.status,
    objective: session.objective,
    brief: session.brief,
    initiator: {
      agent_id: session.initiator.agentId,
      harness: session.initiator.harness,
      project: session.initiator.project,
    },
    participant: { operator_id: session.participant.operatorId },
    urgency: session.urgency,
    estimated_duration_minutes: session.estimatedDurationMinutes,
    expires_at: session.expiresAt,
    snooze_until: session.snoozeUntil,
    operator_seen_at: session.operatorSeenAt,
    join_url: session.joinUrl,
    result: session.result,
    summary: session.summary,
    captured_context: session.capturedContext,
    continuity: session.continuity,
    continuity_trace: session.continuityTrace,
    continuity_capsule: session.continuityCapsule
      ? {
          continuity_version: session.continuityCapsule.continuityVersion,
          summary: session.continuityCapsule.summary,
          decisions: session.continuityCapsule.decisions,
          open_threads: session.continuityCapsule.openThreads,
          suggested_memory_updates: session.continuityCapsule.suggestedMemoryUpdates,
          context_sources: session.continuityCapsule.contextSources,
        }
      : undefined,
    pending_decision: serializePendingDecision(session),
    phone_retry: serializePhoneRetry(session),
    has_callback: Boolean(session.callback?.url),
    continuation: session.continuation
      ? {
          run_id: session.continuation.runId,
          opaque_token: session.continuation.opaqueToken,
        }
      : undefined,
    human_confirmation: session.humanConfirmation
      ? {
          confirmed_at: session.humanConfirmation.confirmedAt,
          method: session.humanConfirmation.method,
        }
      : undefined,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

function toJoinSession(session: import("@openconfer/core").ConferSession) {
  return {
    id: session.id,
    type: session.type,
    status: session.status,
    objective: session.objective,
    brief: session.brief,
    initiator: {
      agent_id: session.initiator.agentId,
      harness: session.initiator.harness,
      project: session.initiator.project,
    },
    urgency: session.urgency,
    estimated_duration_minutes: session.estimatedDurationMinutes,
    expires_at: session.expiresAt,
    snooze_until: session.snoozeUntil,
    operator_seen_at: session.operatorSeenAt,
    result_schema: session.resultSchema,
    result: session.result,
    summary: session.summary,
    captured_context: session.capturedContext,
    continuity_capsule: session.continuityCapsule
      ? {
          continuity_version: session.continuityCapsule.continuityVersion,
          summary: session.continuityCapsule.summary,
          decisions: session.continuityCapsule.decisions,
          open_threads: session.continuityCapsule.openThreads,
          suggested_memory_updates: session.continuityCapsule.suggestedMemoryUpdates,
          context_sources: session.continuityCapsule.contextSources,
        }
      : undefined,
    pending_decision: serializePendingDecision(session),
    phone_retry: serializePhoneRetry(session),
    has_callback: Boolean(session.callback?.url),
  };
}

function serializePendingDecision(session: import("@openconfer/core").ConferSession) {
  return session.pendingDecision
    ? {
        result: session.pendingDecision.result,
        summary: session.pendingDecision.summary,
        captured_context: session.pendingDecision.capturedContext,
        revision: session.pendingDecision.revision,
        previewed_at: session.pendingDecision.previewedAt,
      }
    : undefined;
}

function serializePhoneRetry(session: import("@openconfer/core").ConferSession) {
  if (!session.phoneRetry) return undefined;
  const callbackLimits = { never: 0, brief: 2, persistent: 5 } as const;
  return {
    policy: session.phoneRetry.policy,
    state: session.phoneRetry.state,
    attempt_count: session.phoneRetry.attemptCount ?? 0,
    automatic_callbacks_used: session.phoneRetry.automaticCallbacksUsed,
    max_automatic_callbacks: callbackLimits[session.phoneRetry.policy],
    automatic_stopped: session.phoneRetry.automaticStopped,
    next_retry_at: session.phoneRetry.nextRetryAt,
    deadline_at: session.phoneRetry.deadlineAt,
    last_outcome: session.phoneRetry.lastOutcome,
    blocked_reason: session.phoneRetry.blockedReason,
  };
}

function toResult(session: import("@openconfer/core").ConferSession) {
  return {
    session_id: session.id,
    status: session.status,
    completion_reason: "human_confirmed",
    summary: session.summary ?? "",
    result: session.result,
    captured_context: session.capturedContext,
    continuity_capsule: session.continuityCapsule
      ? {
          continuity_version: session.continuityCapsule.continuityVersion,
          summary: session.continuityCapsule.summary,
          decisions: session.continuityCapsule.decisions,
          open_threads: session.continuityCapsule.openThreads,
          suggested_memory_updates: session.continuityCapsule.suggestedMemoryUpdates,
          context_sources: session.continuityCapsule.contextSources,
        }
      : undefined,
    continuation: session.continuation
      ? {
          run_id: session.continuation.runId,
          opaque_token: session.continuation.opaqueToken,
        }
      : undefined,
    human_confirmation: session.humanConfirmation
      ? {
          confirmed_at: session.humanConfirmation.confirmedAt,
          method: session.humanConfirmation.method,
        }
      : undefined,
  };
}

async function main() {
  const { app, config } = await buildServer();
  const port = config.server.port;
  const host = config.server.host;
  await app.listen({ port, host });
  console.log(`OpenConfer server listening on ${config.server.base_url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(console.error);
}
