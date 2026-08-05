import { voice } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import {
  DEFAULT_CARTESIA_VOICE,
  DEFAULT_ELEVENLABS_VOICE,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OPENROUTER_BASE_URL,
  type LlmProvider,
  type SttProvider,
  type TtsProvider,
} from "@openconfer/schemas";

export type SpeakingWorkerEnv = {
  speakingMode: "realtime" | "pipeline";
  realtimeModel: string;
  realtimeVoice: string;
  openaiApiKey?: string;
  sttProvider: SttProvider;
  sttModel: string;
  sttApiKey?: string;
  llmProvider: LlmProvider;
  llmModel: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  ttsProvider: TtsProvider;
  ttsModel: string;
  ttsVoice: string;
  ttsApiKey?: string;
};

export function readSpeakingWorkerEnv(env: NodeJS.ProcessEnv = process.env): SpeakingWorkerEnv {
  const speakingMode = env.OPENCONFER_SPEAKING_MODE === "pipeline" ? "pipeline" : "realtime";
  return {
    speakingMode,
    realtimeModel: env.OPENAI_REALTIME_MODEL || env.OPENCONFER_REALTIME_MODEL || "gpt-realtime",
    realtimeVoice: env.OPENAI_VOICE || env.OPENCONFER_REALTIME_VOICE || "marin",
    openaiApiKey: env.OPENAI_API_KEY || env.OPENCONFER_REALTIME_API_KEY,
    sttProvider: (env.OPENCONFER_STT_PROVIDER as SttProvider) || "deepgram",
    sttModel: env.OPENCONFER_STT_MODEL || "nova-3",
    sttApiKey: env.OPENCONFER_STT_API_KEY || env.DEEPGRAM_API_KEY || env.OPENAI_API_KEY,
    llmProvider: (env.OPENCONFER_LLM_PROVIDER as LlmProvider) || "openrouter",
    llmModel: env.OPENCONFER_LLM_MODEL || "openai/gpt-4o-mini",
    llmBaseUrl: env.OPENCONFER_LLM_BASE_URL,
    llmApiKey: env.OPENCONFER_LLM_API_KEY || env.OPENROUTER_API_KEY || env.OPENAI_API_KEY,
    ttsProvider: (env.OPENCONFER_TTS_PROVIDER as TtsProvider) || "cartesia",
    ttsModel: env.OPENCONFER_TTS_MODEL || "sonic-3",
    ttsVoice: env.OPENCONFER_TTS_VOICE || DEFAULT_CARTESIA_VOICE,
    ttsApiKey:
      env.OPENCONFER_TTS_API_KEY || env.CARTESIA_API_KEY || env.ELEVEN_API_KEY || env.OPENAI_API_KEY,
  };
}

export function speakingWorkerEnabled(config: SpeakingWorkerEnv): boolean {
  if (config.speakingMode === "realtime") {
    return !!config.openaiApiKey;
  }
  const sttOk = !!config.sttApiKey || (config.sttProvider === "openai" && !!config.openaiApiKey);
  const llmOk =
    config.llmProvider === "ollama" ||
    !!config.llmApiKey ||
    (config.llmProvider === "openai" && !!config.openaiApiKey);
  const ttsOk = !!config.ttsApiKey || (config.ttsProvider === "openai" && !!config.openaiApiKey);
  return sttOk && llmOk && ttsOk;
}

async function buildStt(config: SpeakingWorkerEnv, locale: string) {
  if (config.sttProvider === "openai") {
    return new openai.STT({
      model: config.sttModel || "gpt-4o-mini-transcribe",
      language: locale,
      apiKey: config.sttApiKey || config.openaiApiKey,
    });
  }
  const deepgram = await import("@livekit/agents-plugin-deepgram");
  return new deepgram.STT({
    model: config.sttModel || "nova-3",
    language: locale,
    apiKey: config.sttApiKey,
  });
}

function buildLlm(config: SpeakingWorkerEnv) {
  if (config.llmProvider === "ollama") {
    return new openai.LLM({
      model: config.llmModel || "llama3.2",
      baseURL: config.llmBaseUrl || DEFAULT_OLLAMA_BASE_URL,
      apiKey: config.llmApiKey || "ollama",
    });
  }
  if (config.llmProvider === "openrouter") {
    return new openai.LLM({
      model: config.llmModel || "openai/gpt-4o-mini",
      baseURL: config.llmBaseUrl || DEFAULT_OPENROUTER_BASE_URL,
      apiKey: config.llmApiKey,
    });
  }
  return new openai.LLM({
    model: config.llmModel || "gpt-4o-mini",
    ...(config.llmBaseUrl ? { baseURL: config.llmBaseUrl } : {}),
    apiKey: config.llmApiKey || config.openaiApiKey,
  });
}

async function buildTts(config: SpeakingWorkerEnv) {
  if (config.ttsProvider === "elevenlabs") {
    const elevenlabs = await import("@livekit/agents-plugin-elevenlabs");
    return new elevenlabs.TTS({
      model: config.ttsModel || "eleven_flash_v2_5",
      voiceId: config.ttsVoice || DEFAULT_ELEVENLABS_VOICE,
      apiKey: config.ttsApiKey,
    });
  }
  if (config.ttsProvider === "openai") {
    return new openai.TTS({
      model: config.ttsModel || "gpt-4o-mini-tts",
      voice: (config.ttsVoice || "alloy") as "alloy",
      apiKey: config.ttsApiKey || config.openaiApiKey,
    });
  }
  const cartesia = await import("@livekit/agents-plugin-cartesia");
  return new cartesia.TTS({
    model: config.ttsModel || "sonic-3",
    voice: config.ttsVoice || DEFAULT_CARTESIA_VOICE,
    apiKey: config.ttsApiKey,
  });
}

/** Build a LiveKit AgentSession for realtime or STT→LLM→TTS pipeline. */
export async function createAgentSession(
  config: SpeakingWorkerEnv = readSpeakingWorkerEnv(),
  locale = "en",
): Promise<voice.AgentSession> {
  if (config.speakingMode === "realtime") {
    // Realtime only needs the OpenAI plugin — keep pipeline plugins lazy so a
    // partial CLI deploy (missing Deepgram/Cartesia) still starts Live mode.
    return new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        model: config.realtimeModel,
        voice: config.realtimeVoice,
        inputAudioTranscription: { model: "gpt-4o-mini-transcribe", language: locale },
        ...(config.openaiApiKey ? { apiKey: config.openaiApiKey } : {}),
      }),
    });
  }

  return new voice.AgentSession({
    stt: await buildStt(config, locale),
    llm: buildLlm(config),
    tts: await buildTts(config),
  });
}

export function describeSpeakingConfig(config: SpeakingWorkerEnv): string {
  if (config.speakingMode === "realtime") {
    return `realtime ${config.realtimeModel}/${config.realtimeVoice}`;
  }
  return `pipeline ${config.sttProvider}/${config.llmProvider}/${config.ttsProvider}`;
}
