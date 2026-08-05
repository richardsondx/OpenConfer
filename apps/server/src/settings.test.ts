import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenConferConfig } from "@openconfer/schemas";
import {
  applySettingsPatch,
  buildHermesSkillMarkdown,
  hasLiveKitCredentials,
  isLocalLiveKitDefaults,
  isSpeakingConfigured,
  LOCAL_LIVEKIT_DEFAULTS,
  probeLiveKit,
  resolveLiveKitCredentialSource,
  resolveLiveKitStatus,
  resolveOpenAiApiKey,
  toSettingsView,
} from "./settings.js";

function baseConfig(overrides: Partial<OpenConferConfig["conversation"]> = {}): OpenConferConfig {
  return {
    server: {
      base_url: "http://127.0.0.1:8787",
      web_url: "http://127.0.0.1:5173",
      port: 8787,
      host: "127.0.0.1",
    },
    storage: { adapter: "sqlite", path: "/tmp/oc.db" },
    conversation: {
      adapter: "livekit",
      speaking_mode: "realtime",
      preset: "live",
      model: "gpt-realtime",
      voice: "marin",
      realtime: { provider: "openai", model: "gpt-realtime", voice: "marin" },
      stt: { provider: "deepgram", model: "nova-3" },
      llm: { provider: "openrouter", model: "openai/gpt-4o-mini", base_url: "https://openrouter.ai/api/v1" },
      tts: {
        provider: "cartesia",
        model: "sonic-3",
        voice: "f786b574-daa5-4673-aa0c-cbe3e8534c02",
      },
      ...overrides,
    },
    routes: { default: { notify: ["secure_link"], connect: ["browser"], fallback: [] } },
    operators: { me: { timezone: "UTC" } },
    auth: { api_token: "oc_test" },
  };
}

