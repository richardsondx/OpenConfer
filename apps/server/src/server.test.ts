import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./index.js";
import { runWebhookBatch } from "./webhook-worker.js";
import { verifyWebhookSignature, webhookSignatureInput } from "@openconfer/auth-local";
import type { SessionStore } from "@openconfer/storage-sqlite";

const createBody = {
  type: "decision",
  initiator: { agent_id: "api-test", harness: "vitest" },
  participant: { operator_id: "me" },
  objective: "Approve deployment",
  brief: { reason: "Deployment is waiting" },
  result_schema: {
    type: "object",
    required: ["approved"],
    additionalProperties: false,
    properties: { approved: { type: "boolean" } },
  },
};

function joinToken(joinUrl: string): string {
  return new URLSearchParams(new URL(joinUrl).hash.slice(1)).get("token")!;
}

describe.sequential("server API", () => {
  let dir: string;
  let app: FastifyInstance;
  let store: SessionStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "openconfer-server-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      configPath,
      `server:\n  base_url: http://localhost:8787\n  port: 8787\n  host: 127.0.0.1\nstorage:\n  adapter: sqlite\n  path: ${join(dir, "test.db")}\nconversation:\n  adapter: livekit\n  model: test\n  voice: test\noperators:\n  me:\n    timezone: UTC\nauth:\n  api_token: test-api-token\n`,
    );
    process.env.OPENCONFER_CONFIG = configPath;
    process.env.OPENCONFER_JWT_SECRET = "test-jwt-secret-with-sufficient-entropy";
    delete process.env.OPENAI_API_KEY;
    ({ app, store } = await buildServer());
  });

  afterEach(async () => {
    await app.close();
    delete process.env.OPENCONFER_CONFIG;
    delete process.env.OPENCONFER_JWT_SECRET;
    delete process.env.OPENAI_API_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates idempotently and separates join API from the SPA path", async () => {
    const headers = { authorization: "Bearer test-api-token", "idempotency-key": "request-1" };
    const first = await app.inject({ method: "POST", url: "/v1/sessions", headers, payload: createBody });
    const second = await app.inject({ method: "POST", url: "/v1/sessions", headers, payload: createBody });
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: { ...createBody, objective: "Different payload" },
    });
    expect(conflict.statusCode).toBe(409);

    const token = joinToken(first.json().join_url);
    const id = first.json().id as string;
    expect((await app.inject({ method: "GET", url: `/join/${id}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/v1/join/${id}`, headers: { "x-join-token": token } })).statusCode).toBe(200);

    const connected = await app.inject({
      method: "POST",
      url: `/v1/join/${id}/connect`,
      payload: { token },
    });
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({
      session: { status: "joining" },
      room: { room_name: expect.stringContaining(id), url: "mock://local" },
    });
    expect(connected.json().room.token).toBeTruthy();
    const active = await app.inject({
      method: "POST",
      url: `/v1/join/${id}/active`,
      payload: { token },
    });
    expect(active.statusCode).toBe(200);
    expect(active.json().session.status).toBe("active");

    const confirmed = await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/confirm`,
      headers: { "x-join-token": token },
      payload: {
        result: { approved: true },
        captured_context: {
          steering: ["Require passkeys"],
          additional_instructions: ["Update the runbook"],
          new_requests: ["Audit mobile login next"],
          unresolved_topics: ["Recovery codes"],
        },
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().captured_context).toEqual({
      steering: ["Require passkeys"],
      additional_instructions: ["Update the runbook"],
      new_requests: ["Audit mobile login next"],
      unresolved_topics: ["Recovery codes"],
    });
    const saved = await app.inject({
      method: "GET",
      url: `/v1/sessions/${id}`,
      headers: { authorization: "Bearer test-api-token" },
    });
    expect(saved.json().captured_context.steering).toEqual(["Require passkeys"]);
    const eventResponse = await app.inject({
      method: "GET",
      url: `/v1/sessions/${id}/events`,
      headers: { authorization: "Bearer test-api-token" },
    });
    expect(
      eventResponse
        .json()
        .events.find((event: { type: string }) => event.type === "session.result_ready").payload
        .captured_context.steering,
    ).toEqual(["Require passkeys"]);
    expect((await app.inject({ method: "GET", url: `/v1/join/${id}`, headers: { "x-join-token": token } })).json().session.status).toBe("completed");
    expect(
      (await app.inject({ method: "POST", url: `/v1/join/${id}/connect`, payload: { token } }))
        .statusCode,
    ).toBe(404);
  });

  it("protects previews and makes voice confirmation revision-safe and idempotent", async () => {
    const headers = { authorization: "Bearer test-api-token" };
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        ...createBody,
        initiator: { agent_id: "api-preview-test", harness: "vitest" },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().phone_retry).toMatchObject({
      policy: "brief",
      max_automatic_callbacks: 2,
    });
    const id = created.json().id as string;

    const unauthorized = await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/preview`,
      payload: { result: { approved: true } },
    });
    expect(unauthorized.statusCode).toBe(401);

    const preview = await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/preview`,
      headers,
      payload: {
        result: { approved: true },
        summary: "Approve the deployment",
        expected_revision: 0,
      },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ revision: 1, result: { approved: true } });
    const replacement = await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/preview`,
      headers,
      payload: {
        result: { approved: true },
        summary: "Approve the deployment",
        expected_revision: 1,
      },
    });
    expect(replacement.statusCode, replacement.body).toBe(200);
    expect(replacement.json().revision).toBe(2);

    const stale = await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/confirm`,
      headers,
      payload: {
        result: { approved: true },
        summary: "Approve the deployment",
        method: "voice_agent",
        submission_id: "voice-submission-1",
        preview_revision: 1,
      },
    });
    expect(stale.statusCode).toBe(409);

    const payload = {
      result: { approved: true },
      summary: "Approve the deployment",
      method: "voice_agent",
      submission_id: "voice-submission-1",
      preview_revision: 2,
    };
    const confirmed = await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/confirm`,
      headers,
      payload,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: "completed", result: { approved: true } });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/sessions/${id}/confirm`,
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(200);

    const conflicting = await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/confirm`,
      headers,
      payload: { ...payload, result: { approved: false } },
    });
    expect(conflicting.statusCode).toBe(409);
    const saved = await app.inject({ method: "GET", url: `/v1/sessions/${id}`, headers });
    expect(saved.json().pending_decision).toBeUndefined();
    expect(saved.json().phone_retry.state).toBe("stopped");
  });

  it("requires a signing secret for callbacks", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: "Bearer test-api-token" },
      payload: { ...createBody, callback: { url: "https://example.com/result" } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("require");
  });

  it("rejects private callback destinations before persistence", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: "Bearer test-api-token" },
      payload: {
        ...createBody,
        callback: { url: "https://169.254.169.254/result", secret: "callback-secret-long-enough" },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("not allowed");
  });

  it("delivers callbacks with timestamp and event-bound signatures", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: "Bearer test-api-token" },
      payload: {
        ...createBody,
        callback: { url: "https://example.com/result", secret: "callback-secret-long-enough" },
      },
    });
    const body = created.json();
    const token = joinToken(body.join_url);
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${body.id}/confirm`,
      headers: { "x-join-token": token },
      payload: {
        result: { approved: true },
        captured_context: { additional_instructions: ["Notify support"] },
        method: "text_form",
      },
    });

    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 204 }));
    await runWebhookBatch(store, fetchMock as typeof fetch);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(JSON.parse(init?.body as string).captured_context).toEqual({
      steering: [],
      additional_instructions: ["Notify support"],
      new_requests: [],
      unresolved_topics: [],
    });
    expect(headers["X-OpenConfer-Event-Id"]).toMatch(/^evt_/);
    expect(headers["X-OpenConfer-Timestamp"]).toBeTruthy();
    expect(
      verifyWebhookSignature(
        webhookSignatureInput(
          headers["X-OpenConfer-Timestamp"]!,
          headers["X-OpenConfer-Event-Id"]!,
          init?.body as string,
        ),
        headers["X-OpenConfer-Signature"]!,
        "callback-secret-long-enough",
      ),
    ).toBe(true);
    expect(store.getById(body.id)?.status).toBe("result_delivered");
  });

  it("expires join access on request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: "Bearer test-api-token" },
      payload: { ...createBody, expires_at: new Date(Date.now() + 1_000).toISOString() },
    });
    const body = response.json();
    const token = joinToken(body.join_url);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const join = await app.inject({ method: "GET", url: `/v1/join/${body.id}`, headers: { "x-join-token": token } });
    expect(join.statusCode).toBe(200);
    expect(join.json().session.status).toBe("expired");
  });

  it("allows snooze with join token only (no API bearer)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: "Bearer test-api-token" },
      payload: createBody,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const token = joinToken(created.json().join_url);
    expect(store.getById(id)?.status).toBe("notified");

    const unauthorized = await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/snooze`,
      payload: { minutes: 3 },
    });
    expect(unauthorized.statusCode).toBe(401);

    const snoozed = await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/snooze`,
      headers: { "x-join-token": token },
      payload: { minutes: 3 },
    });
    expect(snoozed.statusCode, snoozed.body).toBe(200);
    expect(snoozed.json().status).toBe("snoozed");
    expect(snoozed.json().snooze_until).toBeTruthy();
  });

  it("reads and patches settings into config.yaml", async () => {
    const headers = { authorization: "Bearer test-api-token" };
    const before = await app.inject({ method: "GET", url: "/v1/settings", headers });
    expect(before.statusCode).toBe(200);
    expect(before.json().auth.api_token_configured).toBe(true);
    expect(before.json().status.livekit).toBe("not_configured");
    expect(before.json().status.openai_worker).toBe("missing_key");
    expect(before.json().status.voice_ready).toBe(false);

    const patched = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      headers,
      payload: {
        routes: { default: { notify: ["secure_link", "twilio"] } },
        telephony: {
          adapter: "twilio",
          twilio: {
            account_sid: "AC0123456789abcdef0123456789abcdef",
            auth_token: "twilio-test-secret",
            from_number: "+14165550100",
            destination_number: "+14165550101",
          },
        },
        conversation: {
          livekit_url: "ws://127.0.0.1:7880",
          livekit_api_key: "devkey",
          livekit_api_secret: "secret",
          openai_api_key: "sk-test-key",
          model: "gpt-realtime",
          voice: "marin",
        },
        server: { web_url: "http://127.0.0.1:5173" },
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().routes.default.notify).toEqual(["secure_link", "twilio"]);
    expect(patched.json().conversation.livekit_api_key_configured).toBe(true);
    expect(patched.json().conversation.openai_api_key_configured).toBe(true);
    // Credentials alone are not "ready" — LiveKit must answer on the URL.
    expect(["ready", "unreachable"]).toContain(patched.json().status.livekit);
    expect(patched.json().status.openai_worker).toBe("ready");
    expect(patched.json().status.restart_required).toBe(true);
    expect(patched.json().conversation.livekit_api_key).toBeUndefined();
    expect(patched.json().conversation.openai_api_key).toBeUndefined();
    expect(patched.json().telephony.twilio.account_sid_configured).toBe(true);
    expect(patched.json().telephony.twilio.auth_token_configured).toBe(true);
    expect(patched.json().telephony.twilio.account_sid).toBeUndefined();
    expect(patched.json().telephony.twilio.auth_token).toBeUndefined();
    expect(["ready", "needs_livekit_voice"]).toContain(patched.json().status.twilio);

    const revealed = await app.inject({
      method: "POST",
      url: "/v1/settings/secrets/reveal",
      headers,
      payload: { name: "twilio_auth_token" },
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.headers["cache-control"]).toBe("no-store");
    expect(revealed.json()).toEqual({ value: "twilio-test-secret" });

    const { readFileSync } = await import("node:fs");
    const yaml = readFileSync(process.env.OPENCONFER_CONFIG!, "utf8");
    expect(yaml).toContain("twilio-test-secret");
    expect(yaml).toContain("livekit_api_key: devkey");
    expect(yaml).toContain("openai_api_key: sk-test-key");
    expect(yaml).toContain("model: gpt-realtime-2.1");
  });

  it("rotates the API token and blocks demos until voice is ready", async () => {
    const rotated = await app.inject({
      method: "POST",
      url: "/v1/settings/token/rotate",
      headers: { authorization: "Bearer test-api-token" },
    });
    expect(rotated.statusCode).toBe(200);
    const nextToken = rotated.json().api_token as string;
    expect(nextToken).toMatch(/^oc_/);

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/settings",
          headers: { authorization: "Bearer test-api-token" },
        })
      ).statusCode,
    ).toBe(401);

    const blocked = await app.inject({
      method: "POST",
      url: "/v1/sessions/demo",
      headers: { authorization: `Bearer ${nextToken}` },
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json().error).toMatch(/livekit|openai/i);
  });

  it("creates a pizza-or-tacos demo when voice is ready", async () => {
    process.env.OPENAI_API_KEY = "sk-test-demo";
    await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      headers: { authorization: "Bearer test-api-token" },
      payload: {
        conversation: {
          livekit_url: "ws://127.0.0.1:7880",
          livekit_api_key: "devkey",
          livekit_api_secret: "secret",
        },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));

    const demo = await app.inject({
      method: "POST",
      url: "/v1/sessions/demo",
      headers: { authorization: "Bearer test-api-token" },
    });
    expect(demo.statusCode, demo.body).toBe(201);
    expect(demo.json().join_url).toContain("/join/");
    expect(demo.json().objective).toMatch(/pizza or tacos/i);

    const token = joinToken(demo.json().join_url);
    const join = await app.inject({
      method: "GET",
      url: `/v1/join/${demo.json().id}`,
      headers: { "x-join-token": token },
    });
    expect(join.statusCode).toBe(200);
    expect(join.json().session.has_callback).toBe(false);
    expect(join.json().session.objective).toMatch(/pizza or tacos/i);

    const standup = await app.inject({
      method: "POST",
      url: "/v1/sessions/demo",
      headers: { authorization: "Bearer test-api-token" },
      payload: { use_case: "standup" },
    });
    expect(standup.statusCode, standup.body).toBe(201);
    expect(standup.json().objective).toMatch(/today's standup/i);

    const approval = await app.inject({
      method: "POST",
      url: "/v1/sessions/demo",
      headers: { authorization: "Bearer test-api-token" },
      payload: { use_case: "approval" },
    });
    expect(approval.statusCode, approval.body).toBe(201);
    expect(approval.json().objective).toMatch(/approve the proposed production deploy/i);

    vi.unstubAllGlobals();
  });
});
