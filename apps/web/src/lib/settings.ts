export type LiveKitStatus = "ready" | "unreachable" | "not_configured";
/** @deprecated Prefer speaking_agent. */
export type OpenAIWorkerStatus = "ready" | "missing_key";
export type SpeakingAgentStatus = "ready" | "missing_credentials";
export type TwilioStatus = "ready" | "missing_config" | "needs_livekit_voice" | "not_enabled";
export type LiveKitCredentialSource = "none" | "local_defaults" | "custom";
export type SpeakingMode = "realtime" | "pipeline";
export type SpeakingPreset = "live" | "flexible" | "local" | "custom";

export type ProviderBlockView = {
  provider: string;
  model: string;
  voice?: string;
  base_url?: string;
  api_key_configured: boolean;
  api_key_preview?: string;
};

export type OperatorAlertsView = {
  style: "off" | "subtle" | "standard";
  sound: boolean;
  browser_notifications: boolean;
  snooze_minutes: number;
};

export type SettingsView = {
  config_path: string;
  server: {
    base_url: string;
    web_url: string;
    port: number;
    host: string;
  };
  routes: {
    default: {
      notify: string[];
      connect: string[];
      fallback: string[];
    };
  };
  conversation: {
    adapter: string;
    speaking_mode: SpeakingMode;
    preset: SpeakingPreset;
    model: string;
    voice: string;
    livekit_url?: string;
    livekit_public_url?: string;
    livekit_api_key_configured: boolean;
    livekit_api_secret_configured: boolean;
    livekit_api_key_preview?: string;
    livekit_credential_source?: LiveKitCredentialSource;
    openai_api_key_configured: boolean;
    openai_api_key_preview?: string;
    realtime: ProviderBlockView;
    stt: ProviderBlockView;
    llm: ProviderBlockView;
    tts: ProviderBlockView;
    speaking_summary: string;
    missing_credentials: string[];
  };
  telephony: {
    adapter: "twilio";
    twilio: {
      account_sid_configured: boolean;
      account_sid_preview?: string;
      auth_token_configured: boolean;
      auth_token_preview?: string;
      from_number?: string;
      destination_number?: string;
    };
  };
  operators: string[];
  operator?: {
    id: string;
    call_name?: string;
    timezone: string;
    quiet_hours?: string;
    alerts: OperatorAlertsView;
  };
  auth: {
    api_token_configured: boolean;
    api_token_preview?: string;
    webhook_secret_configured: boolean;
  };
  status: {
    livekit: LiveKitStatus;
    twilio: TwilioStatus;
    openai_worker: OpenAIWorkerStatus;
    speaking_agent?: SpeakingAgentStatus;
    voice_ready: boolean;
    restart_required: boolean;
  };
  hermes: {
    base_url: string;
    connect_command?: string;
    openclaw_connect_command?: string;
    skill_markdown?: string;
    skill_install_path?: string;
    env_export: string;
    skill_commands: string[];
  };
};

