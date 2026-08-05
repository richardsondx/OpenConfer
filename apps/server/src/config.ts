import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ConfigSchema, type OpenConferConfig } from "@openconfer/schemas";
import { generateApiToken } from "@openconfer/auth-local";

export function expandPath(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function getConfigPath(): string {
  return process.env.OPENCONFER_CONFIG ?? join(homedir(), ".openconfer", "config.yaml");
}

export function getDefaultConfig(): OpenConferConfig {
  return ConfigSchema.parse({
    server: {
      base_url: "http://127.0.0.1:8787",
      web_url: "http://127.0.0.1:5173",
      port: 8787,
      host: "0.0.0.0",
    },
    storage: {
      adapter: "sqlite",
      path: "~/.openconfer/openconfer.db",
    },
    conversation: {
      adapter: "livekit",
      model: "gpt-realtime",
      voice: "marin",
      livekit_url: "ws://127.0.0.1:7880",
      livekit_public_url: "ws://127.0.0.1:7880",
      livekit_api_key: "devkey",
      livekit_api_secret: "secret",
    },
    telephony: {
      adapter: "twilio",
      twilio: {},
    },
    routes: {
      default: {
        notify: ["secure_link"],
        connect: ["browser"],
        fallback: [],
      },
    },
    operators: {
      me: { timezone: "UTC" },
    },
    auth: {},
  });
}

export function loadConfig(): OpenConferConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return getDefaultConfig();
  }
  const raw = readFileSync(configPath, "utf8");
  return ConfigSchema.parse(parseYaml(raw));
}

export function initConfig(): { path: string; token: string } {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const token = generateApiToken();
  const jwtSecret = generateApiToken();
  const config = getDefaultConfig();
  config.auth.api_token = token;
  const yaml = `# OpenConfer configuration
server:
  base_url: http://127.0.0.1:8787
  web_url: http://127.0.0.1:5173
  port: 8787
  host: 0.0.0.0

storage:
  adapter: sqlite
  path: ~/.openconfer/openconfer.db

conversation:
  adapter: livekit
  speaking_mode: realtime
  preset: live
  model: gpt-realtime
  voice: marin
  livekit_url: ws://127.0.0.1:7880
  livekit_public_url: ws://127.0.0.1:7880
  livekit_api_key: devkey
  livekit_api_secret: secret
  realtime:
    provider: openai
    model: gpt-realtime
    voice: marin

telephony:
  adapter: twilio
  twilio: {}

routes:
  default:
    notify:
      - secure_link
    connect:
      - browser
    fallback: []

operators:
  me:
    timezone: UTC

auth:
  api_token: ${token}
  jwt_secret: ${jwtSecret}
`;
  writeFileSync(configPath, yaml, { encoding: "utf8", mode: 0o600 });
  return { path: configPath, token };
}

export function getDbPath(config: OpenConferConfig): string {
  return expandPath(config.storage.path);
}

/** Persist config to the active YAML path (mode 0600). */
export function writeConfig(config: OpenConferConfig): string {
  const parsed = ConfigSchema.parse(config);
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const c = parsed.conversation;
  const doc = {
    server: parsed.server,
    storage: parsed.storage,
    conversation: {
      adapter: c.adapter,
      speaking_mode: c.speaking_mode,
      preset: c.preset,
      model: c.model,
      voice: c.voice,
      ...(c.livekit_url ? { livekit_url: c.livekit_url } : {}),
      ...(c.livekit_public_url ? { livekit_public_url: c.livekit_public_url } : {}),
      ...(c.livekit_api_key ? { livekit_api_key: c.livekit_api_key } : {}),
      ...(c.livekit_api_secret ? { livekit_api_secret: c.livekit_api_secret } : {}),
      ...(c.openai_api_key ? { openai_api_key: c.openai_api_key } : {}),
      realtime: {
        provider: c.realtime.provider,
        model: c.realtime.model,
        voice: c.realtime.voice,
        ...(c.realtime.api_key ? { api_key: c.realtime.api_key } : {}),
      },
      stt: {
        provider: c.stt.provider,
        model: c.stt.model,
        ...(c.stt.api_key ? { api_key: c.stt.api_key } : {}),
      },
      llm: {
        provider: c.llm.provider,
        model: c.llm.model,
        ...(c.llm.base_url ? { base_url: c.llm.base_url } : {}),
        ...(c.llm.api_key ? { api_key: c.llm.api_key } : {}),
      },
      tts: {
        provider: c.tts.provider,
        model: c.tts.model,
        voice: c.tts.voice,
        ...(c.tts.api_key ? { api_key: c.tts.api_key } : {}),
      },
    },
    ...(parsed.telephony
      ? {
          telephony: {
            adapter: parsed.telephony.adapter,
            twilio: {
              ...(parsed.telephony.twilio.account_sid
                ? { account_sid: parsed.telephony.twilio.account_sid }
                : {}),
              ...(parsed.telephony.twilio.auth_token
                ? { auth_token: parsed.telephony.twilio.auth_token }
                : {}),
              ...(parsed.telephony.twilio.from_number
                ? { from_number: parsed.telephony.twilio.from_number }
                : {}),
              ...(parsed.telephony.twilio.destination_number
                ? { destination_number: parsed.telephony.twilio.destination_number }
                : {}),
            },
          },
        }
      : {}),
    routes: parsed.routes,
    operators: parsed.operators,
    auth: {
      ...(parsed.auth.api_token ? { api_token: parsed.auth.api_token } : {}),
      ...(parsed.auth.jwt_secret ? { jwt_secret: parsed.auth.jwt_secret } : {}),
      ...(parsed.auth.webhook_secret ? { webhook_secret: parsed.auth.webhook_secret } : {}),
    },
  };

  const yaml = `# OpenConfer configuration\n${stringifyYaml(doc)}`;
  writeFileSync(configPath, yaml, { encoding: "utf8", mode: 0o600 });
  return configPath;
}
