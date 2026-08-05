export interface CapturedContext {
  steering: string[];
  additional_instructions: string[];
  new_requests: string[];
  unresolved_topics: string[];
}

export interface PendingDecision {
  result: Record<string, unknown>;
  summary?: string;
  captured_context?: CapturedContext;
  revision: number;
  previewed_at: string;
}

export interface PhoneRetryView {
  policy: "never" | "brief" | "persistent";
  state: "idle" | "scheduled" | "dialing" | "in_call" | "exhausted" | "stopped" | "blocked";
  attempt_count: number;
  automatic_callbacks_used: number;
  max_automatic_callbacks: number;
  automatic_stopped: boolean;
  next_retry_at?: string;
  deadline_at?: string;
  last_outcome?: string;
  blocked_reason?: string;
}

export interface JoinSession {
  id: string;
  type: string;
  status: string;
  objective: string;
  brief: {
    reason: string;
    completed?: string[];
    recommendation?: string;
    options?: Array<{ id: string; label: string }>;
    context?: string;
    consequenceOfDelay?: string;
    consequence_of_delay?: string;
  };
  initiator: {
    agent_id: string;
    harness: string;
    project?: string;
  };
  urgency?: string;
  estimated_duration_minutes?: number;
  expires_at?: string;
  snooze_until?: string;
  operator_seen_at?: string;
  privacy?: string | { recording?: boolean; retention?: string; notice?: string };
  result_schema?: Record<string, unknown>;
  result?: Record<string, unknown>;
  summary?: string;
  captured_context?: CapturedContext;
  pending_decision?: PendingDecision;
  phone_retry?: PhoneRetryView;
  /** True when the originating agent registered a callback for result delivery. */
  has_callback?: boolean;
}

export function isDemoSession(session: Pick<JoinSession, "initiator">): boolean {
  return session.initiator.harness === "web-ui" || session.initiator.agent_id === "openconfer-demo";
}

export interface ApiSession extends JoinSession {
  participant?: { operator_id: string };
  join_url?: string;
  created_at?: string;
  updated_at?: string;
  human_confirmation?: {
    confirmed_at: string;
    method: string;
  };
}

export const TERMINAL_STATUSES = [
  "completed",
  "result_delivered",
  "result_acknowledged",
  "policy_blocked",
  "declined",
  "expired",
  "cancelled",
  "failed",
] as const;

export function isTerminalStatus(status: string) {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export const STATUS_LABELS: Record<string, string> = {
  created: "Created",
  policy_check: "Checking policy",
  queued: "Queued",
  scheduled: "Scheduled",
  dispatching: "Dispatching",
  notified: "Awaiting you",
  snoozed: "Snoozed",
  joining: "Joining",
  active: "In session",
  confirming: "Confirming",
  completed: "Completed",
  result_delivered: "Result delivered",
  result_acknowledged: "Agent resumed",
  policy_blocked: "Blocked",
  declined: "Declined",
  expired: "Expired",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function statusBadgeVariant(
  status: string,
): "default" | "active" | "urgent" | "success" | "danger" {
  if (["completed", "result_delivered", "result_acknowledged"].includes(status)) return "success";
  if (["active", "confirming", "joining"].includes(status)) return "active";
  if (status === "notified" || status === "snoozed") return "urgent";
  if (["declined", "failed", "policy_blocked", "expired", "cancelled"].includes(status)) return "danger";
  return "default";
}
