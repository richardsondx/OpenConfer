import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, SessionStore } from "./index.js";
import { generateSessionId } from "@openconfer/core";
import type { ConferSession } from "@openconfer/core";

function session(status: ConferSession["status"] = "created", expiresAt?: string): ConferSession {
  const now = new Date().toISOString();
  return {
    id: generateSessionId(),
    type: "decision",
    locale: "en",
    status,
    initiator: { agentId: "a", harness: "h" },
    participant: { operatorId: "me" },
    objective: "Test",
    brief: { reason: "Test reason" },
    resultSchema: {},
    routing: { policy: "default" },
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };
}

describe("SessionStore", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oc-test-"));
    const db = createDatabase(join(dir, "test.db"));
    store = new SessionStore(db);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("inserts and retrieves sessions", () => {
    const item = session();
    store.insert(item);
    expect(store.getById(item.id)?.objective).toBe("Test");
    expect(store.getById(item.id)?.locale).toBe("en");
  });

  it("persists unique idempotency keys and request fingerprints", () => {
    const first = session();
    store.insert(first, "create-1", "fingerprint-a");
    expect(store.getByIdempotencyKey("create-1")?.id).toBe(first.id);
    expect(store.getIdempotencyRecord("create-1")).toEqual({
      session: expect.objectContaining({ id: first.id }),
      fingerprint: "fingerprint-a",
    });
    expect(() => store.insert(session(), "create-1", "fingerprint-b")).toThrow();
  });

  it("uses compare-and-swap for status transitions", () => {
    const item = session();
    store.insert(item);
    store.updateStatus(item.id, "created", "policy_check");
    expect(() => store.updateStatus(item.id, "created", "policy_check")).toThrow(
      "expected state created",
    );
  });

  it("claims a channel delivery only once and stores its provider result", () => {
    const item = session();
    store.insert(item);
    expect(store.claimChannelDelivery(item.id, "twilio")).toBe(true);
    expect(store.claimChannelDelivery(item.id, "twilio")).toBe(false);
    store.completeChannelDelivery(item.id, "twilio", {
      success: true,
      externalId: "CA123",
    });
    expect(store.getChannelDelivery(item.id, "twilio")).toEqual({
      status: "succeeded",
      externalId: "CA123",
      error: undefined,
    });
  });

  it("expires due sessions with their event atomically", () => {
    const item = session("notified", "2020-01-01T00:00:00.000Z");
    store.insert(item);
    expect(store.expireDue()).toBe(1);
    expect(store.getById(item.id)?.status).toBe("expired");
    expect(store.getEvents(item.id).map((event) => event.type)).toContain("session.expired");
  });

  it("atomically completes a result and signed outbox record", () => {
    const item = session("confirming");
    store.insert(item);
    store.completeSession(
      item.id,
      {
        result: { approved: true },
        summary: "Approved",
        humanConfirmation: { confirmedAt: new Date().toISOString(), method: "session_ui" },
      },
      {
        id: "wh_1",
        url: "https://example.com/callback",
        payload: { approved: true },
        signature: "signed",
        eventId: "evt_1",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(store.getById(item.id)?.status).toBe("completed");
    const claimed = store.claimPendingWebhooks();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ eventId: "evt_1", signature: "signed" });
    expect(store.claimPendingWebhooks()).toHaveLength(0);
  });

  it("rolls back result writes when completion CAS fails", () => {
    const item = session("active");
    store.insert(item);
    expect(() =>
      store.completeSession(item.id, {
        result: { approved: true },
        summary: "Should roll back",
        humanConfirmation: { confirmedAt: new Date().toISOString(), method: "session_ui" },
      }),
    ).toThrow("expected state confirming");
    expect(store.getById(item.id)?.result).toBeUndefined();
  });
});
