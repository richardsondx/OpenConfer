import type { OpenConferConfig, OperatorAlerts, SettingsPatch, SpeakingPreset } from "@openconfer/schemas";
import {
  applySpeakingPreset,
  DEFAULT_OPERATOR_ALERTS,
  missingSpeakingCredentials,
  normalizeSpeakingFields,
  resolveRealtimeApiKey,
  resolveSpeakingReady,
  resolveSttApiKey,
  resolveLlmApiKey,
  resolveTtsApiKey,
  speakingSummary,
} from "@openconfer/schemas";
import { getConfigPath, writeConfig } from "./config.js";

function ensureSpeakingShape(config: OpenConferConfig): OpenConferConfig {
  const speaking = normalizeSpeakingFields(config.conversation);
  return {
    ...config,
    conversation: {
      ...config.conversation,
      ...speaking,
    },
  };
}

export type LiveKitStatus = "ready" | "unreachable" | "not_configured";
/** @deprecated Prefer speaking_agent — kept for older clients. */
export type OpenAIWorkerStatus = "ready" | "missing_key";
export type SpeakingAgentStatus = "ready" | "missing_credentials";
export type TwilioStatus = "ready" | "missing_config" | "needs_livekit_voice" | "not_enabled";
/** Where LiveKit credentials came from — local serve defaults are not "user pasted keys". */
export type LiveKitCredentialSource = "none" | "local_defaults" | "custom";

export const SETTINGS_SECRET_NAMES = [
  "twilio_account_sid",
  "twilio_auth_token",
  "realtime_api_key",
  "stt_api_key",
  "llm_api_key",
  "tts_api_key",
  "livekit_api_key",
  "livekit_api_secret",
] as const;

export type SettingsSecretName = (typeof SETTINGS_SECRET_NAMES)[number];

/** Matches apps/cli local LiveKit --dev container credentials. */
export const LOCAL_LIVEKIT_DEFAULTS = {
  url: "ws://127.0.0.1:7880",
  publicUrl: "ws://127.0.0.1:7880",
  apiKey: "devkey",
  apiSecret: "secret",
} as const;

