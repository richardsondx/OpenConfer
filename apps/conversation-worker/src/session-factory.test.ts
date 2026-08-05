import { describe, expect, it } from "vitest";
import {
  describeSpeakingConfig,
  readSpeakingWorkerEnv,
  speakingWorkerEnabled,
} from "./session-factory.js";

describe("speaking worker factory env", () => {
  it("defaults to realtime live mode", () => {
    const config = readSpeakingWorkerEnv({});
    expect(config.speakingMode).toBe("realtime");
    expect(describeSpeakingConfig(config)).toContain("realtime");
    expect(speakingWorkerEnabled(config)).toBe(false);
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
