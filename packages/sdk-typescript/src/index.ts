import type { CreateSessionInput } from "@openconfer/schemas";

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
    return this.request<{ id: string; status: string; join_url?: string }>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getSession(id: string) {
    return this.request<Record<string, unknown>>(`/v1/sessions/${id}`);
  }

  listSessions() {
    return this.request<{ sessions: Record<string, unknown>[] }>("/v1/sessions");
  }

  cancelSession(id: string) {
    return this.request<Record<string, unknown>>(`/v1/sessions/${id}/cancel`, {
      method: "POST",
      body: "{}",
    });
  }

  acknowledgeResult(id: string, runId?: string) {
    return this.request<Record<string, unknown>>(`/v1/sessions/${id}/ack`, {
      method: "POST",
      body: JSON.stringify({ run_id: runId }),
    });
  }

  async waitForResult(
    id: string,
    opts?: { intervalMs?: number; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
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
