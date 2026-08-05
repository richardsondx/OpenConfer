import type { CapturedContext } from "./types";

export type UnderstoodDecision = {
  result?: Record<string, unknown>;
  summary?: string;
  captured_context?: CapturedContext;
  revision?: number;
};

export type DecisionSignal =
  | ({ kind: "preview" } & UnderstoodDecision)
  | ({ kind: "ok" } & Partial<UnderstoodDecision>)
  | { kind: "failed"; error?: string };

function asResult(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asSummary(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asCapturedContext(value: unknown): CapturedContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const context = value as Record<string, unknown>;
  return {
    steering: asStringList(context.steering),
    additional_instructions: asStringList(context.additional_instructions),
    new_requests: asStringList(context.new_requests),
    unresolved_topics: asStringList(context.unresolved_topics),
  };
}

/** Parse LiveKit data payloads published by the conversation worker. */
export function parseDecisionSignal(payload: Uint8Array | string): DecisionSignal | null {
  try {
    const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
    const data = JSON.parse(text) as {
      type?: unknown;
      status?: unknown;
      error?: unknown;
      result?: unknown;
      summary?: unknown;
      captured_context?: unknown;
      revision?: unknown;
    };
    if (data.type !== "openconfer.decision") return null;
    const result = asResult(data.result);
    const summary = asSummary(data.summary);
    const captured_context = asCapturedContext(data.captured_context);
    const revision = typeof data.revision === "number" ? data.revision : undefined;
    if (data.status === "preview") {
      if (!result && !captured_context) return null;
      return { kind: "preview", result, summary, captured_context, revision };
    }
    if (data.status === "ok") {
      return { kind: "ok", result, summary, captured_context, revision };
    }
    if (data.status === "failed") {
      return {
        kind: "failed",
        error: typeof data.error === "string" && data.error.trim() ? data.error.trim() : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}
