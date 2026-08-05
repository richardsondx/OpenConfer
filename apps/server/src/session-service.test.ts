import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationAdapter, TelephonyAdapter } from "@openconfer/adapter-sdk";
import { createDatabase, SessionStore } from "@openconfer/storage-sqlite";
import type { OpenConferConfig } from "@openconfer/schemas";
import {
  fingerprintCreateInput,
  IdempotencyConflictError,
  SessionService,
} from "./session-service.js";

const baseInput = {
  type: "decision" as const,
  initiator: { agent_id: "svc-test", harness: "vitest" },
  participant: { operator_id: "me" },
  objective: "Approve deployment",
  brief: { reason: "Deployment is waiting" },
  result_schema: {
    type: "object",
    required: ["approved"],
    additionalProperties: false,
    properties: { approved: { type: "boolean" } },
  },
  routing: { policy: "default" },
  urgency: "normal" as const,
};

function configFor(dir: string): OpenConferConfig {
  return {
    server: { base_url: "http://localhost:8787", web_url: "http://localhost:5173", port: 8787, host: "127.0.0.1" },
    storage: { adapter: "sqlite", path: join(dir, "test.db") },
    conversation: {
      adapter: "livekit",
      speaking_mode: "realtime",
      preset: "live",
      model: "test",
      voice: "test",
      realtime: { provider: "openai", model: "test", voice: "test" },
      stt: { provider: "deepgram", model: "nova-3" },
      llm: { provider: "openrouter", model: "openai/gpt-4o-mini" },
      tts: { provider: "cartesia", model: "sonic-3", voice: "test" },
    },
    routes: { default: { notify: ["secure_link"], connect: ["browser"], fallback: [] } },
    operators: { me: { call_name: "Richardson", timezone: "UTC" } },
    auth: { api_token: "test-api-token", jwt_secret: "test-jwt-secret-with-sufficient-entropy" },
  };
}