export type SettingsView = {
  config_path: string;
  server: {
    base_url: string;
    web_url: string;
    port: number;
    host: string;
  };
  routes: OpenConferConfig["routes"];
  conversation: {
    adapter: string;
    speaking_mode: OpenConferConfig["conversation"]["speaking_mode"];
    preset: OpenConferConfig["conversation"]["preset"];
    model: string;
    voice: string;
    livekit_url?: string;
    livekit_public_url?: string;
    livekit_api_key_configured: boolean;
    livekit_api_secret_configured: boolean;
    livekit_api_key_preview?: string;
    /** none | local_defaults (serve wrote devkey) | custom (user/Cloud). */
    livekit_credential_source: LiveKitCredentialSource;
    openai_api_key_configured: boolean;
    openai_api_key_preview?: string;
    realtime: {
      provider: string;
      model: string;
      voice: string;
      api_key_configured: boolean;
      api_key_preview?: string;
    };
    stt: {
      provider: string;
      model: string;
      api_key_configured: boolean;
      api_key_preview?: string;
    };
    llm: {
      provider: string;
      model: string;
      base_url?: string;
      api_key_configured: boolean;
      api_key_preview?: string;
    };
    tts: {
      provider: string;
      model: string;
      voice: string;
      api_key_configured: boolean;
      api_key_preview?: string;
    };
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
  /** Primary operator (me) alert / quiet-hours preferences. */
  operator: {
    id: string;
    call_name?: string;
    timezone: string;
    quiet_hours?: string;
    alerts: OperatorAlerts;
  };
  auth: {
    api_token_configured: boolean;
    api_token_preview?: string;
    webhook_secret_configured: boolean;
  };
  status: {
    livekit: LiveKitStatus;
    twilio: TwilioStatus;
    /** @deprecated Prefer speaking_agent. */
    openai_worker: OpenAIWorkerStatus;
    speaking_agent: SpeakingAgentStatus;
    /** True when LiveKit room is ready and the selected speaking preset has credentials. */
    voice_ready: boolean;
    restart_required: boolean;
  };
  hermes: {
    base_url: string;
    connect_command: string;
    openclaw_connect_command: string;
    claude_code_connect_command: string;
    codex_connect_command: string;
    skill_markdown: string;
    skill_install_path: string;
    env_export: string;
    skill_commands: string[];
  };
};

/** Consumer-facing Hermes skill preview (token stays out of the markdown). */
export function buildHermesSkillMarkdown(baseUrl: string): string {
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

function secretPreview(value: string | undefined): string | undefined {
  if (!value || value.length < 4) return undefined;
  return `…${value.slice(-4)}`;
}

function applySecretField(
  current: string | undefined,
  patch: string | undefined,
): string | undefined {
  if (patch === undefined) return current;
  if (patch === "") return undefined;
  return patch;
}

export function hasLiveKitCredentials(config: OpenConferConfig): boolean {
  return !!(
    config.conversation.livekit_url &&
    config.conversation.livekit_api_key &&
    config.conversation.livekit_api_secret
  );
}

function normalizeLiveKitUrl(url: string | undefined): string {
  return (url ?? "").trim().replace(/\/$/, "").toLowerCase();
}

/** True when config matches the local openconfer serve / Docker --dev defaults. */
export function isLocalLiveKitDefaults(config: OpenConferConfig): boolean {
  const url = normalizeLiveKitUrl(config.conversation.livekit_url);
  const publicUrl = normalizeLiveKitUrl(
    config.conversation.livekit_public_url ?? config.conversation.livekit_url,
  );
  const localUrl = normalizeLiveKitUrl(LOCAL_LIVEKIT_DEFAULTS.url);
  return (
    url === localUrl &&
    publicUrl === localUrl &&
    config.conversation.livekit_api_key === LOCAL_LIVEKIT_DEFAULTS.apiKey &&
    config.conversation.livekit_api_secret === LOCAL_LIVEKIT_DEFAULTS.apiSecret
  );
}

export function resolveLiveKitCredentialSource(config: OpenConferConfig): LiveKitCredentialSource {
  if (!hasLiveKitCredentials(config)) return "none";
  return isLocalLiveKitDefaults(config) ? "local_defaults" : "custom";
}

export function resolveOpenAiApiKey(config: OpenConferConfig): string | undefined {
  return resolveRealtimeApiKey(config.conversation);
}

/** Probe whether a LiveKit HTTP endpoint answers (ws → http). */
export async function probeLiveKit(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  const httpUrl = url.replace(/^ws/i, "http").replace(/\/$/, "") + "/";
  try {
    const res = await fetch(httpUrl, { signal: AbortSignal.timeout(1500) });
    // LiveKit may return 200 on / or 404 on unknown paths; either means the process is up.
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  }
}

export async function resolveLiveKitStatus(config: OpenConferConfig): Promise<LiveKitStatus> {
  if (!hasLiveKitCredentials(config)) return "not_configured";
  const reachable = await probeLiveKit(config.conversation.livekit_url);
  return reachable ? "ready" : "unreachable";
}

export function isSpeakingConfigured(config: OpenConferConfig): boolean {
  return resolveSpeakingReady(config.conversation) === "ready";
}

/** Resolve a saved credential only for the authenticated, explicit reveal endpoint. */
export function revealSettingsSecret(
  config: OpenConferConfig,
  name: SettingsSecretName,
): string | undefined {
  const conversation = ensureSpeakingShape(config).conversation;
  switch (name) {
    case "twilio_account_sid":
      return config.telephony?.twilio?.account_sid;
    case "twilio_auth_token":
      return config.telephony?.twilio?.auth_token;
    case "realtime_api_key":
      return resolveRealtimeApiKey(conversation);
    case "stt_api_key":
      return resolveSttApiKey(conversation.stt);
    case "llm_api_key": {
      const value = resolveLlmApiKey(conversation.llm);
      return value === "ollama" ? undefined : value;
    }
    case "tts_api_key":
      return resolveTtsApiKey(conversation.tts);
    case "livekit_api_key":
      return conversation.livekit_api_key;
    case "livekit_api_secret":
      return conversation.livekit_api_secret;
  }
}

export async function toSettingsView(config: OpenConferConfig): Promise<SettingsView> {
  config = ensureSpeakingShape(config);
  const notify = config.routes.default.notify;
  const twilioEnabled = notify.includes("twilio");
  const livekit = await resolveLiveKitStatus(config);
  const conversation = config.conversation;
  const speaking_agent = resolveSpeakingReady(conversation);
  const openaiKey = resolveRealtimeApiKey(conversation);
  const openai_worker: OpenAIWorkerStatus =
    speaking_agent === "ready" ? "ready" : "missing_key";
  const voice_ready = livekit === "ready" && speaking_agent === "ready";
  const twilio = config.telephony?.twilio;
  const twilioConfigured = !!(
    twilio?.account_sid &&
    twilio.auth_token &&
    twilio.from_number &&
    twilio.destination_number
  );
  const twilioStatus: TwilioStatus = !twilioEnabled
    ? "not_enabled"
    : !twilioConfigured
      ? "missing_config"
      : !voice_ready
        ? "needs_livekit_voice"
        : "ready";

  const sttKey = resolveSttApiKey(conversation.stt);
  const llmKey = resolveLlmApiKey(conversation.llm);
  const ttsKey = resolveTtsApiKey(conversation.tts);
  const realtimeKey = openaiKey;

  return {
    config_path: getConfigPath(),
    server: {
      base_url: config.server.base_url,
      web_url: config.server.web_url,
      port: config.server.port,
      host: config.server.host,
    },
    routes: config.routes,
    conversation: {
      adapter: conversation.adapter,
      speaking_mode: conversation.speaking_mode,
      preset: conversation.preset,
      model: conversation.model,
      voice: conversation.voice,
      livekit_url: conversation.livekit_url,
      livekit_public_url: conversation.livekit_public_url,
      livekit_api_key_configured: !!conversation.livekit_api_key,
      livekit_api_secret_configured: !!conversation.livekit_api_secret,
      livekit_api_key_preview: secretPreview(conversation.livekit_api_key),
      livekit_credential_source: resolveLiveKitCredentialSource(config),
      openai_api_key_configured: !!realtimeKey,
      openai_api_key_preview: secretPreview(realtimeKey),
      realtime: {
        provider: conversation.realtime.provider,
        model: conversation.realtime.model,
        voice: conversation.realtime.voice,
        api_key_configured: !!realtimeKey,
        api_key_preview: secretPreview(realtimeKey),
      },
      stt: {
        provider: conversation.stt.provider,
        model: conversation.stt.model,
        api_key_configured: !!sttKey,
        api_key_preview: secretPreview(conversation.stt.api_key ?? sttKey),
      },
      llm: {
        provider: conversation.llm.provider,
        model: conversation.llm.model,
        base_url: conversation.llm.base_url,
        api_key_configured: conversation.llm.provider === "ollama" ? true : !!llmKey,
        api_key_preview: secretPreview(conversation.llm.api_key ?? (llmKey !== "ollama" ? llmKey : undefined)),
      },
      tts: {
        provider: conversation.tts.provider,
        model: conversation.tts.model,
        voice: conversation.tts.voice,
        api_key_configured: !!ttsKey,
        api_key_preview: secretPreview(conversation.tts.api_key ?? ttsKey),
      },
      speaking_summary: speakingSummary(conversation),
      missing_credentials: missingSpeakingCredentials(conversation),
    },
    telephony: {
      adapter: "twilio",
      twilio: {
        account_sid_configured: !!twilio?.account_sid,
        account_sid_preview: secretPreview(twilio?.account_sid),
        auth_token_configured: !!twilio?.auth_token,
        auth_token_preview: secretPreview(twilio?.auth_token),
        from_number: twilio?.from_number,
        destination_number: twilio?.destination_number,
      },
    },
    operators: Object.keys(config.operators),
    operator: (() => {
      const id = config.operators.me ? "me" : (Object.keys(config.operators)[0] ?? "me");
      const op = config.operators[id];
      const alerts = op?.alerts;
      return {
        id,
        call_name: op?.call_name,
        timezone: op?.timezone ?? "UTC",
        quiet_hours: op?.quiet_hours,
        alerts: {
          ...DEFAULT_OPERATOR_ALERTS,
          ...(alerts ?? {}),
          snooze_minutes: alerts?.snooze_minutes ?? DEFAULT_OPERATOR_ALERTS.snooze_minutes,
        },
      };
    })(),
    auth: {
      api_token_configured: !!config.auth.api_token,
      api_token_preview: secretPreview(config.auth.api_token),
      webhook_secret_configured: !!config.auth.webhook_secret,
    },
    status: {
      livekit,
      twilio: twilioStatus,
      openai_worker,
      speaking_agent,
      voice_ready,
      restart_required: false,
    },
    hermes: {
      base_url: config.server.base_url,
      connect_command: "openconfer connect hermes",
      openclaw_connect_command: "openconfer connect openclaw",
      claude_code_connect_command: "openconfer connect claude-code",
      codex_connect_command: "openconfer connect codex",
      skill_markdown: buildHermesSkillMarkdown(config.server.base_url),
      skill_install_path: "~/.hermes/skills/openconfer/SKILL.md",
      env_export: [
        `export OPENCONFER_BASE_URL="${config.server.base_url}"`,
        `export OPENCONFER_API_TOKEN="<your-api-token>"`,
      ].join("\n"),
      skill_commands: [
        "command -v openconfer",
        "openconfer doctor",
        "openconfer session create --stdin --json",
        "openconfer session wait SESSION_ID --json",
        "openconfer session result SESSION_ID --json",
        "openconfer session ack SESSION_ID --run-id HERMES_RUN_ID --json",
      ],
    },
  };
}

export function applySettingsPatch(
  current: OpenConferConfig,
  patch: SettingsPatch,
): { config: OpenConferConfig; restartRequired: boolean } {
  const next: OpenConferConfig = structuredClone(ensureSpeakingShape(current));
  let restartRequired = false;

  if (patch.server?.base_url !== undefined) {
    next.server.base_url = patch.server.base_url;
  }
  if (patch.server?.web_url !== undefined) {
    next.server.web_url = patch.server.web_url;
  }

  if (patch.routes?.default) {
    if (patch.routes.default.notify) {
      next.routes.default.notify = patch.routes.default.notify;
    }
    if (patch.routes.default.connect) {
      next.routes.default.connect = patch.routes.default.connect;
    }
    if (patch.routes.default.fallback) {
      next.routes.default.fallback = patch.routes.default.fallback;
    }
  }

  if (patch.conversation) {
    const c = patch.conversation;
    if (c.adapter !== undefined) next.conversation.adapter = c.adapter;

    if (c.preset !== undefined) {
      const applied = applySpeakingPreset(c.preset as SpeakingPreset, next.conversation);
      next.conversation.speaking_mode = applied.speaking_mode;
      next.conversation.preset = applied.preset;
      next.conversation.realtime = applied.realtime;
      next.conversation.stt = applied.stt;
      next.conversation.llm = applied.llm;
      next.conversation.tts = applied.tts;
      next.conversation.model = applied.model;
      next.conversation.voice = applied.voice;
      if (applied.openai_api_key !== undefined) {
        next.conversation.openai_api_key = applied.openai_api_key;
      }
      restartRequired = true;
    }

    if (c.speaking_mode !== undefined) {
      next.conversation.speaking_mode = c.speaking_mode;
      if (c.preset === undefined) next.conversation.preset = "custom";
      restartRequired = true;
    }

    if (c.livekit_url !== undefined) {
      next.conversation.livekit_url = c.livekit_url || undefined;
    }
    if (c.livekit_public_url !== undefined) {
      next.conversation.livekit_public_url = c.livekit_public_url || undefined;
    }
    if (c.livekit_api_key !== undefined) {
      next.conversation.livekit_api_key = applySecretField(
        current.conversation.livekit_api_key,
        c.livekit_api_key,
      );
    }
    if (c.livekit_api_secret !== undefined) {
      next.conversation.livekit_api_secret = applySecretField(
        current.conversation.livekit_api_secret,
        c.livekit_api_secret,
      );
    }

    if (c.realtime) {
      if (c.realtime.provider === "openai" || c.realtime.provider === undefined) {
        next.conversation.realtime.provider = "openai";
      }
      if (c.realtime.model !== undefined) {
        next.conversation.realtime.model = c.realtime.model;
        next.conversation.model = c.realtime.model;
        restartRequired = true;
      }
      if (c.realtime.voice !== undefined) {
        next.conversation.realtime.voice = c.realtime.voice;
        next.conversation.voice = c.realtime.voice;
        restartRequired = true;
      }
      if (c.realtime.api_key !== undefined) {
        next.conversation.realtime.api_key = applySecretField(
          current.conversation.realtime.api_key ?? current.conversation.openai_api_key,
          c.realtime.api_key,
        );
        next.conversation.openai_api_key = next.conversation.realtime.api_key;
        restartRequired = true;
      }
      if (c.preset === undefined) next.conversation.preset = "custom";
    }

    // Legacy flat fields → realtime
    if (c.model !== undefined) {
      next.conversation.model = c.model;
      next.conversation.realtime.model = c.model;
      restartRequired = true;
    }
    if (c.voice !== undefined) {
      next.conversation.voice = c.voice;
      next.conversation.realtime.voice = c.voice;
      restartRequired = true;
    }
    if (c.openai_api_key !== undefined) {
      next.conversation.openai_api_key = applySecretField(
        current.conversation.openai_api_key ?? current.conversation.realtime.api_key,
        c.openai_api_key,
      );
      next.conversation.realtime.api_key = next.conversation.openai_api_key;
      restartRequired = true;
    }

    if (c.stt) {
      if (c.stt.provider === "deepgram" || c.stt.provider === "openai") {
        next.conversation.stt.provider = c.stt.provider;
        restartRequired = true;
      }
      if (c.stt.model !== undefined) {
        next.conversation.stt.model = c.stt.model;
        restartRequired = true;
      }
      if (c.stt.api_key !== undefined) {
        next.conversation.stt.api_key = applySecretField(current.conversation.stt.api_key, c.stt.api_key);
        restartRequired = true;
      }
      if (c.preset === undefined) next.conversation.preset = "custom";
    }

    if (c.llm) {
      if (c.llm.provider === "openrouter" || c.llm.provider === "openai" || c.llm.provider === "ollama") {
        next.conversation.llm.provider = c.llm.provider;
        restartRequired = true;
      }
      if (c.llm.model !== undefined) {
        next.conversation.llm.model = c.llm.model;
        restartRequired = true;
      }
      if (c.llm.base_url !== undefined) {
        next.conversation.llm.base_url = c.llm.base_url || undefined;
        restartRequired = true;
      }
      if (c.llm.api_key !== undefined) {
        next.conversation.llm.api_key = applySecretField(current.conversation.llm.api_key, c.llm.api_key);
        restartRequired = true;
      }
      if (c.preset === undefined) next.conversation.preset = "custom";
    }

    if (c.tts) {
      if (c.tts.provider === "cartesia" || c.tts.provider === "elevenlabs" || c.tts.provider === "openai") {
        next.conversation.tts.provider = c.tts.provider;
        restartRequired = true;
      }
      if (c.tts.model !== undefined) {
        next.conversation.tts.model = c.tts.model;
        restartRequired = true;
      }
      if (c.tts.voice !== undefined) {
        next.conversation.tts.voice = c.tts.voice;
        restartRequired = true;
      }
      if (c.tts.api_key !== undefined) {
        next.conversation.tts.api_key = applySecretField(current.conversation.tts.api_key, c.tts.api_key);
        restartRequired = true;
      }
      if (c.preset === undefined) next.conversation.preset = "custom";
    }
  }

  if (patch.telephony) {
    const currentTwilio = current.telephony?.twilio ?? {};
    const twilioPatch = patch.telephony.twilio;
    next.telephony = {
      adapter: "twilio",
      twilio: {
        ...currentTwilio,
        ...(twilioPatch?.account_sid !== undefined
          ? { account_sid: applySecretField(currentTwilio.account_sid, twilioPatch.account_sid) }
          : {}),
        ...(twilioPatch?.auth_token !== undefined
          ? { auth_token: applySecretField(currentTwilio.auth_token, twilioPatch.auth_token) }
          : {}),
        ...(twilioPatch?.from_number !== undefined
          ? { from_number: twilioPatch.from_number.trim() || undefined }
          : {}),
        ...(twilioPatch?.destination_number !== undefined
          ? { destination_number: twilioPatch.destination_number.trim() || undefined }
          : {}),
      },
    };
  }

  if (patch.operators) {
    for (const [operatorId, patchOp] of Object.entries(patch.operators)) {
      const currentOp = next.operators[operatorId] ?? {
        timezone: "UTC",
        alerts: { ...DEFAULT_OPERATOR_ALERTS },
      };
      const nextAlerts = {
        ...DEFAULT_OPERATOR_ALERTS,
        ...(currentOp.alerts ?? {}),
        ...(patchOp.alerts ?? {}),
      };
      if (patchOp.alerts?.snooze_minutes !== undefined) {
        nextAlerts.snooze_minutes = patchOp.alerts.snooze_minutes;
      }
      next.operators[operatorId] = {
        call_name:
          patchOp.call_name !== undefined
            ? patchOp.call_name.trim() || undefined
            : currentOp.call_name,
        timezone: patchOp.timezone ?? currentOp.timezone,
        quiet_hours:
          patchOp.quiet_hours === null
            ? undefined
            : patchOp.quiet_hours !== undefined
              ? patchOp.quiet_hours
              : currentOp.quiet_hours,
        alerts: nextAlerts,
      };
    }
  }

  return { config: next, restartRequired };
}

export function persistConfig(config: OpenConferConfig): void {
  writeConfig(config);
}

const DEMO_SESSION_COMMON = {
  initiator: {
    agent_id: "openconfer-demo",
    harness: "web-ui",
    project: "sandbox",
  },
  participant: {
    operator_id: "me",
  },
  routing: { policy: "default" },
  estimated_duration_minutes: 3,
};

export const DEMO_SESSION_PAYLOADS = {
  decision: {
    ...DEMO_SESSION_COMMON,
    type: "decision" as const,
    objective: "Should we order pizza or tacos for lunch?",
    brief: {
      reason:
        "Sandbox decision — practice joining the LiveKit room and choosing between two clear options.",
      completed: [
        "Opened a practice session inside OpenConfer",
        "Skipped wiring Hermes or any external harness",
      ],
      recommendation: "Pizza feeds more people with fewer dietary surprises",
      options: [
        { id: "pizza", label: "Pizza" },
        { id: "tacos", label: "Tacos" },
      ],
      context:
        "This is a local sandbox. Your decision is recorded in OpenConfer only — nothing is sent to an agent.",
    },
    result_schema: {
      type: "object",
      required: ["selected_option", "constraints"],
      properties: {
        selected_option: { type: "string", enum: ["pizza", "tacos", "defer"] },
        constraints: { type: "array", items: { type: "string" } },
      },
    },
    urgency: "normal" as const,
  },
  briefing: {
    ...DEMO_SESSION_COMMON,
    type: "briefing" as const,
    objective: "What should I know before today's product launch?",
    brief: {
      reason: "Briefing — practice receiving a concise update and calling out what needs attention.",
      completed: ["Reviewed the launch checklist", "Collected the latest risk signals"],
      recommendation: "Start with the two open reliability items, then proceed with the launch.",
      options: [
        { id: "ready", label: "Ready to proceed" },
        { id: "follow_up", label: "Need a follow-up" },
        { id: "defer", label: "Defer the launch" },
      ],
      context:
        "This is a local sandbox. Your response is recorded in OpenConfer only — nothing is sent to an agent.",
    },
    result_schema: {
      type: "object",
      required: ["selected_option", "constraints"],
      properties: {
        selected_option: { type: "string", enum: ["ready", "follow_up", "defer"] },
        constraints: { type: "array", items: { type: "string" } },
      },
    },
    urgency: "normal" as const,
  },
  standup: {
    ...DEMO_SESSION_COMMON,
    type: "briefing" as const,
    objective: "What should the team focus on in today's standup?",
    brief: {
      reason: "Standup — practice turning a short progress update into one clear priority.",
      completed: ["Shipped the session API", "Built the browser client"],
      recommendation: "Focus on webhook reliability before adding another integration.",
      options: [
        { id: "reliability", label: "Webhook reliability" },
        { id: "integration", label: "New integration" },
        { id: "review", label: "Review both" },
      ],
      context:
        "This is a local sandbox. Your response is recorded in OpenConfer only — nothing is sent to an agent.",
    },
    result_schema: {
      type: "object",
      required: ["selected_option", "constraints"],
      properties: {
        selected_option: { type: "string", enum: ["reliability", "integration", "review", "defer"] },
        constraints: { type: "array", items: { type: "string" } },
      },
    },
    urgency: "normal" as const,
  },
  approval: {
    ...DEMO_SESSION_COMMON,
    type: "approval" as const,
    objective: "Should we approve the proposed production deploy?",
    brief: {
      reason: "Approval — practice reviewing a recommendation and approving, revising, or deferring it.",
      completed: ["Passed the automated checks", "Prepared the deployment plan"],
      recommendation: "Approve the deploy after confirming the rollback owner is available.",
      options: [
        { id: "approve", label: "Approve" },
        { id: "changes", label: "Request changes" },
        { id: "defer", label: "Defer" },
      ],
      context:
        "This is a local sandbox. Your response is recorded in OpenConfer only — nothing is sent to an agent.",
    },
    result_schema: {
      type: "object",
      required: ["selected_option", "constraints"],
      properties: {
        selected_option: { type: "string", enum: ["approve", "changes", "defer"] },
        constraints: { type: "array", items: { type: "string" } },
      },
    },
    urgency: "normal" as const,
  },
} as const;

/** Backwards-compatible default demo payload for callers that import it directly. */
export const DEMO_SESSION_PAYLOAD = DEMO_SESSION_PAYLOADS.decision;
