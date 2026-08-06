import { createHash, randomBytes } from "node:crypto";
import type {
  CapturedContext,
  ConferSession,
  ContinuityCapsule,
  ContinuityPackage,
  ContinuityTrace,
  PendingDecision,
  PhoneRetryPolicy,
  PhoneRetrySnapshot,
} from "@openconfer/core";
import { emptyCapturedContext, generateSessionId } from "@openconfer/core";
import type { CreateSessionInput, OpenConferConfig, OperatorAlerts } from "@openconfer/schemas";
import {
  ALLOWED_SNOOZE_MINUTES,
  DEFAULT_OPERATOR_ALERTS,
  resolveSpeakingReady,
  validateResultAgainstSchema,
} from "@openconfer/schemas";
import {
  generateJoinToken,
  signJoinJwt,
  signWebhookPayload,
  verifyJoinJwt,
  webhookSignatureInput,
} from "@openconfer/auth-local";
import type { ConversationAdapter, TelephonyAdapter, TelephonyCallResult } from "@openconfer/adapter-sdk";
import { createLiveKitAdapter } from "@openconfer/conversation-livekit";
import { createSecureLinkNotifier } from "@openconfer/notify-secure-link";
import { createTwilioTelephonyAdapter } from "@openconfer/telephony-twilio";
import type {
  PhoneAttempt,
  PhoneAttemptStatus,
  SessionStore,
} from "@openconfer/storage-sqlite";
import {
  evaluatePolicy,
  checkRateLimit,
  isOperatorInQuietHours,
  nextOperatorQuietHoursEnd,
} from "./policy.js";
import { isCallbackUrlAllowed } from "./webhook-worker.js";

export class IdempotencyConflictError extends Error {
  constructor(message = "Idempotency key was reused with a different payload") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class SubmissionConflictError extends Error {
  constructor(message = "Submission id was reused with a different decision") {
    super(message);
    this.name = "SubmissionConflictError";
  }
}

export class PreviewConflictError extends Error {
  constructor(message = "The pending decision changed; preview again before submitting") {
    super(message);
    this.name = "PreviewConflictError";
  }
}

const RESUMABLE_STATUSES = new Set(["created", "policy_check", "queued", "dispatching"]);
const OPEN_SESSION_STATUSES = new Set(["notified", "snoozed", "joining", "active", "confirming"]);
const ACTIVE_ATTEMPT_STATUSES = new Set(["dialing", "queued", "ringing", "in-progress"]);
const TERMINAL_PHONE_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);
const RETRY_OFFSETS_MS: Record<PhoneRetryPolicy, number[]> = {
  never: [],
  brief: [60_000, 5 * 60_000],
  persistent: [60_000, 3 * 60_000, 7 * 60_000, 15 * 60_000, 25 * 60_000],
};
const RETRY_WINDOW_MS: Record<PhoneRetryPolicy, number> = {
  never: 0,
  brief: 10 * 60_000,
  persistent: 30 * 60_000,
};

function continuityTraceFor(continuity?: ContinuityPackage): ContinuityTrace {
  return continuity
    ? {
        applied: ["personality", "relationship", "thread"],
        memory: "not_attempted",
        degraded: false,
      }
    : {
        applied: ["fallback"],
        memory: "not_attempted",
        degraded: true,
      };
}

function continuityCapsuleFor(
  session: ConferSession,
  result: Record<string, unknown>,
  summary: string | undefined,
  capturedContext: CapturedContext,
): ContinuityCapsule {
  return {
    continuityVersion: "1.0",
    summary: summary ?? "",
    decisions: result,
    openThreads: capturedContext.unresolved_topics,
    suggestedMemoryUpdates: [],
    contextSources: (session.continuityTrace ?? continuityTraceFor(session.continuity)).applied,
  };
}

function serializeContinuityCapsule(capsule: ContinuityCapsule) {
  return {
    continuity_version: capsule.continuityVersion,
    summary: capsule.summary,
    decisions: capsule.decisions,
    open_threads: capsule.openThreads,
    suggested_memory_updates: capsule.suggestedMemoryUpdates,
    context_sources: capsule.contextSources,
  };
}

