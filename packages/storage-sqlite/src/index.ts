import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import {
  type ConferSession,
  type SessionEvent,
  type SessionState,
  type SessionType,
  emptyCapturedContext,
  generateEventId,
  assertTransition,
} from "@openconfer/core";
import * as schema from "./schema.js";
import {
  sessions,
  events,
  webhookOutbox,
  acknowledgements,
  channelDeliveries,
  phoneAttempts,
  decisionSubmissions,
} from "./schema.js";

export type PhoneAttemptTrigger = "initial" | "automatic" | "manual";
export type PhoneAttemptStatus =
  | "scheduled"
  | "dialing"
  | "queued"
  | "ringing"
  | "in-progress"
  | "completed"
  | "busy"
  | "failed"
  | "no-answer"
  | "canceled"
  | "machine"
  | "superseded";

export type PhoneAttempt = {
  id: string;
  sessionId: string;
  operatorId: string;
  sequence: number;
  trigger: PhoneAttemptTrigger;
  status: PhoneAttemptStatus;
  providerCallId?: string;
  roomName?: string;
  consumesAutomaticSlot: boolean;
  retryable?: boolean;
  error?: string;
  scheduledAt?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type Db = BetterSQLite3Database<typeof schema>;

export function createDatabase(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  migrate(sqlite);
  const db = drizzle(sqlite, { schema });
  return db;
}

function migrate(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      locale TEXT NOT NULL DEFAULT 'en',
      status TEXT NOT NULL,
      initiator_json TEXT NOT NULL,
      participant_json TEXT NOT NULL,
      objective TEXT NOT NULL,
      brief_json TEXT NOT NULL,
      result_schema_json TEXT NOT NULL,
      routing_json TEXT NOT NULL,
      continuation_json TEXT,
      callback_json TEXT,
      continuity_json TEXT,
      continuity_trace_json TEXT,
      continuity_capsule_json TEXT,
      urgency TEXT DEFAULT 'normal',
      estimated_duration_minutes INTEGER,
      expires_at TEXT,
      join_token TEXT,
      join_url TEXT,
      result_json TEXT,
      summary TEXT,
      captured_context_json TEXT,
      pending_decision_json TEXT,
      phone_retry_json TEXT,
      human_confirmation_json TEXT,
      idempotency_key TEXT,
      request_fingerprint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS webhook_outbox (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      url TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      signature TEXT,
      event_id TEXT,
      timestamp TEXT,
      attempts INTEGER DEFAULT 0,
      next_attempt_at TEXT,
      delivered_at TEXT,
      last_error TEXT,
      claimed_at TEXT,
      created_at TEXT NOT NULL
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS acknowledgements (
      session_id TEXT PRIMARY KEY,
      run_id TEXT,
      acknowledged_at TEXT NOT NULL
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS channel_deliveries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      external_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS phone_attempts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_call_id TEXT,
      room_name TEXT,
      consumes_automatic_slot INTEGER NOT NULL DEFAULT 0,
      retryable INTEGER,
      error TEXT,
      scheduled_at TEXT,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS decision_submissions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      payload_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_idempotency ON sessions(idempotency_key) WHERE idempotency_key IS NOT NULL`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_phone_attempts_session ON phone_attempts(session_id, sequence)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_phone_attempts_due ON phone_attempts(status, scheduled_at)`);
  const outboxColumns = new Set(
    (sqlite.prepare("PRAGMA table_info(webhook_outbox)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!outboxColumns.has("event_id")) sqlite.exec("ALTER TABLE webhook_outbox ADD COLUMN event_id TEXT");
  if (!outboxColumns.has("timestamp")) sqlite.exec("ALTER TABLE webhook_outbox ADD COLUMN timestamp TEXT");
  if (!outboxColumns.has("claimed_at")) sqlite.exec("ALTER TABLE webhook_outbox ADD COLUMN claimed_at TEXT");
  const sessionColumns = new Set(
    (sqlite.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!sessionColumns.has("request_fingerprint")) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN request_fingerprint TEXT");
  }
  if (!sessionColumns.has("snooze_until")) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN snooze_until TEXT");
  }
  if (!sessionColumns.has("operator_seen_at")) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN operator_seen_at TEXT");
  }
  if (!sessionColumns.has("locale")) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN locale TEXT NOT NULL DEFAULT 'en'");
  }
  if (!sessionColumns.has("captured_context_json")) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN captured_context_json TEXT");
  }
  if (!sessionColumns.has("pending_decision_json")) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN pending_decision_json TEXT");
  }
  if (!sessionColumns.has("phone_retry_json")) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN phone_retry_json TEXT");
  }
  if (!sessionColumns.has("continuity_json")) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN continuity_json TEXT");
  }
  if (!sessionColumns.has("continuity_trace_json")) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN continuity_trace_json TEXT");
  }
  if (!sessionColumns.has("continuity_capsule_json")) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN continuity_capsule_json TEXT");
  }
}