export function hermesSkillMarkdown(baseUrl: string): string {
  return `# Hermes ↔ OpenConfer

Use OpenConfer when you cannot proceed safely without human judgment.

## Immediate path

Setup is operator-owned. The operator has already run \`openconfer connect hermes\`,
which wrote the API credentials to \`~/.hermes/.env\` and installed this skill at
\`~/.hermes/skills/openconfer/SKILL.md\`. The CLI and environment are ready.

Do not inspect the repository or run setup/discovery commands. Call \`openconfer\`
through the shell tool. Never create or edit a session JSON file; pass the
payload directly with \`--stdin\`.

This is a CLI-only agent flow. Never open a browser, navigate to \`join_url\`, or
open the OpenConfer operator inbox. The returned \`join_url\` is for the
operator's separate inbox/notification flow; ignore it and continue with
\`session wait\`. Use \`HERMES_RUN_ID\` when Hermes supplies it; otherwise use a
fresh local run ID for this request. The operator provides no per-run values.

Expected API: \`${baseUrl}\`

## Create directly through the CLI

Use a task-specific \`decision_key\`; reuse it only for retries of the exact same
decision.

\`\`\`bash
run_id="\${HERMES_RUN_ID:-hermes-local-$(date +%s)-$$}"
decision_key="<short-task-specific-key>-v1"
idempotency_key="hermes:\${run_id}:\${decision_key}"
openconfer session create --stdin --json <<JSON
{
  "type": "decision",
  "initiator": { "agent_id": "hermes", "harness": "hermes", "project": "openconfer" },
  "participant": { "operator_id": "me" },
  "objective": "<one sentence describing the decision needed>",
  "brief": {
    "reason": "<why work is blocked>",
    "completed": ["<relevant completed step>"],
    "recommendation": "<agent recommendation>",
    "options": [
      { "id": "<option-a>", "label": "<Option A>" },
      { "id": "<option-b>", "label": "<Option B>" }
    ]
  },
  "result_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["selected_option", "constraints"],
    "properties": {
      "selected_option": { "type": "string", "enum": ["<option-a>", "<option-b>", "defer"] },
      "constraints": { "type": "array", "items": { "type": "string" } }
    }
  },
  "routing": { "policy": "default" },
  "continuation": { "run_id": "\${run_id}", "opaque_token": "\${decision_key}" },
  "urgency": "normal",
  "estimated_duration_minutes": 3,
  "idempotency_key": "\${idempotency_key}"
}
JSON
\`\`\`

## Deterministic lifecycle

Keep the returned ID in agent task state, not a file. Wait, read only after a
completed status, verify/apply the structured result, and acknowledge only after
applying it:

\`\`\`bash
openconfer session wait SESSION_ID --json
openconfer session result SESSION_ID --json
# Apply the validated result before the next command.
openconfer session ack SESSION_ID --run-id RUN_ID --json
\`\`\`

## Terminal states and errors

- \`declined\`: stop and record that no decision was supplied; do not read or ack.
- \`expired\`: record the stale request; recreate only if still required, with a new key.
- \`cancelled\`: stop; do not acknowledge.
- \`failed\` or \`policy_blocked\`: surface the failure and stop; never invent a decision.
- Any command or HTTP/configuration error: preserve tool output and stop. Do not edit a payload file or retry with a fresh idempotency key.

## Environment

- \`OPENCONFER_BASE_URL\`
- \`OPENCONFER_API_TOKEN\`
- \`HERMES_RUN_ID\` (optional; supplied by Hermes when available)
- \`HERMES_STATE_DIR\` (optional)
`;
}

export type SettingsPatch = {
  server?: {
    base_url?: string;
    web_url?: string;
  };
  routes?: {
    default?: {
      notify?: string[];
      connect?: string[];
      fallback?: string[];
    };
  };
  conversation?: {
    adapter?: string;
    speaking_mode?: SpeakingMode;
    preset?: SpeakingPreset;
    model?: string;
    voice?: string;
    livekit_url?: string;
    livekit_public_url?: string;
    livekit_api_key?: string;
    livekit_api_secret?: string;
    openai_api_key?: string;
    realtime?: {
      provider?: string;
      model?: string;
      voice?: string;
      api_key?: string;
    };
    stt?: {
      provider?: string;
      model?: string;
      api_key?: string;
    };
    llm?: {
      provider?: string;
      model?: string;
      base_url?: string;
      api_key?: string;
    };
    tts?: {
      provider?: string;
      model?: string;
      voice?: string;
      api_key?: string;
    };
  };
  telephony?: {
    adapter?: "twilio";
    twilio?: {
      account_sid?: string;
      auth_token?: string;
      from_number?: string;
      destination_number?: string;
    };
  };
  operators?: Record<
    string,
    {
      call_name?: string;
      timezone?: string;
      quiet_hours?: string | null;
      alerts?: Partial<OperatorAlertsView>;
    }
  >;
};

export async function fetchSettings(token: string): Promise<SettingsView> {
  const res = await fetch("/v1/settings", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new Error("That API token was not accepted.");
  if (!res.ok) throw new Error("Could not load settings.");
  return res.json();
}

export async function patchSettings(token: string, patch: SettingsPatch): Promise<SettingsView> {
  const res = await fetch("/v1/settings", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : "Could not save settings.");
  }
  return res.json();
}

