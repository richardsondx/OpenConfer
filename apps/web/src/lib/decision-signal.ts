export type UnderstoodDecision = {
  result: Record<string, unknown>;
  summary?: string;
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
    };
    if (data.type !== "openconfer.decision") return null;
    const result = asResult(data.result);
    const summary = asSummary(data.summary);
    if (data.status === "preview") {
      if (!result) return null;
      return { kind: "preview", result, summary };
    }
    if (data.status === "ok") {
      return { kind: "ok", result, summary };
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
