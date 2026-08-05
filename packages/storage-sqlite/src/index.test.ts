import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
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
    expect(store.getById(item.id)?.capturedContext).toEqual({
      steering: [],
      additional_instructions: [],
      new_requests: [],
      unresolved_topics: [],
    });
  });

  it("migrates preview, retry, and attempt storage into an existing database", () => {
    const legacyPath = join(dir, "legacy.db");
    const legacy = new Database(legacyPath);
    legacy.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en',
      status TEXT NOT NULL, initiator_json TEXT NOT NULL, participant_json TEXT NOT NULL,
      objective TEXT NOT NULL, brief_json TEXT NOT NULL, result_schema_json TEXT NOT NULL,
      routing_json TEXT NOT NULL, continuation_json TEXT, callback_json TEXT,
      urgency TEXT DEFAULT 'normal', estimated_duration_minutes INTEGER, expires_at TEXT,
      snooze_until TEXT, operator_seen_at TEXT, join_token TEXT, join_url TEXT,
      result_json TEXT, summary TEXT, human_confirmation_json TEXT, idempotency_key TEXT,
      request_fingerprint TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    legacy.close();

    createDatabase(legacyPath);
    const inspected = new Database(legacyPath, { readonly: true });
    const columns = inspected.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
    }>;
    const tables = inspected
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    inspected.close();
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "captured_context_json",
        "pending_decision_json",
        "phone_retry_json",
      ]),
    );
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(["phone_attempts", "decision_submissions"]),
    );
  });

  it("persists and atomically claims durable phone attempts", () => {
    const item = session("notified");
    item.pendingDecision = {
      result: { approved: true },
      summary: "Approve",
      capturedContext: {
        steering: [],
        additional_instructions: [],
        new_requests: [],
        unresolved_topics: [],
      },
      revision: 2,
      previewedAt: "2026-01-01T00:00:00.000Z",
    };
    item.phoneRetry = {
      policy: "brief",
      state: "scheduled",
      attemptCount: 1,
      automaticCallbacksUsed: 0,
      automaticStopped: false,
      nextRetryAt: "2026-01-01T00:01:00.000Z",
    };
    store.insert(item);
    const attempt = store.createPhoneAttempt({
      id: "call_1",
      sessionId: item.id,
      operatorId: "me",
      trigger: "automatic",
      status: "scheduled",
      scheduledAt: "2026-01-01T00:01:00.000Z",
      consumesAutomaticSlot: true,
    });

    expect(store.getById(item.id)).toMatchObject({
      pendingDecision: { revision: 2 },
      phoneRetry: { policy: "brief", state: "scheduled" },
    });
    expect(attempt.sequence).toBe(1);
    expect(store.claimPhoneAttempt(attempt.id)?.status).toBe("dialing");
    expect(store.claimPhoneAttempt(attempt.id)).toBeNull();
    expect(store.hasActivePhoneAttempt("me")).toBe(true);
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
    item.pendingDecision = {
      result: { approved: true },
      revision: 1,
      previewedAt: new Date().toISOString(),
    };
    item.phoneRetry = {
      policy: "brief",
      state: "dialing",
      attemptCount: 1,
      automaticCallbacksUsed: 0,
      automaticStopped: false,
    };
    store.insert(item);
    store.completeSession(
      item.id,
      {
        result: { approved: true },
        summary: "Approved",
        capturedContext: {
          steering: ["Require passkeys"],
          additional_instructions: ["Document the rollout"],
          new_requests: ["Review mobile auth next"],
          unresolved_topics: ["Legacy account recovery"],
        },
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
      { id: "submission_1", payloadFingerprint: "fingerprint_1" },
    );
    expect(store.getById(item.id)).toMatchObject({
      status: "completed",
      pendingDecision: undefined,
      phoneRetry: { state: "stopped", automaticStopped: true },
      capturedContext: {
        steering: ["Require passkeys"],
        additional_instructions: ["Document the rollout"],
        new_requests: ["Review mobile auth next"],
        unresolved_topics: ["Legacy account recovery"],
      },
    });
    expect(
      store.getEvents(item.id).find((event) => event.type === "session.result_ready")?.payload,
    ).toMatchObject({ captured_context: { steering: ["Require passkeys"] } });
    const claimed = store.claimPendingWebhooks();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ eventId: "evt_1", signature: "signed" });
    expect(store.claimPendingWebhooks()).toHaveLength(0);
    expect(store.getDecisionSubmission("submission_1")).toEqual({
      sessionId: item.id,
      payloadFingerprint: "fingerprint_1",
    });
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
