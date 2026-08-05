import { describe, expect, it } from "vitest";
import {
  describeSpeakingConfig,
  readSpeakingWorkerEnv,
  realtimeModelOptions,
  speakingWorkerEnabled,
} from "./session-factory.js";

describe("speaking worker factory env", () => {
  it("defaults to realtime live mode", () => {
    const config = readSpeakingWorkerEnv({});
    expect(config.speakingMode).toBe("realtime");
    expect(config.realtimeModel).toBe("gpt-realtime-2.1");
    expect(describeSpeakingConfig(config)).toContain("realtime");
    expect(speakingWorkerEnabled(config)).toBe(false);
  });

  it("uses semantic Realtime turn detection with automatic interruption cancellation", () => {
    const config = readSpeakingWorkerEnv({
      OPENAI_API_KEY: "sk-test",
      OPENAI_REALTIME_MODEL: "gpt-realtime-2.1",
    });
    expect(realtimeModelOptions(config, "en")).toMatchObject({
      model: "gpt-realtime-2.1",
      reasoning: { effort: "low" },
      turnDetection: {
        type: "semantic_vad",
        eagerness: "auto",
        create_response: true,
        interrupt_response: true,
      },
    });
  });

  it("does not send unsupported reasoning configuration to explicitly selected older models", () => {
    const config = readSpeakingWorkerEnv({ OPENAI_REALTIME_MODEL: "gpt-realtime-mini" });
    expect(realtimeModelOptions(config, "en")).not.toHaveProperty("reasoning");
  });

  it("enables realtime when OpenAI key is present", () => {
    const config = readSpeakingWorkerEnv({ OPENAI_API_KEY: "sk-test" });
    expect(speakingWorkerEnabled(config)).toBe(true);
  });

  it("enables pipeline when STT/LLM/TTS credentials are present", () => {
    const config = readSpeakingWorkerEnv({
      OPENCONFER_SPEAKING_MODE: "pipeline",
      OPENCONFER_STT_PROVIDER: "deepgram",
      OPENCONFER_STT_API_KEY: "dg",
      OPENCONFER_LLM_PROVIDER: "openrouter",
      OPENCONFER_LLM_API_KEY: "or",
      OPENCONFER_TTS_PROVIDER: "cartesia",
      OPENCONFER_TTS_API_KEY: "cart",
    });
    expect(config.speakingMode).toBe("pipeline");
    expect(speakingWorkerEnabled(config)).toBe(true);
    expect(describeSpeakingConfig(config)).toContain("pipeline");
  });

  it("treats ollama as ready without an API key", () => {
    const config = readSpeakingWorkerEnv({
      OPENCONFER_SPEAKING_MODE: "pipeline",
      OPENCONFER_STT_API_KEY: "dg",
      OPENCONFER_LLM_PROVIDER: "ollama",
      OPENCONFER_TTS_API_KEY: "cart",
    });
    expect(speakingWorkerEnabled(config)).toBe(true);
  });
});
