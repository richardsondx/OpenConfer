import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_CARTESIA_VOICE,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OPENROUTER_BASE_URL,
  missingSpeakingCredentials,
  normalizeSpeakingFields,
  resolveSpeakingReady,
  speakingSummary,
  type SpeakingConversationFields,
} from "@openconfer/schemas";

function configPath(): string {
  return process.env.OPENCONFER_CONFIG ?? join(homedir(), ".openconfer", "config.yaml");
}

type ServeConfig = {
  conversation?: Record<string, unknown>;
  server?: { base_url?: string };
  auth?: { api_token?: string };
};

function readServeConfig(): ServeConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  return parseYaml(readFileSync(path, "utf8")) as ServeConfig;
}

function resolveWorkerEntry(): string | null {
  // Prefer the source checkout worker when present — local `pnpm deploy` installs can
  // omit pipeline plugins, while the workspace tree always has the full dependency set.
  const sourceDirFile = join(homedir(), ".openconfer", "source-dir");
  const sourceCandidates: string[] = [];
  if (existsSync(sourceDirFile)) {
    try {
      const sourceDir = readFileSync(sourceDirFile, "utf8").trim();
      if (sourceDir) sourceCandidates.push(join(sourceDir, "apps/conversation-worker/dist/index.js"));
    } catch {
      // ignore unreadable marker
    }
  }
  sourceCandidates.push(
    join(process.cwd(), "apps/conversation-worker/dist/index.js"),
    join(fileURLToPath(new URL(".", import.meta.url)), "../../../conversation-worker/dist/index.js"),
  );
  const fromSource = sourceCandidates.find((p) => existsSync(p));
  if (fromSource) return fromSource;

  try {
    const pkgPath = fileURLToPath(import.meta.resolve("@openconfer/conversation-worker/package.json"));
    const entry = join(dirname(pkgPath), "dist", "index.js");
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

function speakingFromConfig(raw: Record<string, unknown> | undefined): SpeakingConversationFields {
  return normalizeSpeakingFields(raw ?? {});
}

/**
 * Start the LiveKit Agents speaking worker for the configured preset.
 * Returns null when the speaking agent cannot start (missing credentials / build).
 */
export function startVoiceWorker(): { child: ChildProcess; message: string } | { child: null; message: string } {
  const serveConfig = readServeConfig();
  const speaking = speakingFromConfig(serveConfig.conversation);

  if (resolveSpeakingReady(speaking) !== "ready") {
    const missing = missingSpeakingCredentials(speaking);
    return {
      child: null,
      message:
        missing.length > 0
          ? `Speaking agent off — missing ${missing.join(", ")}. Configure Settings → Voice, then restart openconfer serve.`
          : "Speaking agent off — configure Settings → Voice, then restart openconfer serve.",
    };
  }

  const entry = resolveWorkerEntry();
  if (!entry) {
    return {
      child: null,
      message:
        "Speaking agent off — conversation worker build missing. Run pnpm build, then openconfer serve again.",
    };
  }

  const conversation = serveConfig.conversation ?? {};
  const livekitUrl =
    (typeof conversation.livekit_url === "string" && conversation.livekit_url) ||
    process.env.LIVEKIT_URL ||
    "ws://127.0.0.1:7880";
  const livekitKey =
    (typeof conversation.livekit_api_key === "string" && conversation.livekit_api_key) ||
    process.env.LIVEKIT_API_KEY ||
    "devkey";
  const livekitSecret =
    (typeof conversation.livekit_api_secret === "string" && conversation.livekit_api_secret) ||
    process.env.LIVEKIT_API_SECRET ||
    "secret";
  const agentName = process.env.OPENCONFER_VOICE_AGENT_NAME || "openconfer-conversation";
  const baseUrl =
    process.env.OPENCONFER_BASE_URL || serveConfig.server?.base_url || "http://127.0.0.1:8787";
  const apiToken = process.env.OPENCONFER_API_TOKEN || serveConfig.auth?.api_token;

  const realtimeKey = speaking.realtime.api_key || speaking.openai_api_key || process.env.OPENAI_API_KEY;

  const child = spawn("node", [entry, "start"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      OPENCONFER_SPEAKING_MODE: speaking.speaking_mode,
      OPENCONFER_SPEAKING_PRESET: speaking.preset,
      OPENAI_API_KEY: realtimeKey || process.env.OPENAI_API_KEY || "",
      OPENAI_REALTIME_MODEL: speaking.realtime.model,
      OPENAI_VOICE: speaking.realtime.voice,
      OPENCONFER_REALTIME_MODEL: speaking.realtime.model,
      OPENCONFER_REALTIME_VOICE: speaking.realtime.voice,
      ...(speaking.realtime.api_key || speaking.openai_api_key
        ? { OPENCONFER_REALTIME_API_KEY: speaking.realtime.api_key || speaking.openai_api_key }
        : {}),
      OPENCONFER_STT_PROVIDER: speaking.stt.provider,
      OPENCONFER_STT_MODEL: speaking.stt.model,
      ...(speaking.stt.api_key
        ? { OPENCONFER_STT_API_KEY: speaking.stt.api_key, DEEPGRAM_API_KEY: speaking.stt.api_key }
        : {}),
      OPENCONFER_LLM_PROVIDER: speaking.llm.provider,
      OPENCONFER_LLM_MODEL: speaking.llm.model,
      OPENCONFER_LLM_BASE_URL:
        speaking.llm.base_url ||
        (speaking.llm.provider === "ollama"
          ? DEFAULT_OLLAMA_BASE_URL
          : speaking.llm.provider === "openrouter"
            ? DEFAULT_OPENROUTER_BASE_URL
            : ""),
      ...(speaking.llm.api_key
        ? {
            OPENCONFER_LLM_API_KEY: speaking.llm.api_key,
            ...(speaking.llm.provider === "openrouter"
              ? { OPENROUTER_API_KEY: speaking.llm.api_key }
              : {}),
          }
        : {}),
      OPENCONFER_TTS_PROVIDER: speaking.tts.provider,
      OPENCONFER_TTS_MODEL: speaking.tts.model,
      OPENCONFER_TTS_VOICE: speaking.tts.voice || DEFAULT_CARTESIA_VOICE,
      ...(speaking.tts.api_key
        ? {
            OPENCONFER_TTS_API_KEY: speaking.tts.api_key,
            ...(speaking.tts.provider === "cartesia"
              ? { CARTESIA_API_KEY: speaking.tts.api_key }
              : {}),
            ...(speaking.tts.provider === "elevenlabs"
              ? { ELEVEN_API_KEY: speaking.tts.api_key }
              : {}),
          }
        : {}),
      LIVEKIT_URL: livekitUrl,
      LIVEKIT_API_KEY: livekitKey,
      LIVEKIT_API_SECRET: livekitSecret,
      OPENCONFER_VOICE_AGENT_NAME: agentName,
      OPENCONFER_BASE_URL: baseUrl,
      ...(apiToken ? { OPENCONFER_API_TOKEN: apiToken } : {}),
    },
  });

  child.on("error", (error) => {
    console.error(`Speaking agent failed to start: ${error.message}`);
  });

  return {
    child,
    message: `Speaking agent starting (${speakingSummary(speaking)})`,
  };
}
