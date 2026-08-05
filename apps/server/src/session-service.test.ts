import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationAdapter, TelephonyAdapter } from "@openconfer/adapter-sdk";
import { createDatabase, SessionStore } from "@openconfer/storage-sqlite";
import { DEFAULT_OPERATOR_ALERTS, type OpenConferConfig } from "@openconfer/schemas";
import {
  fingerprintCreateInput,
  IdempotencyConflictError,
  SessionService,
} from "./session-service.js";

const baseInput = {
  type: "decision" as const,
  locale: "en",
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

  it.each(["busy", "failed", "no-answer", "canceled", "completed"])(
    "keeps a waiting phone session open and schedules a callback when Twilio reports %s",
    async (providerStatus) => {
      const telephony: TelephonyAdapter = {
        name: "twilio",
        call: async () => ({ success: true, channel: "twilio", callId: "CA-terminal" }),
        status: async () => ({ success: true, status: providerStatus }),
        test: async () => ({ ok: true, message: "ready" }),
      };
      const conversation: ConversationAdapter = {
        name: "test",
        createRoom: async (session) => ({ roomName: `confer-${session.id}` }),
        endRoom,
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

      const created = await twilioService.create({
        ...baseInput,
        idempotency_key: `twilio-terminal-${providerStatus}`,
      });
      const delivery = await twilioService.getTelephonyDelivery(created.id);

      expect(delivery).toMatchObject({
        provider_status: providerStatus,
        session_status: "notified",
        session_ended: false,
        phone_retry: { state: "scheduled", automaticCallbacksUsed: 0 },
      });
      expect(store.getById(created.id)?.status).toBe("notified");
      expect(store.getById(created.id)?.phoneRetry?.nextRetryAt).toBeTruthy();
      expect(endRoom).toHaveBeenCalledWith(expect.stringContaining(`${created.id}-call-1`));
    },
  );

  it("allows the phone voice agent to complete a waiting session", async () => {
    const created = await service.create({ ...baseInput, idempotency_key: "voice-confirm" });
    const preview = service.preview(created.id, { approved: true }, "Approved by phone");

    const completed = service.confirm(
      created.id,
      { approved: true },
      "Approved by phone",
      "voice_agent",
      undefined,
      "voice-submit-1",
      preview!.revision,
    );

    expect(completed?.status).toBe("completed");
    expect(completed?.humanConfirmation?.method).toBe("voice_agent");
    expect(completed?.capturedContext).toEqual({
      steering: [],
      additional_instructions: [],
      new_requests: [],
      unresolved_topics: [],
    });
  });

  it("reconciles and schedules callbacks without a browser poll", async () => {
    const telephony: TelephonyAdapter = {
      name: "twilio",
      call: async () => ({ success: true, channel: "twilio", callId: "CA-background" }),
      status: async () => ({ success: true, status: "no-answer" }),
      test: async () => ({ ok: true, message: "ready" }),
    };
    const config = configFor(dir);
    config.conversation.realtime.api_key = "test-openai-key";
    config.routes.default.notify = ["twilio", "secure_link"];
    const twilioService = new SessionService(
      store,
      config,
      "test-jwt-secret-with-sufficient-entropy",
      undefined,
      telephony,
    );
    const created = await twilioService.create({
      ...baseInput,
      idempotency_key: "twilio-background-terminal",
    });

    expect(await twilioService.reconcileTelephonyDeliveries()).toBe(1);
    expect(store.getById(created.id)?.status).toBe("notified");
    expect(store.getById(created.id)?.phoneRetry?.state).toBe("scheduled");
  });

  it("recovers a stale scheduler claim after restart", async () => {
    const created = await service.create({
      ...baseInput,
      initiator: { agent_id: "svc-stale-phone-claim", harness: "vitest" },
      idempotency_key: "stale-phone-claim",
    });
    const claimed = store.createPhoneAttempt({
      id: "call_stale_claim",
      sessionId: created.id,
      operatorId: "me",
      trigger: "initial",
      status: "dialing",
    });
    store.updatePhoneAttempt(claimed.id, {
      startedAt: new Date(Date.now() - 61_000).toISOString(),
    });

    expect(await service.processDuePhoneRetries()).toBe(0);
    expect(store.getPhoneAttempt(claimed.id)).toMatchObject({
      status: "failed",
      retryable: true,
    });
    expect(store.latestPhoneAttempt(created.id)).toMatchObject({
      trigger: "automatic",
      status: "scheduled",
    });
    expect(store.getById(created.id)?.phoneRetry?.state).toBe("scheduled");
  });

  it("dispatches a due callback in a fresh room and counts the automatic slot", async () => {
    const call = vi.fn(async () => ({ success: true, channel: "twilio", callId: `CA-${call.mock.calls.length + 1}` }));
    let providerStatus = "no-answer";
    const telephony: TelephonyAdapter = {
      name: "twilio",
      call,
      status: async () => ({ success: true, status: providerStatus }),
      test: async () => ({ ok: true, message: "ready" }),
    };
    const createRoom = vi.fn(async (_session, options?: { roomName?: string; surface?: "browser" | "phone" }) => ({ roomName: options?.roomName ?? "browser" }));
    const config = configFor(dir);
    config.conversation.realtime.api_key = "test-openai-key";
    config.routes.default.notify = ["twilio", "secure_link"];
    const twilioService = new SessionService(
      store,
      config,
      "test-jwt-secret-with-sufficient-entropy",
      { name: "test", createRoom, endRoom: async () => undefined },
      telephony,
    );
    const created = await twilioService.create({
      ...baseInput,
      initiator: { agent_id: "svc-due-retry", harness: "vitest" },
      idempotency_key: "due-retry",
    });
    await twilioService.getTelephonyDelivery(created.id);
    const scheduled = store.latestPhoneAttempt(created.id)!;
    store.updatePhoneAttempt(scheduled.id, { scheduledAt: new Date(Date.now() - 1_000).toISOString() });
    providerStatus = "ringing";
    expect(await twilioService.processDuePhoneRetries()).toBe(1);
    expect(call).toHaveBeenCalledTimes(2);
    expect(createRoom.mock.calls[0]?.[1]?.roomName).not.toBe(createRoom.mock.calls[1]?.[1]?.roomName);
    expect(createRoom.mock.calls[0]?.[1]?.surface).toBe("phone");
    expect(createRoom.mock.calls[1]?.[1]?.surface).toBe("phone");
    expect(store.getById(created.id)?.phoneRetry).toMatchObject({
      automaticCallbacksUsed: 1,
      attemptCount: 2,
      state: "dialing",
    });
  });

  it("never schedules an automatic callback under the never policy", async () => {
    const telephony: TelephonyAdapter = {
      name: "twilio",
      call: async () => ({ success: true, channel: "twilio", callId: "CA-never" }),
      status: async () => ({ success: true, status: "no-answer" }),
      test: async () => ({ ok: true, message: "ready" }),
    };
    const config = configFor(dir);
    config.conversation.realtime.api_key = "test-openai-key";
    config.routes.default.notify = ["twilio", "secure_link"];
    config.operators.me!.alerts = { ...DEFAULT_OPERATOR_ALERTS, phone_retry_policy: "never" };
    const twilioService = new SessionService(store, config, "test-jwt-secret-with-sufficient-entropy", undefined, telephony);
    const created = await twilioService.create({
      ...baseInput,
      initiator: { agent_id: "svc-never-retry", harness: "vitest" },
      idempotency_key: "never-retry",
    });
    await twilioService.getTelephonyDelivery(created.id);
    expect(store.getById(created.id)?.status).toBe("notified");
    expect(store.getById(created.id)?.phoneRetry).toMatchObject({ policy: "never", state: "stopped" });
    expect(store.listPhoneAttempts(created.id)).toHaveLength(1);
  });

  it("cancels active phone work when the session expires", async () => {
    const cancel = vi.fn(async () => ({ success: true }));
    const closeRoom = vi.fn(async () => undefined);
    const telephony: TelephonyAdapter = {
      name: "twilio",
      call: async () => ({ success: true, channel: "twilio", callId: "CA-expiring" }),
      cancel,
      test: async () => ({ ok: true, message: "ready" }),
    };
    const config = configFor(dir);
    config.conversation.realtime.api_key = "test-openai-key";
    config.routes.default.notify = ["twilio", "secure_link"];
    const twilioService = new SessionService(
      store,
      config,
      "test-jwt-secret-with-sufficient-entropy",
      {
        name: "test",
        createRoom: async (_session, options) => ({ roomName: options?.roomName ?? "room" }),
        endRoom: closeRoom,
      },
      telephony,
    );
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const created = await twilioService.create({
      ...baseInput,
      initiator: { agent_id: "svc-expiry-phone", harness: "vitest" },
      idempotency_key: "expiry-phone",
      expires_at: expiresAt,
    });

    expect(twilioService.expireDueSessions(new Date(Date.parse(expiresAt) + 1).toISOString())).toBe(1);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("CA-expiring"));
    expect(store.getById(created.id)).toMatchObject({
      status: "expired",
      phoneRetry: { state: "stopped", automaticStopped: true },
    });
    expect(closeRoom).toHaveBeenCalledWith(expect.stringContaining(`${created.id}-call-1`));
    expect(store.latestPhoneAttempt(created.id)?.status).toBe("canceled");
  });

  it("disconnects idle LiveKit and Twilio resources without closing the decision", async () => {
    const cancel = vi.fn(async () => ({ success: true }));
    const closeRoom = vi.fn(async () => undefined);
    const telephony: TelephonyAdapter = {
      name: "twilio",
      call: async () => ({ success: true, channel: "twilio", callId: "CA-idle" }),
      cancel,
      test: async () => ({ ok: true, message: "ready" }),
    };
    const config = configFor(dir);
    config.conversation.realtime.api_key = "test-openai-key";
    config.routes.default.notify = ["twilio", "secure_link"];
    const twilioService = new SessionService(
      store,
      config,
      "test-jwt-secret-with-sufficient-entropy",
      {
        name: "test",
        createRoom: async (_session, options) => ({ roomName: options?.roomName ?? "room" }),
        endRoom: closeRoom,
      },
      telephony,
    );
    const created = await twilioService.create({
      ...baseInput,
      initiator: { agent_id: "svc-idle-phone", harness: "vitest" },
      idempotency_key: "idle-phone",
    });

    const disconnected = await twilioService.disconnectVoice(created.id, "idle_timeout");

    expect(disconnected).toMatchObject({
      id: created.id,
      status: "notified",
      phoneRetry: { state: "stopped", automaticStopped: true },
    });
    expect(cancel).toHaveBeenCalledWith("CA-idle");
    expect(closeRoom).toHaveBeenCalledWith(expect.stringContaining(`${created.id}-call-1`));
    expect(closeRoom).toHaveBeenCalledWith(created.id);
    expect(store.latestPhoneAttempt(created.id)?.status).toBe("canceled");
    expect(store.getEvents(created.id).some((event) => event.type === "session.voice_disconnected")).toBe(true);
  });

  it("does not redial when confirmation wins the call-disconnect race", async () => {
    const cancel = vi.fn(async () => ({ success: true }));
    const telephony: TelephonyAdapter = {
      name: "twilio",
      call: async () => ({ success: true, channel: "twilio", callId: "CA-confirmed" }),
      status: async () => ({ success: true, status: "completed" }),
      cancel,
      test: async () => ({ ok: true, message: "ready" }),
    };
    const config = configFor(dir);
    config.conversation.realtime.api_key = "test-openai-key";
    config.routes.default.notify = ["twilio", "secure_link"];
    const twilioService = new SessionService(
      store,
      config,
      "test-jwt-secret-with-sufficient-entropy",
      undefined,
      telephony,
    );
    const created = await twilioService.create({
      ...baseInput,
      initiator: { agent_id: "svc-confirm-race", harness: "vitest" },
      idempotency_key: "confirm-race",
    });
    const preview = twilioService.preview(created.id, { approved: true }, "Approved");
    const confirmed = twilioService.confirm(
      created.id,
      { approved: true },
      "Approved",
      "voice_agent",
      undefined,
      "confirmed-race-submission",
      preview!.revision,
    );

    expect(confirmed).toMatchObject({
      status: "completed",
      pendingDecision: undefined,
      phoneRetry: { state: "stopped", automaticStopped: true },
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("CA-confirmed"));
    expect(await twilioService.processDuePhoneRetries()).toBe(0);
    expect(store.listPhoneAttempts(created.id)).toHaveLength(1);
  });

  it("keeps the session open when phone delivery fails and a secure link exists", async () => {
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
    expect(created.phoneRetry?.state).toBe("scheduled");
  });

  it("blocks retries for permanent phone configuration failures", async () => {
    const telephony: TelephonyAdapter = {
      name: "twilio",
      call: async () => ({
        success: false,
        channel: "twilio",
        error: "The destination number is invalid",
        retryable: false,
      }),
      test: async () => ({ ok: true, message: "ready" }),
    };
    const config = configFor(dir);
    config.conversation.realtime.api_key = "test-openai-key";
    config.routes.default.notify = ["twilio", "secure_link"];
    const twilioService = new SessionService(
      store,
      config,
      "test-jwt-secret-with-sufficient-entropy",
      undefined,
      telephony,
    );
    const created = await twilioService.create({ ...baseInput, idempotency_key: "permanent-phone-failure" });
    expect(created.status).toBe("notified");
    expect(created.phoneRetry).toMatchObject({ state: "blocked", blockedReason: "The destination number is invalid" });
    expect(store.listPhoneAttempts(created.id)).toHaveLength(1);
  });

  it("persists only the latest preview and rejects stale voice submissions", async () => {
    const created = await service.create({ ...baseInput, idempotency_key: "preview-revision" });
    const first = service.preview(created.id, { approved: false }, "Not yet");
    const second = service.preview(created.id, { approved: true }, "Approved", undefined, first!.revision);

    expect(second?.revision).toBe(2);
    expect(store.getById(created.id)?.pendingDecision?.result).toEqual({ approved: true });
    expect(() => service.confirm(
      created.id,
      { approved: false },
      "Not yet",
      "voice_agent",
      undefined,
      "stale-submission",
      first!.revision,
    )).toThrow(/pending decision changed/i);
  });

  it("returns an already-completed idempotent submission and rejects conflicting reuse", async () => {
    const created = await service.create({ ...baseInput, idempotency_key: "submission-idempotency" });
    const first = service.confirm(created.id, { approved: true }, "Approved", "text_form", undefined, "submit-1");
    const duplicate = service.confirm(created.id, { approved: true }, "Approved", "text_form", undefined, "submit-1");
    expect(first?.status).toBe("completed");
    expect(duplicate?.status).toBe("completed");
    expect(() => service.confirm(created.id, { approved: false }, "Rejected", "text_form", undefined, "submit-1"))
      .toThrow(/reused/i);
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
        locale: "en",
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
        locale: "en",
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
    const snoozeInput = { ...baseInput, initiator: { agent_id: "svc-snooze", harness: "vitest" } };
    const session = await service.create({ ...snoozeInput, idempotency_key: "snooze-1" });
    expect(session.status).toBe("notified");

    const snoozed = service.snooze(session.id, 1);
    expect(snoozed?.status).toBe("snoozed");
    expect(snoozed?.snoozeUntil).toBeTruthy();

    const seen = await service.create({ ...snoozeInput, objective: "seen me", idempotency_key: "seen-1" });
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
    const session = await service.create({
      ...baseInput,
      initiator: { agent_id: "svc-snooze-bad", harness: "vitest" },
      idempotency_key: "snooze-bad",
    });
    expect(() => service.snooze(session.id, 7)).toThrow(/not allowed/);
  });
});