function rowToSession(row: typeof sessions.$inferSelect): ConferSession {
  return {
    id: row.id,
    type: row.type as SessionType,
    locale: row.locale || "en",
    status: row.status as SessionState,
    initiator: JSON.parse(row.initiatorJson),
    participant: JSON.parse(row.participantJson),
    objective: row.objective,
    brief: JSON.parse(row.briefJson),
    resultSchema: JSON.parse(row.resultSchemaJson),
    routing: JSON.parse(row.routingJson),
    continuation: row.continuationJson ? JSON.parse(row.continuationJson) : undefined,
    callback: row.callbackJson ? JSON.parse(row.callbackJson) : undefined,
    continuity: row.continuityJson ? JSON.parse(row.continuityJson) : undefined,
    continuityTrace: row.continuityTraceJson ? JSON.parse(row.continuityTraceJson) : undefined,
    continuityCapsule: row.continuityCapsuleJson
      ? JSON.parse(row.continuityCapsuleJson)
      : undefined,
    urgency: (row.urgency as ConferSession["urgency"]) ?? "normal",
    estimatedDurationMinutes: row.estimatedDurationMinutes ?? undefined,
    expiresAt: row.expiresAt ?? undefined,
    snoozeUntil: row.snoozeUntil ?? undefined,
    operatorSeenAt: row.operatorSeenAt ?? undefined,
    joinToken: row.joinToken ?? undefined,
    joinUrl: row.joinUrl ?? undefined,
    result: row.resultJson ? JSON.parse(row.resultJson) : undefined,
    summary: row.summary ?? undefined,
    capturedContext: row.capturedContextJson
      ? JSON.parse(row.capturedContextJson)
      : emptyCapturedContext(),
    pendingDecision: row.pendingDecisionJson ? JSON.parse(row.pendingDecisionJson) : undefined,
    phoneRetry: row.phoneRetryJson ? JSON.parse(row.phoneRetryJson) : undefined,
    humanConfirmation: row.humanConfirmationJson
      ? JSON.parse(row.humanConfirmationJson)
      : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToPhoneAttempt(row: typeof phoneAttempts.$inferSelect): PhoneAttempt {
  return {
    id: row.id,
    sessionId: row.sessionId,
    operatorId: row.operatorId,
    sequence: row.sequence,
    trigger: row.trigger as PhoneAttemptTrigger,
    status: row.status as PhoneAttemptStatus,
    providerCallId: row.providerCallId ?? undefined,
    roomName: row.roomName ?? undefined,
    consumesAutomaticSlot: row.consumesAutomaticSlot,
    retryable: row.retryable ?? undefined,
    error: row.error ?? undefined,
    scheduledAt: row.scheduledAt ?? undefined,
    startedAt: row.startedAt ?? undefined,
    endedAt: row.endedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SessionStore {
  constructor(private db: Db) {}

  insert(session: ConferSession, idempotencyKey?: string, requestFingerprint?: string): ConferSession {
    this.db.insert(sessions).values({
      id: session.id,
      type: session.type,
      locale: session.locale,
      status: session.status,
      initiatorJson: JSON.stringify(session.initiator),
      participantJson: JSON.stringify(session.participant),
      objective: session.objective,
      briefJson: JSON.stringify(session.brief),
      resultSchemaJson: JSON.stringify(session.resultSchema),
      routingJson: JSON.stringify(session.routing),
      continuationJson: session.continuation ? JSON.stringify(session.continuation) : null,
      callbackJson: session.callback ? JSON.stringify(session.callback) : null,
      continuityJson: session.continuity ? JSON.stringify(session.continuity) : null,
      continuityTraceJson: session.continuityTrace ? JSON.stringify(session.continuityTrace) : null,
      continuityCapsuleJson: session.continuityCapsule
        ? JSON.stringify(session.continuityCapsule)
        : null,
      urgency: session.urgency ?? "normal",
      estimatedDurationMinutes: session.estimatedDurationMinutes ?? null,
      expiresAt: session.expiresAt ?? null,
      snoozeUntil: session.snoozeUntil ?? null,
      operatorSeenAt: session.operatorSeenAt ?? null,
      joinToken: session.joinToken ?? null,
      joinUrl: session.joinUrl ?? null,
      resultJson: session.result ? JSON.stringify(session.result) : null,
      summary: session.summary ?? null,
      capturedContextJson: session.capturedContext
        ? JSON.stringify(session.capturedContext)
        : null,
      pendingDecisionJson: session.pendingDecision ? JSON.stringify(session.pendingDecision) : null,
      phoneRetryJson: session.phoneRetry ? JSON.stringify(session.phoneRetry) : null,
      humanConfirmationJson: session.humanConfirmation
        ? JSON.stringify(session.humanConfirmation)
        : null,
      idempotencyKey: idempotencyKey ?? null,
      requestFingerprint: requestFingerprint ?? null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }).run();
    return session;
  }

  insertWithEvent(
    session: ConferSession,
    idempotencyKey: string | undefined,
    eventType: string,
    payload: Record<string, unknown>,
    requestFingerprint?: string,
  ): ConferSession {
    return this.transaction(() => {
      const inserted = this.insert(session, idempotencyKey, requestFingerprint);
      this.addEvent(session.id, eventType, payload);
      return inserted;
    });
  }

  getById(id: string): ConferSession | null {
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    return row ? rowToSession(row) : null;
  }

  getByIdempotencyKey(key: string): ConferSession | null {
    const row = this.db.select().from(sessions).where(eq(sessions.idempotencyKey, key)).get();
    return row ? rowToSession(row) : null;
  }

  getIdempotencyRecord(key: string): { session: ConferSession; fingerprint: string | null } | null {
    const row = this.db.select().from(sessions).where(eq(sessions.idempotencyKey, key)).get();
    if (!row) return null;
    return { session: rowToSession(row), fingerprint: row.requestFingerprint ?? null };
  }

  list(limit = 50): ConferSession[] {
    const rows = this.db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.createdAt))
      .limit(limit)
      .all();
    return rows.map(rowToSession);
  }

  listDueExpirations(now = new Date().toISOString()): ConferSession[] {
    const expirable: SessionState[] = [
      "created",
      "policy_check",
      "queued",
      "scheduled",
      "dispatching",
      "notified",
      "snoozed",
      "joining",
      "active",
      "confirming",
    ];
    return this.db
      .select()
      .from(sessions)
      .where(and(lte(sessions.expiresAt, now), inArray(sessions.status, expirable)))
      .all()
      .map(rowToSession);
  }

  updateStatus(id: string, from: SessionState, to: SessionState): ConferSession {
    assertTransition(from, to);
    const now = new Date().toISOString();
    const result = this.db
      .update(sessions)
      .set({ status: to, updatedAt: now })
      .where(and(eq(sessions.id, id), eq(sessions.status, from)))
      .run();
    if (result.changes !== 1) {
      throw new Error(`Session ${id} is not in expected state ${from}`);
    }
    const session = this.getById(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }

  transitionWithEvent(
    id: string,
    from: SessionState,
    to: SessionState,
    eventType: string,
    payload: Record<string, unknown>,
  ): ConferSession {
    return this.transaction(() => {
      const session = this.updateStatus(id, from, to);
      this.addEvent(id, eventType, payload);
      return session;
    });
  }

  update(id: string, patch: Partial<ConferSession>): ConferSession {
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updatedAt: now };
    if (patch.joinToken) updates.joinToken = patch.joinToken;
    if (patch.joinUrl) updates.joinUrl = patch.joinUrl;
    if (patch.result) updates.resultJson = JSON.stringify(patch.result);
    if (patch.summary) updates.summary = patch.summary;
    if ("capturedContext" in patch) {
      updates.capturedContextJson = JSON.stringify(patch.capturedContext ?? emptyCapturedContext());
    }
    if ("pendingDecision" in patch) {
      updates.pendingDecisionJson = patch.pendingDecision
        ? JSON.stringify(patch.pendingDecision)
        : null;
    }
    if ("phoneRetry" in patch) {
      updates.phoneRetryJson = patch.phoneRetry ? JSON.stringify(patch.phoneRetry) : null;
    }
    if ("continuity" in patch) {
      updates.continuityJson = patch.continuity ? JSON.stringify(patch.continuity) : null;
    }
    if ("continuityTrace" in patch) {
      updates.continuityTraceJson = patch.continuityTrace
        ? JSON.stringify(patch.continuityTrace)
        : null;
    }
    if ("continuityCapsule" in patch) {
      updates.continuityCapsuleJson = patch.continuityCapsule
        ? JSON.stringify(patch.continuityCapsule)
        : null;
    }
    if (patch.humanConfirmation)
      updates.humanConfirmationJson = JSON.stringify(patch.humanConfirmation);
    if ("snoozeUntil" in patch) updates.snoozeUntil = patch.snoozeUntil ?? null;
    if ("operatorSeenAt" in patch) updates.operatorSeenAt = patch.operatorSeenAt ?? null;
    this.db.update(sessions).set(updates).where(eq(sessions.id, id)).run();
    const session = this.getById(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }

  /** Park a notified session until snoozeUntil, then wake via wakeDueSnoozes. */
  snooze(id: string, snoozeUntil: string, minutes: number): ConferSession {
    return this.transaction(() => {
      const session = this.updateStatus(id, "notified", "snoozed");
      this.db
        .update(sessions)
        .set({
          snoozeUntil,
          operatorSeenAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(sessions.id, id))
        .run();
      this.addEvent(id, "session.snoozed", { minutes, snooze_until: snoozeUntil });
      return this.getById(id) ?? session;
    });
  }

  markSeen(id: string, seenAt = new Date().toISOString()): ConferSession | null {
    const session = this.getById(id);
    if (!session || session.status !== "notified") return null;
    return this.transaction(() => {
      this.db
        .update(sessions)
        .set({ operatorSeenAt: seenAt, updatedAt: seenAt })
        .where(and(eq(sessions.id, id), eq(sessions.status, "notified")))
        .run();
      this.addEvent(id, "session.seen", { operator_seen_at: seenAt });
      return this.getById(id);
    });
  }

  listDueSnoozes(now = new Date().toISOString()): ConferSession[] {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.status, "snoozed"), lte(sessions.snoozeUntil, now)))
      .all()
      .map(rowToSession);
  }

  addEvent(sessionId: string, type: string, payload: Record<string, unknown>): SessionEvent {
    const event: SessionEvent = {
      id: generateEventId(),
      sessionId,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(events).values({
      id: event.id,
      sessionId: event.sessionId,
      type: event.type,
      payloadJson: JSON.stringify(event.payload),
      createdAt: event.createdAt,
    }).run();
    return event;
  }

  getEvents(sessionId: string): SessionEvent[] {
    return this.db
      .select()
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(desc(events.createdAt))
      .all()
      .map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        type: row.type,
        payload: JSON.parse(row.payloadJson),
        createdAt: row.createdAt,
      }));
  }

  claimChannelDelivery(sessionId: string, channel: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .insert(channelDeliveries)
      .values({
        id: `${sessionId}:${channel}`,
        sessionId,
        channel,
        status: "claimed",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    return result.changes === 1;
  }

  completeChannelDelivery(
    sessionId: string,
    channel: string,
    result: { success: boolean; externalId?: string; error?: string },
  ): void {
    this.db
      .update(channelDeliveries)
      .set({
        status: result.success ? "succeeded" : "failed",
        externalId: result.externalId ?? null,
        error: result.error ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(channelDeliveries.id, `${sessionId}:${channel}`))
      .run();
  }

  getChannelDelivery(sessionId: string, channel: string): {
    status: string;
    externalId?: string;
    error?: string;
  } | null {
    const row = this.db
      .select()
      .from(channelDeliveries)
      .where(eq(channelDeliveries.id, `${sessionId}:${channel}`))
      .get();
    return row
      ? {
          status: row.status,
          externalId: row.externalId ?? undefined,
          error: row.error ?? undefined,
        }
      : null;
  }

  createPhoneAttempt(input: {
    id: string;
    sessionId: string;
    operatorId: string;
    trigger: PhoneAttemptTrigger;
    status: "scheduled" | "dialing";
    scheduledAt?: string;
    consumesAutomaticSlot?: boolean;
  }): PhoneAttempt {
    return this.transaction(() => {
      const sequence =
        (this.db
          .select({ sequence: phoneAttempts.sequence })
          .from(phoneAttempts)
          .where(eq(phoneAttempts.sessionId, input.sessionId))
          .orderBy(desc(phoneAttempts.sequence))
          .limit(1)
          .get()?.sequence ?? 0) + 1;
      const now = new Date().toISOString();
      this.db.insert(phoneAttempts).values({
        id: input.id,
        sessionId: input.sessionId,
        operatorId: input.operatorId,
        sequence,
        trigger: input.trigger,
        status: input.status,
        scheduledAt: input.scheduledAt ?? null,
        startedAt: input.status === "dialing" ? now : null,
        consumesAutomaticSlot: input.consumesAutomaticSlot ?? false,
        createdAt: now,
        updatedAt: now,
      }).run();
      const created = this.getPhoneAttempt(input.id);
      if (!created) throw new Error(`Phone attempt not found after insert: ${input.id}`);
      return created;
    });
  }

  getPhoneAttempt(id: string): PhoneAttempt | null {
    const row = this.db.select().from(phoneAttempts).where(eq(phoneAttempts.id, id)).get();
    return row ? rowToPhoneAttempt(row) : null;
  }

  listPhoneAttempts(sessionId: string): PhoneAttempt[] {
    return this.db
      .select()
      .from(phoneAttempts)
      .where(eq(phoneAttempts.sessionId, sessionId))
      .orderBy(phoneAttempts.sequence)
      .all()
      .map(rowToPhoneAttempt);
  }

  latestPhoneAttempt(sessionId: string): PhoneAttempt | null {
    const row = this.db
      .select()
      .from(phoneAttempts)
      .where(eq(phoneAttempts.sessionId, sessionId))
      .orderBy(desc(phoneAttempts.sequence))
      .limit(1)
      .get();
    return row ? rowToPhoneAttempt(row) : null;
  }

  listDuePhoneAttempts(now = new Date().toISOString()): PhoneAttempt[] {
    return this.db
      .select()
      .from(phoneAttempts)
      .where(and(eq(phoneAttempts.status, "scheduled"), lte(phoneAttempts.scheduledAt, now)))
      .all()
      .map(rowToPhoneAttempt);
  }

  listStaleClaimedPhoneAttempts(
    claimedBefore: string,
  ): PhoneAttempt[] {
    return this.db
      .select()
      .from(phoneAttempts)
      .where(
        and(
          inArray(phoneAttempts.status, ["dialing", "queued"]),
          isNull(phoneAttempts.providerCallId),
          lte(phoneAttempts.startedAt, claimedBefore),
        ),
      )
      .all()
      .map(rowToPhoneAttempt);
  }

  hasActivePhoneAttempt(operatorId: string, exceptId?: string): boolean {
    const active = new Set(["dialing", "queued", "ringing", "in-progress"]);
    return this.db
      .select()
      .from(phoneAttempts)
      .where(eq(phoneAttempts.operatorId, operatorId))
      .all()
      .some((row) => row.id !== exceptId && active.has(row.status));
  }

  claimPhoneAttempt(id: string): PhoneAttempt | null {
    return this.transaction(() => {
      const attempt = this.getPhoneAttempt(id);
      if (!attempt || attempt.status !== "scheduled") return null;
      if (this.hasActivePhoneAttempt(attempt.operatorId, id)) return null;
      const now = new Date().toISOString();
      const updated = this.db
        .update(phoneAttempts)
        .set({ status: "dialing", startedAt: now, updatedAt: now })
        .where(and(eq(phoneAttempts.id, id), eq(phoneAttempts.status, "scheduled")))
        .run();
      return updated.changes === 1 ? this.getPhoneAttempt(id) : null;
    });
  }

  updatePhoneAttempt(
    id: string,
    patch: Partial<Pick<PhoneAttempt, "status" | "providerCallId" | "roomName" | "retryable" | "error" | "scheduledAt" | "startedAt" | "endedAt">>,
  ): PhoneAttempt {
    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.providerCallId !== undefined) updates.providerCallId = patch.providerCallId;
    if (patch.roomName !== undefined) updates.roomName = patch.roomName;
    if (patch.retryable !== undefined) updates.retryable = patch.retryable;
    if (patch.error !== undefined) updates.error = patch.error;
    if (patch.scheduledAt !== undefined) updates.scheduledAt = patch.scheduledAt;
    if (patch.startedAt !== undefined) updates.startedAt = patch.startedAt;
    if (patch.endedAt !== undefined) updates.endedAt = patch.endedAt;
    this.db.update(phoneAttempts).set(updates).where(eq(phoneAttempts.id, id)).run();
    const updated = this.getPhoneAttempt(id);
    if (!updated) throw new Error(`Phone attempt not found: ${id}`);
    return updated;
  }

  supersedeScheduledPhoneAttempts(sessionId: string): number {
    return this.db
      .update(phoneAttempts)
      .set({ status: "superseded", endedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(and(eq(phoneAttempts.sessionId, sessionId), eq(phoneAttempts.status, "scheduled")))
      .run().changes;
  }

  getDecisionSubmission(id: string): { sessionId: string; payloadFingerprint: string } | null {
    const row = this.db
      .select()
      .from(decisionSubmissions)
      .where(eq(decisionSubmissions.id, id))
      .get();
    return row ? { sessionId: row.sessionId, payloadFingerprint: row.payloadFingerprint } : null;
  }

  enqueueWebhook(
    id: string,
    sessionId: string,
    url: string,
    payload: Record<string, unknown>,
    signature: string,
    eventId: string,
    timestamp: string,
  ): void {
    this.db.insert(webhookOutbox).values({
      id,
      sessionId,
      url,
      payloadJson: JSON.stringify(payload),
      signature: signature ?? null,
      eventId,
      timestamp,
      attempts: 0,
      nextAttemptAt: new Date().toISOString(),
      deliveredAt: null,
      lastError: null,
      claimedAt: null,
      createdAt: new Date().toISOString(),
    }).run();
  }

  getPendingWebhooks(): Array<{
    id: string;
    sessionId: string;
    url: string;
    payload: Record<string, unknown>;
    signature?: string;
    attempts: number;
    eventId: string;
    timestamp: string;
  }> {
    const now = new Date().toISOString();
    const rows = this.db
      .select()
      .from(webhookOutbox)
      .all()
      .filter((r) => !r.deliveredAt && (r.nextAttemptAt ?? now) <= now);
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      url: row.url,
      payload: JSON.parse(row.payloadJson),
      signature: row.signature ?? undefined,
      attempts: row.attempts ?? 0,
      eventId: row.eventId ?? row.id,
      timestamp: row.timestamp ?? row.createdAt,
    }));
  }

  claimPendingWebhooks(limit = 10, maxAttempts = 8, leaseMs = 60_000) {
    return this.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      const leaseExpired = new Date(now.getTime() - leaseMs).toISOString();
      const rows = this.db
        .select()
        .from(webhookOutbox)
        .where(
          and(
            isNull(webhookOutbox.deliveredAt),
            lte(webhookOutbox.nextAttemptAt, nowIso),
            lt(webhookOutbox.attempts, maxAttempts),
            or(isNull(webhookOutbox.claimedAt), lte(webhookOutbox.claimedAt, leaseExpired)),
          ),
        )
        .limit(limit)
        .all();
      for (const row of rows) {
        this.db
          .update(webhookOutbox)
          .set({ claimedAt: nowIso })
          .where(and(eq(webhookOutbox.id, row.id), isNull(webhookOutbox.deliveredAt)))
          .run();
      }
      return rows.map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        url: row.url,
        payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
        signature: row.signature ?? "",
        attempts: row.attempts ?? 0,
        eventId: row.eventId ?? row.id,
        timestamp: row.timestamp ?? row.createdAt,
      }));
    });
  }

  markWebhookDelivered(id: string): void {
    this.db
      .update(webhookOutbox)
      .set({ deliveredAt: new Date().toISOString(), lastError: null, claimedAt: null })
      .where(eq(webhookOutbox.id, id))
      .run();
  }

  markWebhookFailed(id: string, error: string, nextAttemptAt: string): void {
    const row = this.db.select().from(webhookOutbox).where(eq(webhookOutbox.id, id)).get();
    this.db
      .update(webhookOutbox)
      .set({
        attempts: (row?.attempts ?? 0) + 1,
        lastError: error,
        nextAttemptAt,
        claimedAt: null,
      })
      .where(eq(webhookOutbox.id, id))
      .run();
  }

  acknowledge(sessionId: string, runId?: string): void {
    this.db.insert(acknowledgements).values({
      sessionId,
      runId: runId ?? null,
      acknowledgedAt: new Date().toISOString(),
    }).run();
  }

  isAcknowledged(sessionId: string): boolean {
    const row = this.db
      .select()
      .from(acknowledgements)
      .where(eq(acknowledgements.sessionId, sessionId))
      .get();
    return !!row;
  }

  completeSession(
    id: string,
    patch: Pick<
      ConferSession,
      "result" | "summary" | "capturedContext" | "continuityCapsule" | "humanConfirmation"
    >,
    webhook?: {
      id: string;
      url: string;
      payload: Record<string, unknown>;
      signature: string;
      eventId: string;
      timestamp: string;
    },
    submission?: { id: string; payloadFingerprint: string },
  ): ConferSession {
    return this.transaction(() => {
      const current = this.getById(id);
      if (submission) {
        this.db.insert(decisionSubmissions).values({
          id: submission.id,
          sessionId: id,
          payloadFingerprint: submission.payloadFingerprint,
          createdAt: new Date().toISOString(),
        }).run();
      }
      this.update(id, {
        ...patch,
        pendingDecision: undefined,
        phoneRetry: current?.phoneRetry
          ? {
              ...current.phoneRetry,
              state: "stopped",
              automaticStopped: true,
              nextRetryAt: undefined,
            }
          : undefined,
      });
      const completed = this.updateStatus(id, "confirming", "completed");
      this.addEvent(id, "session.completed", { summary: patch.summary });
      this.addEvent(id, "session.result_ready", {
        result: patch.result,
        captured_context: patch.capturedContext ?? emptyCapturedContext(),
        continuity_capsule: patch.continuityCapsule
          ? {
              continuity_version: patch.continuityCapsule.continuityVersion,
              summary: patch.continuityCapsule.summary,
              decisions: patch.continuityCapsule.decisions,
              open_threads: patch.continuityCapsule.openThreads,
              suggested_memory_updates: patch.continuityCapsule.suggestedMemoryUpdates,
              context_sources: patch.continuityCapsule.contextSources,
            }
          : undefined,
      });
      if (webhook) {
        this.enqueueWebhook(
          webhook.id,
          id,
          webhook.url,
          webhook.payload,
          webhook.signature,
          webhook.eventId,
          webhook.timestamp,
        );
      }
      return completed;
    });
  }

  acknowledgeResult(id: string, from: "completed" | "result_delivered", runId?: string) {
    return this.transaction(() => {
      if (this.isAcknowledged(id)) return this.getById(id);
      this.acknowledge(id, runId);
      if (from === "completed") this.updateStatus(id, "completed", "result_delivered");
      const updated = this.updateStatus(id, "result_delivered", "result_acknowledged");
      this.addEvent(id, "session.result_acknowledged", { runId });
      return updated;
    });
  }

  markWebhookDeliveredWithEvent(webhookId: string, sessionId: string, url: string): void {
    this.transaction(() => {
      this.markWebhookDelivered(webhookId);
      const session = this.getById(sessionId);
      if (session?.status === "completed") {
        this.updateStatus(sessionId, "completed", "result_delivered");
        this.addEvent(sessionId, "session.result_delivered", { url });
      }
    });
  }

  expireDue(now = new Date().toISOString()): number {
    const expirable: SessionState[] = [
      "created",
      "policy_check",
      "queued",
      "scheduled",
      "dispatching",
      "notified",
      "snoozed",
      "joining",
      "active",
      "confirming",
    ];
    const due = this.db
      .select({ id: sessions.id, status: sessions.status })
      .from(sessions)
      .where(and(lte(sessions.expiresAt, now), inArray(sessions.status, expirable)))
      .all();
    let count = 0;
    for (const row of due) {
      this.transaction(() => {
        const result = this.db
          .update(sessions)
          .set({ status: "expired", updatedAt: now })
          .where(and(eq(sessions.id, row.id), eq(sessions.status, row.status)))
          .run();
        if (result.changes === 1) {
          this.addEvent(row.id, "session.expired", {});
          count++;
        }
      });
    }
    return count;
  }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation);
  }
}

export { schema };
