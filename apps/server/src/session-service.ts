import { createHash, randomBytes } from "node:crypto";
import type { ConferSession } from "@openconfer/core";
import { generateSessionId } from "@openconfer/core";
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
import type { SessionStore } from "@openconfer/storage-sqlite";
import { evaluatePolicy, checkRateLimit } from "./policy.js";
import { isCallbackUrlAllowed } from "./webhook-worker.js";

export class IdempotencyConflictError extends Error {
  constructor(message = "Idempotency key was reused with a different payload") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

const RESUMABLE_STATUSES = new Set(["created", "policy_check", "queued", "dispatching"]);

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
      createdAt: now,
      updatedAt: now,
    };

    const inserted = this.insertOrGet(session, input.idempotency_key, fingerprint, "session.created", {
      sessionId: id,
    });
    if (!inserted.inserted) {
      return this.resolveExisting(inserted.session, fingerprint, input.idempotency_key);
    }

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
    this.store.expireDue();
    return this.store.getById(id);
  }

  list(limit?: number): ConferSession[] {
    this.store.expireDue();
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
    this.store.expireDue();
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
    this.store.expireDue();
    return this.store.markSeen(id);
  }

  /** Wake due snoozes and re-notify through configured channels. */
  async wakeDueSnoozes(): Promise<number> {
    this.store.expireDue();
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
    this.store.expireDue();
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

  confirm(
    id: string,
    result: Record<string, unknown>,
    summary?: string,
    method: "session_ui" | "text_form" | "voice_agent" = "session_ui",
  ): ConferSession | null {
    this.store.expireDue();
    const session = this.store.getById(id);
    if (!session) return null;

    const allowedStatuses =
      method === "text_form"
        ? ["notified", "snoozed", "joining", "active", "confirming"]
        : ["joining", "active", "confirming"];
    if (!allowedStatuses.includes(session.status)) return null;

    const validation = validateResultAgainstSchema(result, session.resultSchema);
    if (!validation.valid) {
      throw new Error(`Result validation failed: ${validation.errors.join(", ")}`);
    }

    if (session.status === "notified" || session.status === "snoozed") {
      this.store.transitionWithEvent(id, session.status, "joining", "session.joining", { via: "text_form" });
      this.store.update(id, { snoozeUntil: undefined, operatorSeenAt: undefined });
      this.store.transitionWithEvent(id, "joining", "active", "session.active", { via: "text_form" });
    }

    if (session.status === "joining") {
      this.store.transitionWithEvent(id, "joining", "active", "session.active", {
        via: "confirmation",
      });
    }

    if (session.status === "active" || this.store.getById(id)?.status === "active") {
      this.store.transitionWithEvent(id, "active", "confirming", "session.confirming", {});
    }

    const confirmedAt = new Date().toISOString();
    let webhook: Parameters<SessionStore["completeSession"]>[2];
    if (session.callback?.url) {
      const payload = this.buildResultPayload(session, result, summary, confirmedAt, method);
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
      { result, summary, humanConfirmation: { confirmedAt, method } },
      webhook,
    );
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

  cancel(id: string): ConferSession | null {
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
      const updated = this.store.transitionWithEvent(id, session.status, "cancelled", "session.cancelled", {});
      void this.conversation.endRoom(id);
      return updated;
    } catch {
      return null;
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
    confirmedAt: string,
    method: "session_ui" | "text_form" | "voice_agent",
  ) {
    return {
      session_id: session.id,
      status: "completed",
      completion_reason: "human_confirmed",
      summary: summary ?? "",
      result,
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
    for (const channel of channels) {
      const result = channel === "twilio"
        ? await this.dispatchTwilio(session)
        : channel === "secure_link"
          ? await this.notifier.notify(session, joinUrl)
          : { success: false as const, channel, error: `Unknown notification channel: ${channel}` };
      if (result.success) {
        if (result.channel === "secure_link") console.info(result.message);
        lastSuccess = result;
      } else {
        lastFailure = result;
      }
    }
    return lastSuccess ?? lastFailure ?? { success: false, channel: "none", error: "No notifier configured" };
  }

  private async dispatchTwilio(session: ConferSession): Promise<TelephonyCallResult> {
    const claimed = this.store.claimChannelDelivery(session.id, "twilio");
    if (!claimed) {
      const existing = this.store.getChannelDelivery(session.id, "twilio");
      if (existing?.status === "failed") {
        return {
          success: false,
          channel: "twilio",
          error: existing.error ?? "Twilio call previously failed",
        };
      }
      return {
        success: true,
        channel: "twilio",
        callId: existing?.externalId,
        message: "Twilio call already dispatched",
      };
    }

    let result: TelephonyCallResult;
    try {
      if (resolveSpeakingReady(this.config.conversation) !== "ready") {
        result = {
          success: false,
          channel: "twilio",
          error: "LiveKit speaking agent is not configured",
        };
      } else {
        const readiness = await this.telephony.test?.();
        if (readiness && !readiness.ok) {
          result = { success: false, channel: "twilio", error: readiness.message };
        } else {
          const room = await this.conversation.createRoom(session);
          result = await this.telephony.call(session, room);
        }
      }
    } catch (error) {
      result = {
        success: false,
        channel: "twilio",
        error: error instanceof Error ? error.message : "Twilio call failed",
      };
    }

    this.store.completeChannelDelivery(session.id, "twilio", {
      success: result.success,
      externalId: result.callId,
      error: result.error,
    });
    this.store.addEvent(
      session.id,
      result.success ? "session.channel_delivered" : "session.channel_failed",
      {
        channel: "twilio",
        ...(result.callId ? { external_id: result.callId } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
    );
    return result;
  }
}
