import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  initiatorJson: text("initiator_json").notNull(),
  participantJson: text("participant_json").notNull(),
  objective: text("objective").notNull(),
  briefJson: text("brief_json").notNull(),
  resultSchemaJson: text("result_schema_json").notNull(),
  routingJson: text("routing_json").notNull(),
  continuationJson: text("continuation_json"),
  callbackJson: text("callback_json"),
  urgency: text("urgency").default("normal"),
  estimatedDurationMinutes: integer("estimated_duration_minutes"),
  expiresAt: text("expires_at"),
  snoozeUntil: text("snooze_until"),
  operatorSeenAt: text("operator_seen_at"),
  joinToken: text("join_token"),
  joinUrl: text("join_url"),
  resultJson: text("result_json"),
  summary: text("summary"),
  humanConfirmationJson: text("human_confirmation_json"),
  idempotencyKey: text("idempotency_key"),
  requestFingerprint: text("request_fingerprint"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const webhookOutbox = sqliteTable("webhook_outbox", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  url: text("url").notNull(),
  payloadJson: text("payload_json").notNull(),
  signature: text("signature"),
  eventId: text("event_id"),
  timestamp: text("timestamp"),
  attempts: integer("attempts").default(0),
  nextAttemptAt: text("next_attempt_at"),
  deliveredAt: text("delivered_at"),
  lastError: text("last_error"),
  claimedAt: text("claimed_at"),
  createdAt: text("created_at").notNull(),
});

export const acknowledgements = sqliteTable("acknowledgements", {
  sessionId: text("session_id").primaryKey(),
  runId: text("run_id"),
  acknowledgedAt: text("acknowledged_at").notNull(),
});

/** One durable, at-most-once delivery claim per session and channel. */
export const channelDeliveries = sqliteTable("channel_deliveries", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  channel: text("channel").notNull(),
  status: text("status").notNull(),
  externalId: text("external_id"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
