import type { SettingsView } from "./settings";

/** Minimal conversation block for web component tests. */
export function mockConversation(
  overrides: Partial<SettingsView["conversation"]> = {},
): SettingsView["conversation"] {
  return {
    adapter: "livekit",
    speaking_mode: "realtime",
    preset: "live",
    model: "gpt-realtime",
    voice: "marin",
    livekit_api_key_configured: false,
    livekit_api_secret_configured: false,
    openai_api_key_configured: false,
    realtime: {
      provider: "openai",
      model: "gpt-realtime",
      voice: "marin",
      api_key_configured: false,
    },
    stt: {
      provider: "deepgram",
      model: "nova-3",
      api_key_configured: false,
    },
    llm: {
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      api_key_configured: false,
    },
    tts: {
      provider: "cartesia",
      model: "sonic-3",
      voice: "f786b574-daa5-4673-aa0c-cbe3e8534c02",
      api_key_configured: false,
    },
    speaking_summary: "OpenAI Realtime · gpt-realtime · marin",
    missing_credentials: ["OpenAI API key"],
    ...overrides,
  };
}
