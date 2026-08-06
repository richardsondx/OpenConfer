import type { CapturedContext, CreateSessionInput, ContinuityPackage } from "@openconfer/schemas";

export type { CapturedContext, ContinuityPackage } from "@openconfer/schemas";

export interface OpenConferSessionResponse extends Record<string, unknown> {
  id: string;
  status: string;
  result?: Record<string, unknown>;
  captured_context?: CapturedContext;
  continuity?: ContinuityPackage;
  continuity_trace?: ContinuityTraceResponse;
  continuity_capsule?: ContinuityCapsuleResponse;
}

export interface PendingDecisionResponse {
  result: Record<string, unknown>;
  summary?: string;
  captured_context?: CapturedContext;
  revision: number;
  previewed_at: string;
}

export interface ContinuityCapsuleResponse {
  continuity_version: "1.0";
  summary: string;
  decisions: Record<string, unknown>;
  open_threads: string[];
  suggested_memory_updates: [];
  context_sources: string[];
}

export interface ContinuityTraceResponse {
  applied: string[];
  memory: "not_attempted" | "unavailable";
  degraded: boolean;
}

export interface OpenConferClientOptions {
  baseUrl: string;
  apiToken: string;
}

export class OpenConferClient {
  constructor(private opts: OpenConferClientOptions) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.opts.apiToken}`,
        ...init?.headers,
      },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(body));
    return body as T;
  }

  createSession(input: CreateSessionInput) {
    return this.request<OpenConferSessionResponse>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getSession(id: string) {
    return this.request<OpenConferSessionResponse>(`/v1/sessions/${id}`);
  }

  listSessions() {
    return this.request<{ sessions: OpenConferSessionResponse[] }>("/v1/sessions");
  }

  cancelSession(id: string) {
    return this.request<OpenConferSessionResponse>(`/v1/sessions/${id}/cancel`, {
      method: "POST",
      body: "{}",
    });
  }

  previewDecision(
    id: string,
    input: {
      result: Record<string, unknown>;
      summary?: string;
      captured_context?: CapturedContext;
      expected_revision?: number;
    },
  ) {
    return this.request<PendingDecisionResponse>(`/v1/sessions/${id}/preview`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  callAgain(id: string) {
    return this.request<OpenConferSessionResponse>(`/v1/sessions/${id}/phone/call`, {
      method: "POST",
      body: "{}",
    });
  }

  stopAutomaticCallbacks(id: string) {
    return this.request<OpenConferSessionResponse>(`/v1/sessions/${id}/phone/stop`, {
      method: "POST",
      body: "{}",
    });
  }

  acknowledgeResult(id: string, runId?: string) {
    return this.request<OpenConferSessionResponse>(`/v1/sessions/${id}/ack`, {
      method: "POST",
      body: JSON.stringify({ run_id: runId }),
    });
  }

  async waitForResult(
    id: string,
    opts?: { intervalMs?: number; timeoutMs?: number },
  ): Promise<OpenConferSessionResponse> {
    const interval = opts?.intervalMs ?? 2000;
    const timeout = opts?.timeoutMs ?? 600_000;
    const start = Date.now();
    const terminal = [
      "completed",
      "result_delivered",
      "result_acknowledged",
      "declined",
      "expired",
      "cancelled",
      "failed",
      "policy_blocked",
    ];
    while (Date.now() - start < timeout) {
      const session = await this.getSession(id);
      if (terminal.includes(session.status as string)) return session;
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error("Timeout waiting for session");
  }
}

export { OpenConferClient as default };
