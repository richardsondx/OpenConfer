import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, SessionStore } from "@openconfer/storage-sqlite";
import { generateSessionId } from "@openconfer/core";
import {
  isCallbackUrlAllowed,
  isPrivateAddress,
  isResolvedCallbackAllowed,
  runWebhookBatch,
} from "./webhook-worker.js";

describe("callback URL security", () => {
  afterEach(() => delete process.env.OPENCONFER_ALLOW_LOCAL_CALLBACKS);

  it("requires HTTPS and blocks local network destinations", () => {
    expect(isCallbackUrlAllowed("https://example.com/result")).toBe(true);
    expect(isCallbackUrlAllowed("http://example.com/result")).toBe(false);
    expect(isCallbackUrlAllowed("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isCallbackUrlAllowed("https://user:password@example.com/result")).toBe(false);
  });

  it("allows localhost only with the explicit examples opt-in", () => {
    expect(isCallbackUrlAllowed("http://localhost:9000/result")).toBe(false);
    process.env.OPENCONFER_ALLOW_LOCAL_CALLBACKS = "1";
    expect(isCallbackUrlAllowed("http://localhost:9000/result")).toBe(true);
  });

  it("treats IPv4-mapped IPv6 and IPv6 loopback/link-local as private", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.5")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("fd12::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("rejects DNS that resolves to a private IP", async () => {
    expect(await isResolvedCallbackAllowed("https://127.0.0.1/result")).toBe(false);
    expect(await isResolvedCallbackAllowed("https://[::1]/result")).toBe(false);
  });
});

describe("webhook delivery security", () => {
  let dir: string;
  let store: SessionStore;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setupStore() {
    dir = mkdtempSync(join(tmpdir(), "openconfer-webhook-"));
    store = new SessionStore(createDatabase(join(dir, "test.db")));
    const now = new Date().toISOString();
    const sessionId = generateSessionId();
    store.insert({
      id: sessionId,
      type: "decision",
      locale: "en",
      status: "completed",
      initiator: { agentId: "a", harness: "h" },
      participant: { operatorId: "me" },
      objective: "Test",
      brief: { reason: "Test" },
      resultSchema: {},
      routing: { policy: "default" },
      createdAt: now,
      updatedAt: now,
    });
    return sessionId;
  }

  it("rejects redirect responses instead of following them", async () => {
    const sessionId = setupStore();
    store.enqueueWebhook(
      "wh_redirect",
      sessionId,
      "https://example.com/result",
      { ok: true },
      "signature",
      "evt_redirect",
      new Date().toISOString(),
    );
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://evil.test" } }));
    await runWebhookBatch(store, fetchMock as typeof fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/result",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(store.getById(sessionId)?.status).toBe("completed");
    expect(store.claimPendingWebhooks(10, 8, 0)).toHaveLength(0);
  });

  it("stops claiming webhooks after the maximum retry attempts (dead-letter)", () => {
    const sessionId = setupStore();
    store.enqueueWebhook(
      "wh_dead",
      sessionId,
      "https://example.com/result",
      { ok: true },
      "signature",
      "evt_dead",
      new Date().toISOString(),
    );
    for (let i = 0; i < 8; i++) {
      const claimed = store.claimPendingWebhooks(10, 8, 0);
      expect(claimed).toHaveLength(1);
      store.markWebhookFailed(claimed[0]!.id, "HTTP 500", new Date(Date.now() - 1).toISOString());
    }
    expect(store.claimPendingWebhooks(10, 8, 0)).toHaveLength(0);
  });
});