describe("SessionService lifecycle and idempotency", () => {
  let dir: string;
  let store: SessionStore;
  let endRoom: ReturnType<typeof vi.fn>;
  let service: SessionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openconfer-session-service-"));
    store = new SessionStore(createDatabase(join(dir, "test.db")));
    endRoom = vi.fn(async () => undefined);
    const conversation: ConversationAdapter = {
      name: "test",
      createRoom: async (session) => ({
        roomName: `confer-${session.id}`,
        token: `mock-${session.id}`,
        url: "wss://example.test",
      }),
      endRoom,
      test: async () => ({ ok: true, message: "ok" }),
    };
    service = new SessionService(
      store,
      configFor(dir),
      "test-jwt-secret-with-sufficient-entropy",
      conversation,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the same session for the same key and payload", async () => {
    const first = await service.create({ ...baseInput, idempotency_key: "same-1" });
    const second = await service.create({ ...baseInput, idempotency_key: "same-1" });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("notified");
    expect(first.participant.callName).toBe("Richardson");
  });

  it("dispatches Twilio once and keeps secure link as fallback", async () => {
    const call = vi.fn(async () => ({
      success: true,
      channel: "twilio",
      callId: "CA123",
    }));
    const telephony: TelephonyAdapter = {
      name: "twilio",
      call,
      test: async () => ({ ok: true, message: "ready" }),
    };
    const conversation: ConversationAdapter = {
      name: "test",
      createRoom: async (session) => ({ roomName: `confer-${session.id}` }),
      endRoom: async () => undefined,
    };
    const config = configFor(dir);
    config.conversation.realtime.api_key = "test-openai-key";
    config.routes.default.notify = ["secure_link", "twilio"];
    const twilioService = new SessionService(
      store,
      config,
      "test-jwt-secret-with-sufficient-entropy",
      conversation,
      telephony,
    );

    const first = await twilioService.create({ ...baseInput, idempotency_key: "twilio-once" });
    const second = await twilioService.create({ ...baseInput, idempotency_key: "twilio-once" });
    expect(first.status).toBe("notified");
    expect(second.id).toBe(first.id);
    expect(call).toHaveBeenCalledTimes(1);
    expect(store.getChannelDelivery(first.id, "twilio")).toMatchObject({
      status: "succeeded",
      externalId: "CA123",
    });
  });

  it("keeps a session notified when Twilio fails but secure link succeeds", async () => {
    const telephony: TelephonyAdapter = {
      name: "twilio",
      call: async () => ({ success: false, channel: "twilio", error: "dial failed" }),
      test: async () => ({ ok: true, message: "ready" }),
    };
    const conversation: ConversationAdapter = {
      name: "test",
      createRoom: async (session) => ({ roomName: `confer-${session.id}` }),
      endRoom: async () => undefined,
    };
    const config = configFor(dir);
    config.conversation.realtime.api_key = "test-openai-key";
    config.routes.default.notify = ["twilio", "secure_link"];
    const twilioService = new SessionService(
      store,
      config,
      "test-jwt-secret-with-sufficient-entropy",
      conversation,
      telephony,
    );

    const created = await twilioService.create({ ...baseInput, idempotency_key: "twilio-fallback" });
    expect(created.status).toBe("notified");
    expect(store.getChannelDelivery(created.id, "twilio")).toMatchObject({
      status: "failed",
      error: "dial failed",
    });
  });

  it("rejects the same key with a different payload", async () => {
    await service.create({ ...baseInput, idempotency_key: "conflict-1" });
    await expect(
      service.create({
        ...baseInput,
        objective: "Different objective",
        idempotency_key: "conflict-1",
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("resumes after crash after insert and during notification", async () => {
    const template = await service.create({ ...baseInput, idempotency_key: "template" });
    const now = new Date().toISOString();

    const createdInput = { ...baseInput, objective: "Stuck created", idempotency_key: "stuck-created" };
    store.insert(
      {
        id: "ses_stuck_created",
        type: "decision",
        status: "created",
        initiator: { agentId: "svc-test", harness: "vitest" },
        participant: { operatorId: "me" },
        objective: "Stuck created",
        brief: { reason: "Deployment is waiting" },
        resultSchema: baseInput.result_schema,
        routing: { policy: "default" },
        joinToken: "join-token-created",
        joinUrl: template.joinUrl,
        createdAt: now,
        updatedAt: now,
      },
      "stuck-created",
      fingerprintCreateInput(createdInput),
    );
    const resumedCreated = await service.create(createdInput);
    expect(resumedCreated.id).toBe("ses_stuck_created");
    expect(resumedCreated.status).toBe("notified");

    const dispatchInput = { ...baseInput, objective: "Stuck dispatch", idempotency_key: "stuck-dispatch" };
    store.insert(
      {
        id: "ses_stuck_dispatch",
        type: "decision",
        status: "dispatching",
        initiator: { agentId: "svc-test", harness: "vitest" },
        participant: { operatorId: "me" },
        objective: "Stuck dispatch",
        brief: { reason: "Deployment is waiting" },
        resultSchema: baseInput.result_schema,
        routing: { policy: "default" },
        joinToken: "join-token-dispatch",
        joinUrl: template.joinUrl,
        createdAt: now,
        updatedAt: now,
      },
      "stuck-dispatch",
      fingerprintCreateInput(dispatchInput),
    );
    const resumedDispatch = await service.create(dispatchInput);
    expect(resumedDispatch.id).toBe("ses_stuck_dispatch");
    expect(resumedDispatch.status).toBe("notified");
  });

  it("handles join races without failing concurrent connects", async () => {
    const session = await service.create({ ...baseInput, idempotency_key: "join-race" });
    const token = await service.createJoinJwt(session.id, session.joinToken!);
    const [a, b] = await Promise.all([service.join(session.id, token), service.join(session.id, token)]);
    expect(a?.session.status).toBe("joining");
    expect(b?.session.status).toBe("joining");
    expect(a?.room.roomName).toContain(session.id);
    expect(b?.room.roomName).toContain(session.id);
  });

  it("ends the LiveKit room on confirm, cancel, and decline", async () => {
    const session = await service.create({ ...baseInput, idempotency_key: "room-1" });
    const token = await service.createJoinJwt(session.id, session.joinToken!);
    await service.join(session.id, token);
    service.activate(session.id);
    service.confirm(session.id, { approved: true }, "ok");
    expect(endRoom).toHaveBeenCalledWith(session.id);

    const cancelled = await service.create({ ...baseInput, objective: "cancel me", idempotency_key: "room-2" });
    service.cancel(cancelled.id);
    expect(endRoom).toHaveBeenCalledWith(cancelled.id);

    const declined = await service.create({ ...baseInput, objective: "decline me", idempotency_key: "room-3" });
    service.decline(declined.id, "not now");
    expect(endRoom).toHaveBeenCalledWith(declined.id);
  });

  it("allows active session cancellation by the human", async () => {
    const session = await service.create({ ...baseInput, idempotency_key: "active-cancel" });
    const token = await service.createJoinJwt(session.id, session.joinToken!);
    await service.join(session.id, token);
    service.activate(session.id);
    const cancelled = service.cancel(session.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(endRoom).toHaveBeenCalledWith(session.id);
  });

  it("snoozes a notified session and wakes with re-notify", async () => {
    const session = await service.create({ ...baseInput, idempotency_key: "snooze-1" });
    expect(session.status).toBe("notified");

    const snoozed = service.snooze(session.id, 1);
    expect(snoozed?.status).toBe("snoozed");
    expect(snoozed?.snoozeUntil).toBeTruthy();

    const seen = await service.create({ ...baseInput, objective: "seen me", idempotency_key: "seen-1" });
    const marked = service.seen(seen.id);
    expect(marked?.status).toBe("notified");
    expect(marked?.operatorSeenAt).toBeTruthy();

    store.update(session.id, {
      snoozeUntil: new Date(Date.now() - 1_000).toISOString(),
    });
    const woken = await service.wakeDueSnoozes();
    expect(woken).toBe(1);
    expect(store.getById(session.id)?.status).toBe("notified");
    expect(store.getById(session.id)?.snoozeUntil).toBeUndefined();
  });

  it("rejects snooze minutes outside the allowlist", async () => {
    const session = await service.create({ ...baseInput, idempotency_key: "snooze-bad" });
    expect(() => service.snooze(session.id, 7)).toThrow(/not allowed/);
  });
});
