import type { CreateSessionInput, OpenConferConfig } from "@openconfer/schemas";

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
  code?: string;
}

function parseQuietHours(spec: string): { start: number; end: number } | null {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(spec);
  if (!match) return null;
  return {
    start: Number(match[1]) * 60 + Number(match[2]),
    end: Number(match[3]) * 60 + Number(match[4]),
  };
}

export function isOperatorInQuietHours(
  timezone: string,
  quietHours?: string,
  at = new Date(),
): boolean {
  if (!quietHours) return false;
  const range = parseQuietHours(quietHours);
  if (!range) return false;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const current = hour * 60 + minute;
  if (range.start <= range.end) {
    return current >= range.start && current < range.end;
  }
  return current >= range.start || current < range.end;
}

/** Find the first non-quiet minute in absolute time, including across DST changes. */
export function nextOperatorQuietHoursEnd(
  timezone: string,
  quietHours: string | undefined,
  from = new Date(),
): Date | null {
  if (!isOperatorInQuietHours(timezone, quietHours, from)) return from;
  const cursor = new Date(from);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let minute = 0; minute < 26 * 60; minute++) {
    if (!isOperatorInQuietHours(timezone, quietHours, cursor)) return cursor;
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

export function evaluatePolicy(
  input: CreateSessionInput,
  config: OpenConferConfig,
): PolicyResult {
  if (!input.objective?.trim()) {
    return { allowed: false, reason: "Session objective is required", code: "missing_objective" };
  }
  if (!input.brief?.reason?.trim()) {
    return { allowed: false, reason: "Brief reason is required", code: "missing_brief" };
  }
  if (!input.result_schema || Object.keys(input.result_schema).length === 0) {
    return {
      allowed: false,
      reason: "Result schema is required",
      code: "missing_result_schema",
    };
  }
  const operatorId = input.participant.operator_id;
  const operator = config.operators[operatorId];
  if (!operator) {
    return {
      allowed: false,
      reason: `Unknown operator: ${operatorId}`,
      code: "unknown_operator",
    };
  }
  if (input.urgency !== "incident" && input.type !== "incident") {
    if (isOperatorInQuietHours(operator.timezone, operator.quiet_hours)) {
      return {
        allowed: false,
        reason: "Operator is in quiet hours",
        code: "quiet_hours",
      };
    }
  }
  if (input.type === "incident" && input.urgency !== "incident") {
    return {
      allowed: false,
      reason: "Incident sessions require incident urgency",
      code: "invalid_urgency",
    };
  }
  return { allowed: true };
}

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(agentId: string, maxPerHour = 20): PolicyResult {
  const now = Date.now();
  const entry = rateLimitMap.get(agentId);
  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(agentId, { count: 1, resetAt: now + 3600_000 });
    return { allowed: true };
  }
  if (entry.count >= maxPerHour) {
    return {
      allowed: false,
      reason: "Agent rate limit exceeded",
      code: "rate_limit",
    };
  }
  entry.count++;
  return { allowed: true };
}