describe("voice settings status", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it("does not treat saved LiveKit credentials as ready without a probe", async () => {
    const config = baseConfig({
      livekit_url: "ws://127.0.0.1:7880",
      livekit_api_key: "devkey",
      livekit_api_secret: "secret",
    });
    expect(hasLiveKitCredentials(config)).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    expect(await resolveLiveKitStatus(config)).toBe("unreachable");
  });

  it("marks LiveKit ready only when the endpoint answers", async () => {
    const config = baseConfig({
      livekit_url: "ws://127.0.0.1:7880",
      livekit_api_key: "devkey",
      livekit_api_secret: "secret",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    expect(await probeLiveKit(config.conversation.livekit_url)).toBe(true);
    expect(await resolveLiveKitStatus(config)).toBe("ready");
  });

  it("resolves OpenAI key from config or env", () => {
    expect(resolveOpenAiApiKey(baseConfig())).toBeUndefined();
    expect(resolveOpenAiApiKey(baseConfig({ openai_api_key: "sk-from-config" }))).toBe("sk-from-config");
    process.env.OPENAI_API_KEY = "sk-from-env";
    expect(resolveOpenAiApiKey(baseConfig())).toBe("sk-from-env");
  });

  it("flags restart when OpenAI voice settings change", () => {
    const { restartRequired } = applySettingsPatch(baseConfig(), {
      conversation: { openai_api_key: "sk-new", model: "gpt-realtime", voice: "marin" },
    });
    expect(restartRequired).toBe(true);
  });

  it("applies flexible preset and reports speaking readiness", async () => {
    const { config, restartRequired } = applySettingsPatch(baseConfig(), {
      conversation: {
        preset: "flexible",
        stt: { api_key: "dg-key" },
        llm: { api_key: "or-key" },
        tts: { api_key: "cart-key" },
      },
    });
    expect(restartRequired).toBe(true);
    expect(config.conversation.speaking_mode).toBe("pipeline");
    expect(config.conversation.preset).toBe("flexible");
    expect(isSpeakingConfigured(config)).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const withRoom = {
      ...config,
      conversation: {
        ...config.conversation,
        livekit_url: "ws://127.0.0.1:7880",
        livekit_api_key: "devkey",
        livekit_api_secret: "secret",
      },
    };
    const view = await toSettingsView(withRoom);
    expect(view.status.speaking_agent).toBe("ready");
    expect(view.status.voice_ready).toBe(true);
    expect(view.conversation.speaking_summary).toContain("deepgram");
  });

  it("keeps live preset ready with only OpenAI key", () => {
    expect(isSpeakingConfigured(baseConfig({ openai_api_key: "sk-live" }))).toBe(true);
    expect(isSpeakingConfigured(baseConfig())).toBe(false);
  });

  it("persists Twilio settings, masks secrets, and reports readiness", async () => {
    const { config } = applySettingsPatch(baseConfig({
      livekit_url: "wss://project.livekit.cloud",
      livekit_api_key: "livekit-key",
      livekit_api_secret: "livekit-secret",
      openai_api_key: "sk-live",
    }), {
      routes: { default: { notify: ["secure_link", "twilio"] } },
      telephony: {
        adapter: "twilio",
        twilio: {
          account_sid: "AC0123456789abcdef0123456789abcdef",
          auth_token: "twilio-secret",
          from_number: "+14165550100",
          destination_number: "+14165550101",
        },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));

    const view = await toSettingsView(config);
    expect(view.status.twilio).toBe("ready");
    expect(view.telephony.twilio).toMatchObject({
      account_sid_configured: true,
      auth_token_configured: true,
      from_number: "+14165550100",
      destination_number: "+14165550101",
    });
    expect(view.telephony.twilio).not.toHaveProperty("account_sid");
    expect(view.telephony.twilio).not.toHaveProperty("auth_token");
  });

  it("persists operator alert preferences and quiet hours", () => {
    const { config } = applySettingsPatch(baseConfig(), {
      operators: {
        me: {
          call_name: "Richardson",
          timezone: "America/New_York",
          quiet_hours: "22:00-07:00",
          alerts: {
            style: "standard",
            sound: false,
            browser_notifications: true,
            snooze_minutes: 15,
          },
        },
      },
    });
    expect(config.operators.me?.call_name).toBe("Richardson");
    expect(config.operators.me?.timezone).toBe("America/New_York");
    expect(config.operators.me?.quiet_hours).toBe("22:00-07:00");
    expect(config.operators.me?.alerts?.style).toBe("standard");
    expect(config.operators.me?.alerts?.sound).toBe(false);
    expect(config.operators.me?.alerts?.snooze_minutes).toBe(15);
  });

  it("detects local serve LiveKit defaults vs custom Cloud credentials", () => {
    const local = baseConfig({
      livekit_url: LOCAL_LIVEKIT_DEFAULTS.url,
      livekit_public_url: LOCAL_LIVEKIT_DEFAULTS.publicUrl,
      livekit_api_key: LOCAL_LIVEKIT_DEFAULTS.apiKey,
      livekit_api_secret: LOCAL_LIVEKIT_DEFAULTS.apiSecret,
    });
    expect(isLocalLiveKitDefaults(local)).toBe(true);
    expect(resolveLiveKitCredentialSource(local)).toBe("local_defaults");

    const cloud = baseConfig({
      livekit_url: "wss://myproj.livekit.cloud",
      livekit_public_url: "wss://myproj.livekit.cloud",
      livekit_api_key: "APIxxxx",
      livekit_api_secret: "cloud-secret",
    });
    expect(isLocalLiveKitDefaults(cloud)).toBe(false);
    expect(resolveLiveKitCredentialSource(cloud)).toBe("custom");
    expect(resolveLiveKitCredentialSource(baseConfig())).toBe("none");
  });
});

describe("Hermes skill preview", () => {
  it("contains the configured fast path and object-shaped decision payload", () => {
    const skill = buildHermesSkillMarkdown("http://127.0.0.1:8787");

    expect(skill).toContain("Expected API: `http://127.0.0.1:8787`");
    expect(skill).toContain("Never create or edit a session JSON file");
    expect(skill).toContain("openconfer session create --stdin --json");
    expect(skill).toContain("Never open a browser, navigate to `join_url`");
    expect(skill).toContain('"initiator": {');
    expect(skill).toContain('"participant": {');
    expect(skill).toContain('"result_schema": {');
    expect(skill).toContain('"continuation": {');
    expect(skill).toContain('"idempotency_key": "${idempotency_key}"');
    expect(skill).toContain("Keep the returned ID in agent task state, not a file");
    expect(skill).toContain("declined");
    expect(skill).toContain("policy_blocked");
    expect(skill).not.toMatch(/cat >|session_file|state_dir|session create --file/);
    expect(skill).not.toContain("See `examples/decision-session/session.json`");
  });
});