export async function rotateApiToken(token: string): Promise<{ api_token: string; settings: SettingsView }> {
  const res = await fetch("/v1/settings/token/rotate", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Could not rotate API token.");
  return res.json();
}

export type DemoUseCase = "decision" | "briefing" | "standup" | "approval";

export const DEMO_USE_CASES: ReadonlyArray<{
  id: DemoUseCase;
  label: string;
  description: string;
}> = [
  {
    id: "decision",
    label: "Decision · Lunch choice",
    description: "Choose between clear options.",
  },
  {
    id: "briefing",
    label: "Briefing · Product launch",
    description: "Hear an update and call out what needs attention.",
  },
  {
    id: "standup",
    label: "Standup · Today's priority",
    description: "Turn a progress update into one team focus.",
  },
  {
    id: "approval",
    label: "Approval · Production deploy",
    description: "Approve, request changes, or defer a proposal.",
  },
];

export async function createDemoSession(
  token: string,
  useCase: DemoUseCase = "decision",
): Promise<{ id: string; join_url?: string; status: string }> {
  const res = await fetch("/v1/sessions/demo", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ use_case: useCase }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : "Could not start the sandbox test call.");
  }
  return res.json();
}

export async function cancelSession(token: string, sessionId: string): Promise<void> {
  const res = await fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : "Could not end this session.");
  }
}

async function sessionAction(
  token: string | undefined,
  joinToken: string | undefined,
  sessionId: string,
  action: "snooze" | "decline",
  body: Record<string, unknown> = {},
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (joinToken) headers["x-join-token"] = joinToken;
  const res = await fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/${action}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(
      typeof payload.error === "string" ? payload.error : `Could not ${action} this session.`,
    );
  }
}

export function snoozeSession(
  auth: { token?: string; joinToken?: string },
  sessionId: string,
  minutes: number,
): Promise<void> {
  return sessionAction(auth.token, auth.joinToken, sessionId, "snooze", { minutes });
}

export function declineSession(
  auth: { token?: string; joinToken?: string },
  sessionId: string,
  reason?: string,
): Promise<void> {
  return sessionAction(auth.token, auth.joinToken, sessionId, "decline", { reason });
}

export function joinPathFromUrl(joinUrl: string, options?: { autoJoin?: boolean }): string {
  try {
    const url = new URL(joinUrl, window.location.origin);
    if (options?.autoJoin) url.searchParams.set("autojoin", "1");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return joinUrl;
  }
}

/** Operator acknowledged they wired a harness (connect happens outside the browser). */
const AGENT_CONNECTED_KEY = "oc_agent_connected";

export function readAgentConnected(): boolean {
  try {
    return localStorage.getItem(AGENT_CONNECTED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeAgentConnected(connected: boolean): void {
  try {
    if (connected) localStorage.setItem(AGENT_CONNECTED_KEY, "1");
    else localStorage.removeItem(AGENT_CONNECTED_KEY);
  } catch {
    // Ignore quota / private-mode failures; UI state still updates in-memory.
  }
}

export function liveKitStatusLabel(
  status: LiveKitStatus,
  source: LiveKitCredentialSource = "none",
): string {
  switch (status) {
    case "ready":
      return source === "local_defaults" ? "Local LiveKit running" : "Room running";
    case "unreachable":
      return source === "local_defaults"
        ? "Local defaults set — LiveKit not running"
        : "Credentials saved — LiveKit not running";
    default:
      return "Room not configured";
  }
}

export function openaiStatusLabel(status: OpenAIWorkerStatus): string {
  return status === "ready" ? "Speaking agent ready" : "Speaking agent needs credentials";
}

export function speakingStatusLabel(
  status: SpeakingAgentStatus | OpenAIWorkerStatus | undefined,
): string {
  if (status === "ready") return "Speaking agent ready";
  return "Speaking agent needs credentials";
}