export function fingerprintCreateInput(input: CreateSessionInput): string {
  const { idempotency_key: _ignored, ...payload } = input;
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class SessionService {
  private notifier = createSecureLinkNotifier();
  private conversation: ConversationAdapter = createLiveKitAdapter({ mock: true });
  private telephony: TelephonyAdapter;

  constructor(
    private store: SessionStore,
    private config: OpenConferConfig,
    private jwtSecret: string,
    conversation?: ConversationAdapter,
    private readonly telephonyOverride?: TelephonyAdapter,
  ) {
    if (conversation) this.conversation = conversation;
    else this.applyConversationConfig(config);
    this.telephony = telephonyOverride ?? this.createTelephonyAdapter(config);
  }

  /** Reload runtime config after Settings writes to config.yaml. */
  replaceConfig(config: OpenConferConfig): void {
    this.config = config;
    this.applyConversationConfig(config);
    if (!this.telephonyOverride) this.telephony = this.createTelephonyAdapter(config);
  }

  private createTelephonyAdapter(config: OpenConferConfig): TelephonyAdapter {
    const twilio = config.telephony?.twilio;
    return createTwilioTelephonyAdapter({
      accountSid: twilio?.account_sid,
      authToken: twilio?.auth_token,
      fromNumber: twilio?.from_number,
      destinationNumber: twilio?.destination_number,
      livekitUrl: config.conversation.livekit_url,
      livekitApiKey: config.conversation.livekit_api_key,
      livekitApiSecret: config.conversation.livekit_api_secret,
    });
  }

  private applyConversationConfig(config: OpenConferConfig): void {
    const speakingReady = resolveSpeakingReady(config.conversation) === "ready";
    this.conversation = createLiveKitAdapter({
      url: config.conversation.livekit_public_url ?? config.conversation.livekit_url,
      apiKey: config.conversation.livekit_api_key,
      apiSecret: config.conversation.livekit_api_secret,
      apiUrl: config.conversation.livekit_url,
      // Only dispatch the speaking agent when the selected preset has credentials.
      agentName: speakingReady
        ? process.env.OPENCONFER_VOICE_AGENT_NAME || "openconfer-conversation"
        : undefined,
      mock: !config.conversation.livekit_api_key,
    });
  }

  private phoneRetrySnapshot(operatorId: string): PhoneRetrySnapshot {
    const policy =
      this.config.operators[operatorId]?.alerts?.phone_retry_policy ??
      DEFAULT_OPERATOR_ALERTS.phone_retry_policy;
    return {
      policy,
      state: "idle",
      attemptCount: 0,
      automaticCallbacksUsed: 0,
      automaticStopped: policy === "never",
    };
  }

  /** Expire sessions and asynchronously tear down any phone work attached to them. */
  expireDueSessions(now = new Date().toISOString()): number {
    const due = this.store.listDueExpirations(now);
    const count = this.store.expireDue(now);
    for (const session of due) {
      if (this.store.getById(session.id)?.status === "expired") {
        void this.closePhoneAttempts(session.id, "canceled");
      }
    }
    return count;
  }

  async create(input: CreateSessionInput): Promise<ConferSession> {
    const fingerprint = fingerprintCreateInput(input);
    if (input.idempotency_key) {
      const existing = this.store.getIdempotencyRecord(input.idempotency_key);
      if (existing) {
        if (existing.fingerprint && existing.fingerprint !== fingerprint) {
          throw new IdempotencyConflictError();
        }
        if (RESUMABLE_STATUSES.has(existing.session.status)) {
          return this.resumeCreate(existing.session);
        }
        return existing.session;
      }
    }
    if (input.expires_at && Date.parse(input.expires_at) <= Date.now()) {
      throw new Error("expires_at must be in the future");
    }
    if (input.callback && (this.callbackSecret(input)?.length ?? 0) < 16) {
      throw new Error("Callbacks require callback.secret or a configured webhook secret");
    }
    if (input.callback && !isCallbackUrlAllowed(input.callback.url)) {
      throw new Error("Callback URL is not allowed");
    }
    const policy = evaluatePolicy(input, this.config);
    if (!policy.allowed) {
      const now = new Date().toISOString();
      const blocked: ConferSession = {
        id: generateSessionId(),
        type: input.type,
        locale: input.locale,
        status: "policy_blocked",
        initiator: {
          agentId: input.initiator.agent_id,
          harness: input.initiator.harness,
          project: input.initiator.project,
        },
        participant: {
          operatorId: input.participant.operator_id,
          callName: this.config.operators[input.participant.operator_id]?.call_name,
        },
        objective: input.objective,
        brief: {
          reason: input.brief.reason,
          completed: input.brief.completed,
          recommendation: input.brief.recommendation,
          options: input.brief.options,
          context: input.brief.context,
          consequenceOfDelay: input.brief.consequence_of_delay,
        },
        resultSchema: input.result_schema,
        routing: input.routing,
        continuity: input.continuity,
        continuityTrace: continuityTraceFor(input.continuity),
        continuation: input.continuation
          ? { runId: input.continuation.run_id, opaqueToken: input.continuation.opaque_token }
          : undefined,
        callback: input.callback
          ? { url: input.callback.url, secret: input.callback.secret }
          : undefined,
        urgency: input.urgency,
        estimatedDurationMinutes: input.estimated_duration_minutes,
        expiresAt: input.expires_at,
        createdAt: now,
        updatedAt: now,
      };
      const inserted = this.insertOrGet(
        blocked,
        input.idempotency_key,
        fingerprint,
        "session.policy_blocked",
        { reason: policy.reason, code: policy.code },
      );
      if (!inserted.inserted) {
        return this.resolveExisting(inserted.session, fingerprint, input.idempotency_key);
      }
      return blocked;
    }

    const rate = checkRateLimit(input.initiator.agent_id);
    if (!rate.allowed) {
      const now = new Date().toISOString();
      const blocked: ConferSession = {
        id: generateSessionId(),
        type: input.type,
        locale: input.locale,
        status: "policy_blocked",
        initiator: {
          agentId: input.initiator.agent_id,
          harness: input.initiator.harness,
          project: input.initiator.project,
        },
        participant: {
          operatorId: input.participant.operator_id,
          callName: this.config.operators[input.participant.operator_id]?.call_name,
        },
        objective: input.objective,
        brief: {
          reason: input.brief.reason,
          completed: input.brief.completed,
          recommendation: input.brief.recommendation,
          options: input.brief.options,
        },
        resultSchema: input.result_schema,
        routing: input.routing,
        continuity: input.continuity,
        continuityTrace: continuityTraceFor(input.continuity),
        createdAt: now,
        updatedAt: now,
      };
      const inserted = this.insertOrGet(
        blocked,
        input.idempotency_key,
        fingerprint,
        "session.policy_blocked",
        { reason: rate.reason, code: rate.code },
      );
      if (!inserted.inserted) {
        return this.resolveExisting(inserted.session, fingerprint, input.idempotency_key);
      }
      return blocked;
    }

    const now = new Date().toISOString();
    const id = generateSessionId();
    const joinToken = generateJoinToken();
    // The signed link remains readable briefly after session expiry so the UI can
    // explain why it closed, while connect/confirm still enforce session state.
    const expiresAt = input.expires_at
      ? Date.parse(input.expires_at) + 15 * 60_000
      : Date.now() + 24 * 60 * 60_000;
    const joinJwt = await signJoinJwt(
      { sessionId: id, joinToken },
      this.jwtSecret,
      Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
    );
    const joinUrl = `${this.config.server.web_url}/join/${id}#token=${joinJwt}`;

    const session: ConferSession = {
      id,
      type: input.type,
      locale: input.locale,
      status: "created",
      initiator: {
        agentId: input.initiator.agent_id,
        harness: input.initiator.harness,
        project: input.initiator.project,
      },
      participant: {
        operatorId: input.participant.operator_id,
        callName: this.config.operators[input.participant.operator_id]?.call_name,
      },
      objective: input.objective,
      brief: {
        reason: input.brief.reason,
        completed: input.brief.completed,
        recommendation: input.brief.recommendation,
        options: input.brief.options,
        context: input.brief.context,
        consequenceOfDelay: input.brief.consequence_of_delay,
      },
      resultSchema: input.result_schema,
      routing: input.routing,
      continuity: input.continuity,
      continuityTrace: continuityTraceFor(input.continuity),
      continuation: input.continuation
        ? { runId: input.continuation.run_id, opaqueToken: input.continuation.opaque_token }
        : undefined,
      callback: input.callback
        ? { url: input.callback.url, secret: input.callback.secret }
        : undefined,
      urgency: input.urgency,
      estimatedDurationMinutes: input.estimated_duration_minutes,
      expiresAt: input.expires_at,
      joinToken,
      joinUrl,
      phoneRetry: this.phoneRetrySnapshot(input.participant.operator_id),
      createdAt: now,
      updatedAt: now,
    };

    const inserted = this.insertOrGet(session, input.idempotency_key, fingerprint, "session.created", {
      sessionId: id,
    });
    if (!inserted.inserted) {
      return this.resolveExisting(inserted.session, fingerprint, input.idempotency_key);
    }

    this.store.addEvent(id, "session.continuity_initialized", {
      applied: session.continuityTrace?.applied ?? ["fallback"],
      memory: session.continuityTrace?.memory ?? "not_attempted",
      degraded: session.continuityTrace?.degraded ?? true,
    });

    return this.resumeCreate(inserted.session);
  }

  /** Continue creation after crash between insert and notified. */
  private async resumeCreate(session: ConferSession): Promise<ConferSession> {
    let current = this.store.getById(session.id) ?? session;
    const joinUrl = current.joinUrl;
    if (!joinUrl) return current;

    if (current.status === "created") {
      current = this.store.transitionWithEvent(current.id, "created", "policy_check", "session.policy_check", {
        allowed: true,
        resumed: true,
      });
    }
    if (current.status === "policy_check") {
      current = this.store.transitionWithEvent(current.id, "policy_check", "queued", "session.scheduled", {
        resumed: true,
      });
    }
    if (current.status === "queued") {
      current = this.store.transitionWithEvent(current.id, "queued", "dispatching", "session.dispatching", {
        resumed: true,
      });
    }
    if (current.status === "dispatching") {
      const notifyResult = await this.notify(current, joinUrl);
      if (!notifyResult.success) {
        return this.store.transitionWithEvent(current.id, "dispatching", "failed", "session.failed", {
          reason: notifyResult.error ?? "Notification failed",
          resumed: true,
        });
      }
      return this.store.transitionWithEvent(current.id, "dispatching", "notified", "session.notified", {
        channel: notifyResult.channel,
        joinUrl,
        resumed: true,
      });
    }
    return current;
  }

  private async resolveExisting(
    session: ConferSession,
    fingerprint: string,
    idempotencyKey?: string,
  ): Promise<ConferSession> {
    if (idempotencyKey) {
      const record = this.store.getIdempotencyRecord(idempotencyKey);
      if (record?.fingerprint && record.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError();
      }
    }
    const latest = this.store.getById(session.id) ?? session;
    if (RESUMABLE_STATUSES.has(latest.status)) return this.resumeCreate(latest);
    return latest;
  }

  get(id: string): ConferSession | null {
    this.expireDueSessions();
    return this.store.getById(id);
  }

  list(limit?: number): ConferSession[] {
    this.expireDueSessions();
    return this.store.list(limit);
  }

  async join(id: string, token: string) {
    let session = await this.authorizeJoinForState(id, token, false);
    if (!session) return null;
    if (session.status === "notified" || session.status === "snoozed") {
      try {
        session = this.store.transitionWithEvent(
          id,
          session.status,
          "joining",
          "session.joining",
          { from: session.status },
        );
        this.store.update(id, { snoozeUntil: undefined, operatorSeenAt: undefined });
        session = this.store.getById(id) ?? session;
      } catch {
        session = this.store.getById(id)!;
      }
    }
    if (!session || !["joining", "active"].includes(session.status)) return null;
    const room = await this.conversation.createRoom(session);
    return { session, room };
  }

  operatorAlerts(operatorId = "me"): OperatorAlerts {
    const op = this.config.operators[operatorId];
    const alerts = op?.alerts;
    const snoozeMinutes = alerts?.snooze_minutes ?? DEFAULT_OPERATOR_ALERTS.snooze_minutes;
    return {
      ...DEFAULT_OPERATOR_ALERTS,
      ...(alerts ?? {}),
      snooze_minutes: (ALLOWED_SNOOZE_MINUTES as readonly number[]).includes(snoozeMinutes)
        ? (snoozeMinutes as (typeof ALLOWED_SNOOZE_MINUTES)[number])
        : DEFAULT_OPERATOR_ALERTS.snooze_minutes,
    };
  }

  snooze(id: string, minutes?: number): ConferSession | null {
    this.expireDueSessions();
    const session = this.store.getById(id);
    if (!session || session.status !== "notified") return null;
    const preferred = this.operatorAlerts(session.participant.operatorId).snooze_minutes;
    const resolved = minutes ?? preferred;
    const allowed = new Set<number>(ALLOWED_SNOOZE_MINUTES);
    if (!allowed.has(resolved)) {
      throw new Error(
        `Snooze of ${resolved} minutes is not allowed. Choose one of: ${ALLOWED_SNOOZE_MINUTES.join(", ")}`,
      );
    }
    const snoozeUntil = new Date(Date.now() + resolved * 60_000).toISOString();
    return this.store.snooze(id, snoozeUntil, resolved);
  }

  seen(id: string): ConferSession | null {
    this.expireDueSessions();
    return this.store.markSeen(id);
  }

  /** Wake due snoozes and re-notify through configured channels. */
  async wakeDueSnoozes(): Promise<number> {
    this.expireDueSessions();
    const due = this.store.listDueSnoozes();
    let woken = 0;
    for (const session of due) {
      const joinUrl = session.joinUrl;
      if (!joinUrl) {
        this.store.transitionWithEvent(session.id, "snoozed", "failed", "session.failed", {
          reason: "Missing join URL on snooze wake",
        });
        continue;
      }
      try {
        this.store.transitionWithEvent(session.id, "snoozed", "dispatching", "session.dispatching", {
          reason: "snooze_wake",
        });
        this.store.update(session.id, { snoozeUntil: undefined, operatorSeenAt: undefined });
        const notifyResult = await this.notify(session, joinUrl);
        if (!notifyResult.success) {
          this.store.transitionWithEvent(session.id, "dispatching", "failed", "session.failed", {
            reason: notifyResult.error ?? "Re-notification failed",
          });
          continue;
        }
        this.store.transitionWithEvent(session.id, "dispatching", "notified", "session.notified", {
          channel: notifyResult.channel,
          joinUrl,
          reason: "snooze_wake",
        });
        woken++;
      } catch {
        const current = this.store.getById(session.id);
        if (current && (current.status === "snoozed" || current.status === "dispatching")) {
          try {
            this.store.transitionWithEvent(session.id, current.status, "failed", "session.failed", {
              reason: "Snooze wake failed",
            });
          } catch {
            /* ignore race */
          }
        }
      }
    }
    return woken;
  }

  async authorizeJoin(id: string, token: string): Promise<ConferSession | null> {
    return this.authorizeJoinForState(id, token, true);
  }

  private async authorizeJoinForState(
    id: string,
    token: string,
    allowClosed: boolean,
  ): Promise<ConferSession | null> {
    this.expireDueSessions();
    const grant = await verifyJoinJwt(token, this.jwtSecret);
    if (!grant || grant.sessionId !== id) return null;
    const session = this.store.getById(id);
    if (!session || session.joinToken !== grant.joinToken) return null;
    if (!allowClosed && ["completed", "result_delivered", "result_acknowledged", "expired", "cancelled", "declined", "failed", "policy_blocked"].includes(session.status)) return null;
    return session;
  }

  activate(id: string): ConferSession | null {
    const session = this.store.getById(id);
    if (!session) return null;
    if (session.status === "active") return session;
    if (session.status !== "joining") return null;
    return this.store.transitionWithEvent(id, "joining", "active", "session.active", {});
  }

  preview(
    id: string,
    result: Record<string, unknown>,
    summary?: string,
    capturedContext?: CapturedContext,
    expectedRevision?: number,
  ): PendingDecision | null {
    this.expireDueSessions();
    const session = this.store.getById(id);
    if (!session) return null;

    if (!OPEN_SESSION_STATUSES.has(session.status)) return null;
    const validation = validateResultAgainstSchema(result, session.resultSchema);
    if (!validation.valid) {
      throw new Error(`Result validation failed: ${validation.errors.join(", ")}`);
    }
    const currentRevision = session.pendingDecision?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      throw new PreviewConflictError();
    }
    const pendingDecision: PendingDecision = {
      result,
      summary,
      capturedContext: capturedContext ?? emptyCapturedContext(),
      revision: currentRevision + 1,
      previewedAt: new Date().toISOString(),
    };
    this.store.update(id, { pendingDecision });
    this.store.addEvent(id, "session.decision_previewed", {
      revision: pendingDecision.revision,
      summary,
    });
    return pendingDecision;
  }

  confirm(
    id: string,
    result: Record<string, unknown>,
    summary?: string,
    method: "session_ui" | "text_form" | "voice_agent" = "session_ui",
    capturedContext?: CapturedContext,
    submissionId?: string,
    previewRevision?: number,
  ): ConferSession | null {
    this.expireDueSessions();
    let session = this.store.getById(id);
    if (!session) return null;

    const normalizedCapturedContext = capturedContext ?? emptyCapturedContext();
    const payloadFingerprint = createHash("sha256")
      .update(stableStringify({ result, summary: summary ?? "", capturedContext: normalizedCapturedContext, method }))
      .digest("hex");
    const resolvedSubmissionId = submissionId ?? `legacy_${randomBytes(16).toString("hex")}`;
    const existingSubmission = this.store.getDecisionSubmission(resolvedSubmissionId);
    if (existingSubmission) {
      if (existingSubmission.sessionId !== id || existingSubmission.payloadFingerprint !== payloadFingerprint) {
        throw new SubmissionConflictError();
      }
      return this.store.getById(id);
    }

    const allowedStatuses =
      method === "text_form" || method === "voice_agent"
        ? ["notified", "snoozed", "joining", "active", "confirming"]
        : ["joining", "active", "confirming"];
    if (!allowedStatuses.includes(session.status)) return null;

    const validation = validateResultAgainstSchema(result, session.resultSchema);
    if (!validation.valid) {
      throw new Error(`Result validation failed: ${validation.errors.join(", ")}`);
    }

    if (method === "voice_agent") {
      const pending = session.pendingDecision;
      if (!pending || previewRevision === undefined || pending.revision !== previewRevision) {
        throw new PreviewConflictError();
      }
      const pendingFingerprint = stableStringify({
        result: pending.result,
        summary: pending.summary ?? "",
        capturedContext: pending.capturedContext ?? emptyCapturedContext(),
      });
      const submittedFingerprint = stableStringify({
        result,
        summary: summary ?? "",
        capturedContext: normalizedCapturedContext,
      });
      if (pendingFingerprint !== submittedFingerprint) throw new PreviewConflictError();
    }

    if (session.status === "notified" || session.status === "snoozed") {
      this.store.transitionWithEvent(id, session.status, "joining", "session.joining", { via: method });
      this.store.update(id, { snoozeUntil: undefined, operatorSeenAt: undefined });
      this.store.transitionWithEvent(id, "joining", "active", "session.active", { via: method });
    }

    if (session.status === "joining") {
      this.store.transitionWithEvent(id, "joining", "active", "session.active", {
        via: "confirmation",
      });
    }

    if (session.status === "active" || this.store.getById(id)?.status === "active") {
      this.store.transitionWithEvent(id, "active", "confirming", "session.confirming", {});
    }

    session = this.store.getById(id) ?? session;
    const confirmedAt = new Date().toISOString();
    let webhook: Parameters<SessionStore["completeSession"]>[2];
    if (session.callback?.url) {
      const payload = this.buildResultPayload(
        session,
        result,
        summary,
        normalizedCapturedContext,
        confirmedAt,
        method,
      );
      const payloadStr = JSON.stringify(payload);
      const eventId = `evt_${randomBytes(12).toString("hex")}`;
      const timestamp = new Date().toISOString();
      const secret = this.callbackSecretForSession(session);
      webhook = {
        id: `wh_${randomBytes(8).toString("hex")}`,
        url: session.callback.url,
        payload,
        eventId,
        timestamp,
        signature: signWebhookPayload(webhookSignatureInput(timestamp, eventId, payloadStr), secret),
      };
    }
    const completed = this.store.completeSession(
      id,
      {
        result,
        summary,
        capturedContext: normalizedCapturedContext,
        continuityCapsule: continuityCapsuleFor(
          session,
          result,
          summary,
          normalizedCapturedContext,
        ),
        humanConfirmation: { confirmedAt, method, submissionId: resolvedSubmissionId },
      },
      webhook,
      { id: resolvedSubmissionId, payloadFingerprint },
    );
    void this.closePhoneAttempts(id, "completed");
    void this.conversation.endRoom(id);
    return completed;
  }

  acknowledge(id: string, runId?: string): ConferSession | null {
    const session = this.store.getById(id);
    if (!session) return null;
    if (this.store.isAcknowledged(id)) {
      return session;
    }
    if (!["completed", "result_delivered"].includes(session.status)) return null;
    return this.store.acknowledgeResult(id, session.status as "completed" | "result_delivered", runId);
  }

  cancel(id: string, reason?: string): ConferSession | null {
    const session = this.store.getById(id);
    if (!session) return null;
    const nonCancellable = [
      "completed",
      "result_delivered",
      "result_acknowledged",
      "cancelled",
      "declined",
      "expired",
      "failed",
      "policy_blocked",
    ];
    if (nonCancellable.includes(session.status)) return null;
    try {
      const updated = this.store.transitionWithEvent(
        id,
        session.status,
        "cancelled",
        "session.cancelled",
        reason ? { reason } : {},
      );
      void this.closePhoneAttempts(id, "canceled");
      void this.conversation.endRoom(id);
      return updated;
    } catch {
      return null;
    }
  }

  async getTelephonyDelivery(id: string) {
    let attempt = this.store.latestPhoneAttempt(id);
    if (!attempt) return null;
    let providerStatus: string = attempt.status;
    let providerError = attempt.error;
    let answeredBy: string | undefined;
    if (attempt.providerCallId && ACTIVE_ATTEMPT_STATUSES.has(attempt.status) && this.telephony.status) {
      const result = await this.telephony.status(attempt.providerCallId);
      providerStatus = result.status ?? attempt.status;
      providerError = result.success ? attempt.error : result.error;
      answeredBy = result.answeredBy;
      const machine = answeredBy?.toLowerCase().startsWith("machine") === true;
      if (machine && this.telephony.cancel) void this.telephony.cancel(attempt.providerCallId);
      if (machine || TERMINAL_PHONE_STATUSES.has(providerStatus)) {
        attempt = await this.finishPhoneAttempt(attempt, machine ? "machine" : providerStatus, providerError);
      } else if (["queued", "ringing", "in-progress"].includes(providerStatus)) {
        attempt = this.store.updatePhoneAttempt(attempt.id, {
          status: providerStatus as PhoneAttemptStatus,
        });
        const session = this.store.getById(id);
        if (session?.phoneRetry) {
          this.store.update(id, {
            phoneRetry: {
              ...session.phoneRetry,
              state: providerStatus === "in-progress" ? "in_call" : "dialing",
            },
          });
        }
      }
    }
    const session = this.store.getById(id);
    return {
      status: attempt.status,
      provider_status: providerStatus,
      answered_by: answeredBy,
      error: providerError,
      session_status: session?.status,
      session_ended: false,
      attempt_id: attempt.id,
      attempt_count: this.store.listPhoneAttempts(id).length,
      phone_retry: session?.phoneRetry,
    };
  }

  /** Reconcile open phone sessions even when no browser is polling their call status. */
  async reconcileTelephonyDeliveries(): Promise<number> {
    const candidates = this.store.list(100).filter((session) => {
      const attempt = this.store.latestPhoneAttempt(session.id);
      return OPEN_SESSION_STATUSES.has(session.status) && Boolean(attempt?.providerCallId) &&
        ACTIVE_ATTEMPT_STATUSES.has(attempt!.status);
    });
    for (const session of candidates) await this.getTelephonyDelivery(session.id);
    await this.processDuePhoneRetries();
    return candidates.length;
  }

  async callAgain(id: string): Promise<ConferSession | null> {
    this.expireDueSessions();
    const session = this.store.getById(id);
    if (!session || !OPEN_SESSION_STATUSES.has(session.status)) return null;
    const phoneRetry = session.phoneRetry ?? this.phoneRetrySnapshot(session.participant.operatorId);
    if (!session.phoneRetry) this.store.update(id, { phoneRetry });
    const attempts = this.store.listPhoneAttempts(id);
    if (attempts.some((attempt) => ACTIVE_ATTEMPT_STATUSES.has(attempt.status))) {
      throw new Error("Call already in progress");
    }
    if (this.store.hasActivePhoneAttempt(session.participant.operatorId)) {
      throw new Error("Another call is already in progress for this operator");
    }
    const replacedScheduled = attempts.some((attempt) => attempt.status === "scheduled");
    this.store.supersedeScheduledPhoneAttempts(id);
    const attempt = this.store.createPhoneAttempt({
      id: `call_${randomBytes(12).toString("hex")}`,
      sessionId: id,
      operatorId: session.participant.operatorId,
      trigger: "manual",
      status: "dialing",
      consumesAutomaticSlot: replacedScheduled,
    });
    if (replacedScheduled) {
      this.store.update(id, {
        phoneRetry: {
          ...phoneRetry,
          automaticCallbacksUsed: phoneRetry.automaticCallbacksUsed + 1,
          nextRetryAt: undefined,
          state: "dialing",
        },
      });
    }
    await this.dispatchPhoneAttempt(attempt);
    return this.store.getById(id);
  }

  stopPhoneRetries(id: string): ConferSession | null {
    const session = this.store.getById(id);
    if (!session || !OPEN_SESSION_STATUSES.has(session.status)) return null;
    this.store.supersedeScheduledPhoneAttempts(id);
    const phoneRetry = session.phoneRetry ?? this.phoneRetrySnapshot(session.participant.operatorId);
    const updated = this.store.update(id, {
      phoneRetry: {
        ...phoneRetry,
        automaticStopped: true,
        nextRetryAt: undefined,
        state: "stopped",
      },
    });
    this.store.addEvent(id, "session.phone_retries_stopped", {});
    return updated;
  }

  /** Tear down paid voice resources while keeping the human decision open. */
  async disconnectVoice(
    id: string,
    reason: "idle_timeout" | "max_duration" | "operator_request" = "operator_request",
  ): Promise<ConferSession | null> {
    const session = this.store.getById(id);
    if (!session) return null;
    await this.closePhoneAttempts(id, "canceled");
    await this.conversation.endRoom(id);
    this.store.addEvent(id, "session.voice_disconnected", { reason });
    return this.store.getById(id);
  }

  async prepareBrowserJoin(id: string): Promise<void> {
    const session = this.store.getById(id);
    if (!session || !OPEN_SESSION_STATUSES.has(session.status)) return;
    this.store.supersedeScheduledPhoneAttempts(id);
    if (session?.phoneRetry) {
      this.store.update(id, {
        phoneRetry: {
          ...session.phoneRetry,
          automaticStopped: true,
          state: "stopped",
          nextRetryAt: undefined,
        },
      });
    }
    const attempt = this.store.latestPhoneAttempt(id);
    if (attempt && ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) {
      if (attempt.providerCallId && this.telephony.cancel) await this.telephony.cancel(attempt.providerCallId);
      this.store.updatePhoneAttempt(attempt.id, {
        status: "canceled",
        endedAt: new Date().toISOString(),
      });
      if (attempt.roomName) await this.conversation.endRoom(attempt.roomName);
    }
  }

  async processDuePhoneRetries(): Promise<number> {
    await this.recoverStalePhoneAttemptClaims();
    const priority = { incident: 0, high: 1, normal: 2 } as const;
    const due = this.store.listDuePhoneAttempts().sort((left, right) => {
      const leftSession = this.store.getById(left.sessionId);
      const rightSession = this.store.getById(right.sessionId);
      const urgency = (priority[leftSession?.urgency ?? "normal"] ?? 2) -
        (priority[rightSession?.urgency ?? "normal"] ?? 2);
      return urgency || String(left.scheduledAt).localeCompare(String(right.scheduledAt));
    });
    let dispatched = 0;
    for (const candidate of due) {
      const session = this.store.getById(candidate.sessionId);
      if (!session || !OPEN_SESSION_STATUSES.has(session.status) || session.humanConfirmation) {
        this.store.updatePhoneAttempt(candidate.id, { status: "superseded", endedAt: new Date().toISOString() });
        continue;
      }
      const retry = session.phoneRetry;
      if (!retry || retry.automaticStopped || (retry.deadlineAt && Date.parse(retry.deadlineAt) <= Date.now())) {
        this.store.updatePhoneAttempt(candidate.id, { status: "superseded", endedAt: new Date().toISOString() });
        this.store.update(session.id, {
          phoneRetry: {
            ...(retry ?? this.phoneRetrySnapshot(session.participant.operatorId)),
            state: retry?.automaticStopped ? "stopped" : "exhausted",
            nextRetryAt: undefined,
          },
        });
        continue;
      }
      const operator = this.config.operators[session.participant.operatorId];
      if (
        session.urgency !== "incident" &&
        session.type !== "incident" &&
        operator &&
        isOperatorInQuietHours(operator.timezone, operator.quiet_hours)
      ) {
        const quietEnd = nextOperatorQuietHoursEnd(
          operator.timezone,
          operator.quiet_hours,
          new Date(),
        );
        const stillWithinWindow = quietEnd &&
          (!retry.deadlineAt || quietEnd.getTime() < Date.parse(retry.deadlineAt)) &&
          (!session.expiresAt || quietEnd.getTime() < Date.parse(session.expiresAt));
        if (stillWithinWindow) {
          const scheduledAt = quietEnd.toISOString();
          this.store.updatePhoneAttempt(candidate.id, { scheduledAt });
          this.store.update(session.id, {
            phoneRetry: {
              ...retry,
              state: "scheduled",
              blockedReason: undefined,
              nextRetryAt: scheduledAt,
            },
          });
        } else {
          this.store.updatePhoneAttempt(candidate.id, {
            status: "superseded",
            endedAt: new Date().toISOString(),
          });
          this.store.update(session.id, {
            phoneRetry: {
              ...retry,
              state: "exhausted",
              blockedReason: "quiet_hours",
              nextRetryAt: undefined,
            },
          });
        }
        continue;
      }
      const claimed = this.store.claimPhoneAttempt(candidate.id);
      if (!claimed) continue;
      this.store.update(session.id, {
        phoneRetry: {
          ...retry,
          state: "dialing",
          nextRetryAt: undefined,
          automaticCallbacksUsed: retry.automaticCallbacksUsed + (claimed.consumesAutomaticSlot ? 1 : 0),
        },
      });
      await this.dispatchPhoneAttempt(claimed);
      dispatched++;
    }
    return dispatched;
  }

  private async recoverStalePhoneAttemptClaims(): Promise<void> {
    const claimedBefore = new Date(Date.now() - 60_000).toISOString();
    for (const attempt of this.store.listStaleClaimedPhoneAttempts(claimedBefore)) {
      const session = this.store.getById(attempt.sessionId);
      if (!session || !OPEN_SESSION_STATUSES.has(session.status) || session.humanConfirmation) {
        this.store.updatePhoneAttempt(attempt.id, {
          status: "superseded",
          endedAt: new Date().toISOString(),
        });
        continue;
      }
      const error = "Phone attempt was interrupted before provider placement completed";
      const failed = this.store.updatePhoneAttempt(attempt.id, {
        status: "failed",
        retryable: true,
        error,
        endedAt: new Date().toISOString(),
      });
      if (failed.roomName) await this.conversation.endRoom(failed.roomName);
      this.store.addEvent(attempt.sessionId, "session.phone_attempt_recovered", {
        attempt_id: attempt.id,
      });
      await this.scheduleAfterAttempt(failed, "failed", true, error);
    }
  }

  decline(id: string, reason?: string): ConferSession | null {
    const session = this.store.getById(id);
    if (!session || !["notified", "snoozed", "joining", "active"].includes(session.status)) return null;
    try {
      const updated = this.store.transitionWithEvent(
        id,
        session.status,
        "declined",
        "session.declined",
        { reason },
      );
      void this.closePhoneAttempts(id, "canceled");
      void this.conversation.endRoom(id);
      return updated;
    } catch {
      return null;
    }
  }

  private buildResultPayload(
    session: ConferSession,
    result: Record<string, unknown>,
    summary: string | undefined,
    capturedContext: CapturedContext,
    confirmedAt: string,
    method: "session_ui" | "text_form" | "voice_agent",
  ) {
    const continuityCapsule = continuityCapsuleFor(
      session,
      result,
      summary,
      capturedContext,
    );
    return {
      session_id: session.id,
      status: "completed",
      completion_reason: "human_confirmed",
      summary: summary ?? "",
      result,
      captured_context: capturedContext,
      continuity_capsule: serializeContinuityCapsule(continuityCapsule),
      continuation: session.continuation
        ? {
            run_id: session.continuation.runId,
            opaque_token: session.continuation.opaqueToken,
          }
        : undefined,
      human_confirmation: {
        confirmed_at: confirmedAt,
        method,
      },
    };
  }

  async createJoinJwt(sessionId: string, joinToken: string): Promise<string> {
    return signJoinJwt({ sessionId, joinToken }, this.jwtSecret);
  }

  private insertOrGet(
    session: ConferSession,
    idempotencyKey: string | undefined,
    fingerprint: string,
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    try {
      return {
        session: this.store.insertWithEvent(session, idempotencyKey, eventType, payload, fingerprint),
        inserted: true,
      };
    } catch (error) {
      const existing = idempotencyKey ? this.store.getByIdempotencyKey(idempotencyKey) : null;
      if (existing) return { session: existing, inserted: false };
      throw error;
    }
  }

  private callbackSecret(input: CreateSessionInput): string | undefined {
    return input.callback?.secret ?? this.config.auth.webhook_secret ?? process.env.OPENCONFER_WEBHOOK_SECRET;
  }

  private callbackSecretForSession(session: ConferSession): string {
    const secret = session.callback?.secret ?? this.config.auth.webhook_secret ?? process.env.OPENCONFER_WEBHOOK_SECRET;
    if (!secret) throw new Error("Webhook signing secret is not configured");
    return secret;
  }

  private async notify(session: ConferSession, joinUrl: string) {
    const channels = this.config.routes.default.notify;
    let lastSuccess: Awaited<ReturnType<typeof this.notifier.notify>> | undefined;
    let lastFailure: Awaited<ReturnType<typeof this.notifier.notify>> | undefined;
    let phoneResult: TelephonyCallResult | undefined;
    for (const channel of channels) {
      const result = channel === "twilio"
        ? await this.dispatchTwilio(session)
        : channel === "secure_link"
          ? await this.notifier.notify(session, joinUrl)
          : { success: false as const, channel, error: `Unknown notification channel: ${channel}` };
      if (channel === "twilio") phoneResult = result as TelephonyCallResult;
      if (result.success) {
        if (result.channel === "secure_link") console.info(result.message);
        lastSuccess = result;
      } else {
        lastFailure = result;
      }
    }
    // A phone setup/provider failure never closes the human decision. The inbox and
    // signed join URL remain valid recovery paths.
    if (lastSuccess) return lastSuccess;
    if (phoneResult) {
      return phoneResult.success
        ? phoneResult
        : { success: true, channel: "inbox", message: phoneResult.error };
    }
    return lastFailure ?? { success: false, channel: "none", error: "No notifier configured" };
  }

  private async dispatchTwilio(session: ConferSession): Promise<TelephonyCallResult> {
    const existingAttempt = this.store.listPhoneAttempts(session.id).find((attempt) => attempt.trigger === "initial");
    if (existingAttempt) {
      return {
        success: existingAttempt.status !== "failed",
        channel: "twilio",
        callId: existingAttempt.providerCallId,
        error: existingAttempt.error,
        message: "Twilio call already dispatched",
      };
    }

    this.store.claimChannelDelivery(session.id, "twilio");
    if (this.store.hasActivePhoneAttempt(session.participant.operatorId)) {
      const scheduledAt = new Date().toISOString();
      this.store.createPhoneAttempt({
        id: `call_${randomBytes(12).toString("hex")}`,
        sessionId: session.id,
        operatorId: session.participant.operatorId,
        trigger: "initial",
        status: "scheduled",
        scheduledAt,
      });
      this.store.update(session.id, {
        phoneRetry: {
          ...(session.phoneRetry ?? this.phoneRetrySnapshot(session.participant.operatorId)),
          state: "scheduled",
          nextRetryAt: scheduledAt,
        },
      });
      return { success: true, channel: "twilio", message: "Phone call queued behind another active call" };
    }
    const attempt = this.store.createPhoneAttempt({
      id: `call_${randomBytes(12).toString("hex")}`,
      sessionId: session.id,
      operatorId: session.participant.operatorId,
      trigger: "initial",
      status: "dialing",
    });
    return this.dispatchPhoneAttempt(attempt);
  }

  private async dispatchPhoneAttempt(attempt: PhoneAttempt): Promise<TelephonyCallResult> {
    const session = this.store.getById(attempt.sessionId);
    if (!session || !OPEN_SESSION_STATUSES.has(session.status) && session.status !== "dispatching") {
      this.store.updatePhoneAttempt(attempt.id, { status: "superseded", endedAt: new Date().toISOString() });
      return { success: false, channel: "twilio", error: "Session is no longer open", retryable: false };
    }
    if (session.phoneRetry) {
      this.store.update(session.id, {
        phoneRetry: {
          ...session.phoneRetry,
          attemptCount: (session.phoneRetry.attemptCount ?? 0) + 1,
          state: "dialing",
        },
      });
    }

    let result: TelephonyCallResult;
    let roomName: string | undefined;
    try {
      if (resolveSpeakingReady(this.config.conversation) !== "ready") {
        result = {
          success: false,
          channel: "twilio",
          error: "LiveKit speaking agent is not configured",
          retryable: false,
        };
      } else {
        const readiness = await this.telephony.test?.();
        if (readiness && !readiness.ok) {
          result = { success: false, channel: "twilio", error: readiness.message, retryable: false };
        } else {
          roomName = `confer-${session.id}-call-${attempt.sequence}`;
          const room = await this.conversation.createRoom(session, { roomName, surface: "phone" });
          this.store.updatePhoneAttempt(attempt.id, { roomName });
          result = await this.telephony.call(session, room);
        }
      }
    } catch (error) {
      result = {
        success: false,
        channel: "twilio",
        error: error instanceof Error ? error.message : "Twilio call failed",
        retryable: true,
      };
    }

    if (attempt.trigger === "initial") {
      this.store.completeChannelDelivery(session.id, "twilio", {
        success: result.success,
        externalId: result.callId,
        error: result.error,
      });
    }
    if (result.success) {
      this.store.updatePhoneAttempt(attempt.id, {
        status: "queued",
        providerCallId: result.callId,
        roomName,
      });
      const latest = this.store.getById(session.id);
      if (latest?.phoneRetry) {
        this.store.update(session.id, {
          phoneRetry: {
            ...latest.phoneRetry,
            state: "dialing",
          },
        });
      }
    } else {
      const failed = this.store.updatePhoneAttempt(attempt.id, {
        status: "failed",
        retryable: result.retryable ?? true,
        error: result.error,
        endedAt: new Date().toISOString(),
        roomName,
      });
      if (roomName) void this.conversation.endRoom(roomName);
      await this.scheduleAfterAttempt(failed, "failed", result.retryable ?? true, result.error);
    }
    this.store.addEvent(
      session.id,
      result.success ? "session.channel_delivered" : "session.channel_failed",
      {
        channel: "twilio",
        ...(result.callId ? { external_id: result.callId } : {}),
        ...(result.error ? { error: result.error } : {}),
        attempt_id: attempt.id,
      },
    );
    return result;
  }

  private async finishPhoneAttempt(
    attempt: PhoneAttempt,
    outcome: string,
    error?: string,
  ): Promise<PhoneAttempt> {
    if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) return attempt;
    const retryable = ["busy", "failed", "no-answer", "canceled", "completed", "machine"].includes(outcome);
    const finished = this.store.updatePhoneAttempt(attempt.id, {
      status: outcome as PhoneAttemptStatus,
      retryable,
      error,
      endedAt: new Date().toISOString(),
    });
    if (finished.roomName) await this.conversation.endRoom(finished.roomName);
    this.store.addEvent(attempt.sessionId, "session.phone_attempt_ended", {
      attempt_id: attempt.id,
      outcome,
      retryable,
    });
    await this.scheduleAfterAttempt(finished, outcome, retryable, error);
    return finished;
  }

  private async scheduleAfterAttempt(
    attempt: PhoneAttempt,
    outcome: string,
    retryable: boolean,
    error?: string,
  ): Promise<void> {
    const session = this.store.getById(attempt.sessionId);
    if (
      !session ||
      (!OPEN_SESSION_STATUSES.has(session.status) && session.status !== "dispatching") ||
      session.humanConfirmation
    ) return;
    let retry = session.phoneRetry ?? this.phoneRetrySnapshot(session.participant.operatorId);
    const origin = retry.retryOriginAt ?? new Date().toISOString();
    const deadline = retry.deadlineAt ??
      (RETRY_WINDOW_MS[retry.policy]
        ? new Date(Date.parse(origin) + RETRY_WINDOW_MS[retry.policy]).toISOString()
        : undefined);
    retry = { ...retry, retryOriginAt: origin, deadlineAt: deadline, lastOutcome: outcome };

    if (!retryable) {
      this.store.update(session.id, {
        phoneRetry: { ...retry, state: "blocked", blockedReason: error ?? outcome, nextRetryAt: undefined },
      });
      return;
    }
    if (retry.automaticStopped || retry.policy === "never") {
      this.store.update(session.id, {
        phoneRetry: { ...retry, state: retry.policy === "never" ? "stopped" : retry.state, nextRetryAt: undefined },
      });
      return;
    }
    if (attempt.trigger === "manual" && !attempt.consumesAutomaticSlot) {
      const automaticExhausted =
        retry.automaticCallbacksUsed >= RETRY_OFFSETS_MS[retry.policy].length;
      this.store.update(session.id, {
        phoneRetry: {
          ...retry,
          state: retry.automaticStopped
            ? "stopped"
            : automaticExhausted
              ? "exhausted"
              : "idle",
          nextRetryAt: undefined,
        },
      });
      return;
    }

    const offsets = RETRY_OFFSETS_MS[retry.policy];
    const offset = offsets[retry.automaticCallbacksUsed];
    if (offset === undefined) {
      this.store.update(session.id, {
        phoneRetry: { ...retry, state: "exhausted", nextRetryAt: undefined },
      });
      return;
    }
    const nextAt = new Date(Date.parse(origin) + offset).toISOString();
    if ((deadline && Date.parse(nextAt) > Date.parse(deadline)) || (session.expiresAt && Date.parse(nextAt) >= Date.parse(session.expiresAt))) {
      this.store.update(session.id, {
        phoneRetry: { ...retry, state: "exhausted", nextRetryAt: undefined },
      });
      return;
    }
    this.store.supersedeScheduledPhoneAttempts(session.id);
    this.store.createPhoneAttempt({
      id: `call_${randomBytes(12).toString("hex")}`,
      sessionId: session.id,
      operatorId: session.participant.operatorId,
      trigger: "automatic",
      status: "scheduled",
      scheduledAt: nextAt,
      consumesAutomaticSlot: true,
    });
    this.store.update(session.id, {
      phoneRetry: { ...retry, state: "scheduled", nextRetryAt: nextAt },
    });
    this.store.addEvent(session.id, "session.phone_retry_scheduled", {
      next_retry_at: nextAt,
      callback_number: retry.automaticCallbacksUsed + 1,
    });
  }

  private async closePhoneAttempts(sessionId: string, outcome: "completed" | "canceled"): Promise<void> {
    const session = this.store.getById(sessionId);
    if (session?.phoneRetry) {
      this.store.update(sessionId, {
        phoneRetry: {
          ...session.phoneRetry,
          state: "stopped",
          automaticStopped: true,
          nextRetryAt: undefined,
        },
      });
    }
    this.store.supersedeScheduledPhoneAttempts(sessionId);
    for (const attempt of this.store.listPhoneAttempts(sessionId)) {
      if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
      if (attempt.providerCallId && this.telephony.cancel) await this.telephony.cancel(attempt.providerCallId);
      this.store.updatePhoneAttempt(attempt.id, {
        status: outcome,
        endedAt: new Date().toISOString(),
      });
      if (attempt.roomName) await this.conversation.endRoom(attempt.roomName);
    }
  }
}
