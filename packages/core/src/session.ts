export const SESSION_STATES = [
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
  "completed",
  "result_delivered",
  "result_acknowledged",
  "policy_blocked",
  "declined",
  "expired",
  "cancelled",
  "failed",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export const TERMINAL_STATES: readonly SessionState[] = [
  "policy_blocked",
  "declined",
  "expired",
  "cancelled",
  "failed",
  "result_acknowledged",
] as const;

export const SESSION_TYPES = [
  "decision",
  "approval",
  "briefing",
  "incident",
] as const;

export type SessionType = (typeof SESSION_TYPES)[number];

export const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  created: ["policy_check", "cancelled", "failed"],
  policy_check: ["queued", "scheduled", "policy_blocked", "cancelled", "failed"],
  queued: ["dispatching", "cancelled", "expired", "failed"],
  scheduled: ["dispatching", "cancelled", "expired", "failed"],
  dispatching: ["notified", "failed", "cancelled", "expired"],
  notified: ["joining", "snoozed", "declined", "expired", "cancelled", "failed"],
  snoozed: ["dispatching", "joining", "declined", "expired", "cancelled", "failed"],
  joining: ["active", "failed", "cancelled", "expired", "declined"],
  active: ["confirming", "failed", "cancelled", "declined"],
  confirming: ["completed", "active", "declined", "cancelled", "failed"],
  completed: ["result_delivered", "failed"],
  result_delivered: ["result_acknowledged", "failed"],
  result_acknowledged: [],
  policy_blocked: [],
  declined: [],
  expired: [],
  cancelled: [],
  failed: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: SessionState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid session transition: ${from} → ${to}`);
  }
}

export interface SessionInitiator {
  agentId: string;
  harness: string;
  project?: string;
}

export interface SessionParticipant {
  operatorId: string;
  /** Preferred name captured when the session is created, for personal voice greetings. */
  callName?: string;
}

export interface SessionBrief {
  reason: string;
  completed?: string[];
  recommendation?: string;
  options?: Array<{ id: string; label: string }>;
  context?: string;
  consequenceOfDelay?: string;
}

export interface SessionContinuation {
  runId: string;
  opaqueToken?: string;
}

export interface SessionCallback {
  url: string;
  secret?: string;
}

export type PhoneRetryPolicy = "never" | "brief" | "persistent";

export type PhoneRetryState =
  | "idle"
  | "scheduled"
  | "dialing"
  | "in_call"
  | "exhausted"
  | "stopped"
  | "blocked";

export interface PendingDecision {
  result: Record<string, unknown>;
  summary?: string;
  capturedContext?: CapturedContext;
  revision: number;
  previewedAt: string;
}

export interface PhoneRetrySnapshot {
  policy: PhoneRetryPolicy;
  state: PhoneRetryState;
  attemptCount: number;
  automaticCallbacksUsed: number;
  automaticStopped: boolean;
  retryOriginAt?: string;
  deadlineAt?: string;
  nextRetryAt?: string;
  lastOutcome?: string;
  blockedReason?: string;
}

export interface ContinuityPersonality {
  identity_statement: string;
  tone: string[];
  speaking_style: string[];
  interaction_style: string[];
  values: string[];
  preferred_phrasing: string[];
  disallowed_phrasing: string[];
  greeting_policy?: string;
  uncertainty_style?: string;
  humor_style?: string;
  verbosity?: "terse" | "balanced" | "detailed";
  relationship_behavior?: string;
}

export interface ContinuityPackage {
  continuity_version: "1.0";
  agent: {
    id: string;
    name?: string;
    source?: string;
    personality_summary: ContinuityPersonality;
  };
  relationship: {
    status: "new" | "established";
    first_interaction: boolean;
    preferred_name?: string;
    summary?: string;
  };
  thread: {
    topic?: string;
    summary: string;
    current_goal: string;
    open_questions: string[];
    decisions_so_far: string[];
    commitments: string[];
    last_user_intent?: string;
    last_agent_message?: string;
    handoff_instruction?: string;
  };
  /** Non-secret provider reference. Credentials never belong here. */
  memory?: {
    provider?: string;
    connection_id?: string;
    workspace?: string;
    user_peer?: string;
    agent_peer?: string;
    session_strategy: "per_call" | "per_source_conversation" | "per_workspace" | "per_project" | "global";
    permissions: Array<
      | "identity:read"
      | "relationship:read"
      | "preferences:read"
      | "episodes:search"
      | "thread:read"
      | "call_summary:write"
      | "memory_suggestions:write"
    >;
  };
}

export type ContinuityContextSource = "personality" | "relationship" | "thread" | "fallback";

export interface ContinuityTrace {
  applied: ContinuityContextSource[];
  memory: "not_attempted" | "unavailable";
  degraded: boolean;
}

export interface ContinuityCapsule {
  continuityVersion: "1.0";
  summary: string;
  decisions: Record<string, unknown>;
  openThreads: string[];
  suggestedMemoryUpdates: [];
  contextSources: ContinuityContextSource[];
}

export interface CapturedContext {
  /** Preferences or constraints that shape the originating work. */
  steering: string[];
  /** Explicit instructions for the originating run that are separate from the decision result. */
  additional_instructions: string[];
  /** Distinct follow-up work that must not silently expand the current task. */
  new_requests: string[];
  /** Useful topics heard during the call that remain unresolved. */
  unresolved_topics: string[];
}

export function emptyCapturedContext(): CapturedContext {
  return {
    steering: [],
    additional_instructions: [],
    new_requests: [],
    unresolved_topics: [],
  };
}

export interface ConferSession {
  id: string;
  type: SessionType;
  /** BCP 47 locale selected by the initiating agent; defaults to English. */
  locale: string;
  status: SessionState;
  initiator: SessionInitiator;
  participant: SessionParticipant;
  objective: string;
  brief: SessionBrief;
  resultSchema: Record<string, unknown>;
  routing: { policy: string };
  continuation?: SessionContinuation;
  callback?: SessionCallback;
  continuity?: ContinuityPackage;
  continuityTrace?: ContinuityTrace;
  continuityCapsule?: ContinuityCapsule;
  urgency?: "normal" | "high" | "incident";
  estimatedDurationMinutes?: number;
  expiresAt?: string;
  /** When status is snoozed, wake and re-notify at this time. */
  snoozeUntil?: string;
  /** Operator acknowledged the ring ("check later") without answering. */
  operatorSeenAt?: string;
  joinToken?: string;
  joinUrl?: string;
  result?: Record<string, unknown>;
  summary?: string;
  capturedContext?: CapturedContext;
  pendingDecision?: PendingDecision;
  phoneRetry?: PhoneRetrySnapshot;
  humanConfirmation?: {
    confirmedAt: string;
    method: "session_ui" | "text_form" | "voice_agent";
    submissionId?: string;
  };
  createdAt: string;
  updatedAt: string;
}

/** Allowed snooze durations (minutes). Operator presets must be a subset. */
export const ALLOWED_SNOOZE_MINUTES = [1, 3, 5, 10, 15, 30] as const;
export type AllowedSnoozeMinutes = (typeof ALLOWED_SNOOZE_MINUTES)[number];

export const DEFAULT_SNOOZE_PRESETS: AllowedSnoozeMinutes[] = [1, 3, 5];

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `ses_${ts}${rand}`;
}

export function generateEventId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `evt_${ts}${rand}`;
}
