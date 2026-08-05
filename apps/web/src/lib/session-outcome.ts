import type { ApiSession, JoinSession } from "./types";

export type OutcomeTone = "ok" | "bad" | "open";

export type SessionOutcome = {
  tone: OutcomeTone;
  label: string;
  variant: "default" | "active" | "urgent" | "success" | "danger";
  detail?: string;
  /** Short shape cue for inbox meta (e.g. "3 choices", "2 updates", "Approval"). */
  shapeCue?: string;
};

type OutcomeSession = Pick<
  ApiSession,
  "status" | "summary" | "result" | "type" | "brief" | "urgency"
>;

const OK_STATUSES = new Set(["completed", "result_delivered", "result_acknowledged"]);
const BAD_STATUSES = new Set(["cancelled", "failed", "declined", "expired", "policy_blocked"]);
const CHOICE_KEYS = ["choice", "decision", "option", "selected", "selected_option"] as const;

function humanizeKey(key: string): string {
  return key.replaceAll("_", " ");
}

function formatResultValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function resolveOptionLabel(
  value: unknown,
  options: Array<{ id: string; label: string }> | undefined,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const match = options?.find((option) => option.id === value || option.label === value);
  return match?.label ?? value.trim();
}

function choiceFromResult(
  result: Record<string, unknown> | undefined,
  options: Array<{ id: string; label: string }> | undefined,
): string | undefined {
  if (!result) return undefined;
  for (const key of CHOICE_KEYS) {
    if (!(key in result)) continue;
    const label = resolveOptionLabel(result[key], options);
    if (label) return label;
  }
  return undefined;
}

/** Light humanization of a decision-like result object. */
export function formatDecisionResult(
  result: Record<string, unknown> | undefined,
  options?: Array<{ id: string; label: string }>,
): string | undefined {
  if (!result) return undefined;
  const fromChoice = choiceFromResult(result, options);
  if (fromChoice) return fromChoice;

  const entries = Object.entries(result).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) return undefined;

  const parts: string[] = [];
  for (const [key, value] of entries) {
    const formatted = formatResultValue(value);
    if (!formatted) continue;
    parts.push(entries.length === 1 ? `${humanizeKey(key)}: ${formatted}` : `${humanizeKey(key)}: ${formatted}`);
    if (parts.length >= 2) break;
  }
  return parts.length ? parts.join(" · ") : undefined;
}

function formatApprovalResult(result: Record<string, unknown> | undefined): string | undefined {
  if (!result || typeof result.approved !== "boolean") return undefined;
  const notes = typeof result.notes === "string" ? result.notes.trim() : "";
  const base = result.approved ? "Approved" : "Rejected";
  if (notes && notes.length <= 80) return `${base} — ${notes}`;
  return base;
}

function formatBriefingResult(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) return undefined;
  const nextActions = stringList(result.next_actions);
  if (nextActions.length) return nextActions.slice(0, 2).join("; ");
  const decisions = stringList(result.decisions);
  if (decisions.length) return decisions.slice(0, 2).join("; ");
  return undefined;
}

function formatResultByType(session: OutcomeSession): string | undefined {
  const options = session.brief?.options;
  if (session.type === "approval") {
    return formatApprovalResult(session.result) ?? formatDecisionResult(session.result, options);
  }
  if (session.type === "briefing") {
    return formatBriefingResult(session.result) ?? formatDecisionResult(session.result, options);
  }
  // decision + incident share choice-oriented formatting
  return formatDecisionResult(session.result, options);
}

export function shapeCueForSession(
  session: Pick<JoinSession, "type" | "brief" | "urgency">,
): string | undefined {
  const options = session.brief?.options ?? [];
  if (options.length > 0) {
    const labels = options.map((option) => option.label.trim()).filter(Boolean);
    const joined = labels.join(" · ");
    if (labels.length >= 2 && labels.length <= 3 && joined.length <= 48) return joined;
    return `${options.length} choice${options.length === 1 ? "" : "s"}`;
  }
  const completed = session.brief?.completed ?? [];
  if (completed.length > 0) {
    return `${completed.length} update${completed.length === 1 ? "" : "s"}`;
  }
  if (session.type === "approval") return "Approval";
  if (session.urgency === "high" || session.urgency === "incident") return "Urgent";
  return undefined;
}

function okLabel(session: OutcomeSession): string {
  if (session.type === "approval") {
    if (typeof session.result?.approved === "boolean") {
      return session.result.approved ? "Approved" : "Rejected";
    }
    return "Confirmed";
  }
  if (session.type === "briefing") return "Synced";
  if (session.type === "incident") return "Resolved";
  return "Decided";
}

function emptyDetail(session: OutcomeSession, tone: OutcomeTone): string | undefined {
  if (tone === "bad") {
    if (session.type === "approval") return "No approval recorded";
    if (session.type === "briefing") return "No sync recorded";
    return "No decision recorded";
  }
  if (tone === "ok") {
    if (session.type === "approval") return "Approval recorded";
    if (session.type === "briefing") return "Priorities confirmed";
    if (session.type === "incident") return "Incident resolved";
    return "Decision recorded";
  }
  return undefined;
}

function outcomeLabel(session: OutcomeSession, tone: OutcomeTone): string {
  const { status } = session;
  if (tone === "ok") return okLabel(session);
  if (status === "cancelled") return "Cancelled";
  if (status === "failed" || status === "policy_blocked") return "Failed";
  if (status === "declined") return "Declined";
  if (status === "expired") return "Expired";
  if (status === "notified") return "Waiting";
  if (status === "snoozed") return "Snoozed";
  if (["joining", "active", "confirming"].includes(status)) return "In progress";
  if (tone === "open") return "In progress";
  return status.replaceAll("_", " ");
}

function outcomeVariant(tone: OutcomeTone, status: string, urgency?: string): SessionOutcome["variant"] {
  if (tone === "ok") return "success";
  if (tone === "bad") return "danger";
  if (status === "notified" || status === "snoozed" || urgency === "high" || urgency === "incident") {
    return "urgent";
  }
  if (["joining", "active", "confirming"].includes(status)) return "active";
  return "default";
}

/** Humanized result/summary line for inbox and post-session recap. */
export function formatSessionDetail(session: OutcomeSession): string | undefined {
  const summary = typeof session.summary === "string" ? session.summary.trim() : "";
  if (summary) return summary;
  return formatResultByType(session);
}

export function sessionOutcome(session: OutcomeSession): SessionOutcome {
  const { status } = session;
  const tone: OutcomeTone = OK_STATUSES.has(status)
    ? "ok"
    : BAD_STATUSES.has(status)
      ? "bad"
      : "open";

  const label = outcomeLabel(session, tone);
  const variant = outcomeVariant(tone, status, session.urgency);
  const shapeCue = shapeCueForSession(session);

  if (tone === "open") {
    return { tone, label, variant, shapeCue };
  }

  const detail = formatSessionDetail(session) ?? emptyDetail(session, tone);
  return { tone, label, variant, detail, shapeCue };
}
