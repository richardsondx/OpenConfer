/** Speaking-agent presets and readiness helpers (Vapi-style STT / LLM / TTS). */

export const SPEAKING_MODES = ["realtime", "pipeline"] as const;
export type SpeakingMode = (typeof SPEAKING_MODES)[number];

export const SPEAKING_PRESETS = ["live", "flexible", "local", "custom"] as const;
export type SpeakingPreset = (typeof SPEAKING_PRESETS)[number];

export const STT_PROVIDERS = ["deepgram", "openai"] as const;
export type SttProvider = (typeof STT_PROVIDERS)[number];

export const LLM_PROVIDERS = ["openrouter", "openai", "ollama"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const TTS_PROVIDERS = ["cartesia", "elevenlabs", "openai"] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export const DEFAULT_CARTESIA_VOICE = "f786b574-daa5-4673-aa0c-cbe3e8534c02";
export const DEFAULT_ELEVENLABS_VOICE = "21m00Tcm4TlvDq8ikWAM";
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1";

export type RealtimeSpeakingConfig = {
  provider: "openai";
  model: string;
  voice: string;
  api_key?: string;
};

export type SttSpeakingConfig = {
  provider: SttProvider;
  model: string;
  api_key?: string;
};

export type LlmSpeakingConfig = {
  provider: LlmProvider;
  model: string;
  base_url?: string;
  api_key?: string;
};

export type TtsSpeakingConfig = {
  provider: TtsProvider;
  model: string;
  voice: string;
  api_key?: string;
};

/** Conversation speaking fields after normalization. */
export type SpeakingConversationFields = {
  speaking_mode: SpeakingMode;
  preset: SpeakingPreset;
  /** Legacy mirrors for realtime mode (kept for older YAML / callers). */
  model: string;
  voice: string;
  openai_api_key?: string;
  realtime: RealtimeSpeakingConfig;
  stt: SttSpeakingConfig;
  llm: LlmSpeakingConfig;
  tts: TtsSpeakingConfig;
};

export type SpeakingReadyStatus = "ready" | "missing_credentials";

export function defaultRealtimeConfig(partial?: Partial<RealtimeSpeakingConfig>): RealtimeSpeakingConfig {
  return {
    provider: "openai",
    model: partial?.model ?? DEFAULT_REALTIME_MODEL,
    voice: partial?.voice ?? "marin",
    ...(partial?.api_key ? { api_key: partial.api_key } : {}),
  };
}

export function defaultSttConfig(partial?: Partial<SttSpeakingConfig>): SttSpeakingConfig {
  return {
    provider: partial?.provider ?? "deepgram",
    model: partial?.model ?? (partial?.provider === "openai" ? "gpt-4o-mini-transcribe" : "nova-3"),
    ...(partial?.api_key ? { api_key: partial.api_key } : {}),
  };
}

export function defaultLlmConfig(partial?: Partial<LlmSpeakingConfig>): LlmSpeakingConfig {
  const provider = partial?.provider ?? "openrouter";
  const model =
    partial?.model ??
    (provider === "ollama" ? "llama3.2" : provider === "openai" ? "gpt-4o-mini" : "openai/gpt-4o-mini");
  const base_url =
    partial?.base_url ??
    (provider === "ollama"
      ? DEFAULT_OLLAMA_BASE_URL
      : provider === "openrouter"
        ? DEFAULT_OPENROUTER_BASE_URL
        : undefined);
  return {
    provider,
    model,
    ...(base_url ? { base_url } : {}),
    ...(partial?.api_key ? { api_key: partial.api_key } : {}),
  };
}

export function defaultTtsConfig(partial?: Partial<TtsSpeakingConfig>): TtsSpeakingConfig {
  const provider = partial?.provider ?? "cartesia";
  const model =
    partial?.model ??
    (provider === "elevenlabs" ? "eleven_flash_v2_5" : provider === "openai" ? "gpt-4o-mini-tts" : "sonic-3");
  const voice =
    partial?.voice ??
    (provider === "elevenlabs"
      ? DEFAULT_ELEVENLABS_VOICE
      : provider === "openai"
        ? "alloy"
        : DEFAULT_CARTESIA_VOICE);
  return {
    provider,
    model,
    voice,
    ...(partial?.api_key ? { api_key: partial.api_key } : {}),
  };
}

/** Apply curated preset defaults onto speaking blocks (keeps existing API keys). */
export function applySpeakingPreset(
  preset: SpeakingPreset,
  current?: Partial<SpeakingConversationFields>,
): Pick<
  SpeakingConversationFields,
  "speaking_mode" | "preset" | "realtime" | "stt" | "llm" | "tts" | "model" | "voice" | "openai_api_key"
> {
  const realtime = defaultRealtimeConfig({
    ...current?.realtime,
    api_key: current?.realtime?.api_key ?? current?.openai_api_key,
    model: current?.realtime?.model ?? current?.model,
    voice: current?.realtime?.voice ?? current?.voice,
  });

  if (preset === "live") {
    return {
      speaking_mode: "realtime",
      preset,
      realtime,
      stt: defaultSttConfig(current?.stt),
      llm: defaultLlmConfig(current?.llm),
      tts: defaultTtsConfig(current?.tts),
      model: realtime.model,
      voice: realtime.voice,
      openai_api_key: realtime.api_key ?? current?.openai_api_key,
    };
  }

  if (preset === "flexible") {
    return {
      speaking_mode: "pipeline",
      preset,
      realtime,
      stt: defaultSttConfig({ ...current?.stt, provider: "deepgram", model: current?.stt?.model ?? "nova-3" }),
      llm: defaultLlmConfig({
        ...current?.llm,
        provider: "openrouter",
        model: current?.llm?.model ?? "openai/gpt-4o-mini",
        base_url: current?.llm?.base_url ?? DEFAULT_OPENROUTER_BASE_URL,
      }),
      tts: defaultTtsConfig({
        ...current?.tts,
        provider: "cartesia",
        model: current?.tts?.model ?? "sonic-3",
      }),
      model: realtime.model,
      voice: realtime.voice,
      openai_api_key: realtime.api_key ?? current?.openai_api_key,
    };
  }

  if (preset === "local") {
    return {
      speaking_mode: "pipeline",
      preset,
      realtime,
      stt: defaultSttConfig({
        ...current?.stt,
        provider: current?.stt?.provider ?? "openai",
        model: current?.stt?.model ?? "gpt-4o-mini-transcribe",
      }),
      llm: defaultLlmConfig({
        ...current?.llm,
        provider: "ollama",
        model: current?.llm?.model ?? "llama3.2",
        base_url: current?.llm?.base_url ?? DEFAULT_OLLAMA_BASE_URL,
      }),
      tts: defaultTtsConfig({
        ...current?.tts,
        provider: current?.tts?.provider ?? "openai",
        model: current?.tts?.model ?? "gpt-4o-mini-tts",
        voice: current?.tts?.voice ?? "alloy",
      }),
      model: realtime.model,
      voice: realtime.voice,
      openai_api_key: realtime.api_key ?? current?.openai_api_key,
    };
  }

  // custom — keep mode if set, otherwise pipeline when stt/llm/tts look configured
  const speaking_mode = current?.speaking_mode ?? "pipeline";
  return {
    speaking_mode,
    preset,
    realtime,
    stt: defaultSttConfig(current?.stt),
    llm: defaultLlmConfig(current?.llm),
    tts: defaultTtsConfig(current?.tts),
    model: realtime.model,
    voice: realtime.voice,
    openai_api_key: realtime.api_key ?? current?.openai_api_key,
  };
}

type LooseConversation = {
  speaking_mode?: string;
  preset?: string;
  model?: string;
  voice?: string;
  openai_api_key?: string;
  realtime?: Partial<RealtimeSpeakingConfig>;
  stt?: Partial<SttSpeakingConfig>;
  llm?: Partial<LlmSpeakingConfig>;
  tts?: Partial<TtsSpeakingConfig>;
  [key: string]: unknown;
};

/** Normalize legacy flat model/voice/openai_api_key into speaking blocks. */
export function normalizeSpeakingFields(raw: LooseConversation): SpeakingConversationFields {
  const legacyModel = typeof raw.model === "string" ? raw.model : undefined;
  const legacyVoice = typeof raw.voice === "string" ? raw.voice : undefined;
  const legacyKey = typeof raw.openai_api_key === "string" ? raw.openai_api_key : undefined;

  const hasNewShape = !!(raw.speaking_mode || raw.preset || raw.realtime || raw.stt || raw.llm || raw.tts);
  const preset = (SPEAKING_PRESETS.includes(raw.preset as SpeakingPreset)
    ? raw.preset
    : hasNewShape
      ? "custom"
      : "live") as SpeakingPreset;

  const speaking_mode = (SPEAKING_MODES.includes(raw.speaking_mode as SpeakingMode)
    ? raw.speaking_mode
    : preset === "live"
      ? "realtime"
      : "pipeline") as SpeakingMode;

  const requestedRealtimeModel = raw.realtime?.model ?? legacyModel;
  const realtime = defaultRealtimeConfig({
    ...raw.realtime,
    // The original gpt-realtime value was the stock Live preset default. Upgrade
    // that exact deprecated default in Live mode, while preserving custom and
    // pipeline selections (including arbitrary future model ids).
    model:
      preset === "live" && requestedRealtimeModel === "gpt-realtime"
        ? DEFAULT_REALTIME_MODEL
        : requestedRealtimeModel,
    voice: raw.realtime?.voice ?? legacyVoice,
    api_key: raw.realtime?.api_key ?? legacyKey,
  });

  const base: SpeakingConversationFields = {
    speaking_mode,
    preset,
    realtime,
    stt: defaultSttConfig(raw.stt),
    llm: defaultLlmConfig(raw.llm),
    tts: defaultTtsConfig(raw.tts),
    model: realtime.model,
    voice: realtime.voice,
    openai_api_key: realtime.api_key,
  };

  // Legacy YAML (flat model/voice/key only) → Live realtime preset.
  if (!hasNewShape) {
    return applySpeakingPreset("live", base);
  }
  if (preset === "live" || preset === "flexible" || preset === "local") {
    return applySpeakingPreset(preset, base);
  }
  return {
    ...base,
    speaking_mode,
    preset: "custom",
  };
}

function resolveSecret(
  configured: string | undefined,
  envKeys: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (configured?.trim()) return configured.trim();
  for (const key of envKeys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function resolveRealtimeApiKey(
  conversation: Pick<SpeakingConversationFields, "realtime" | "openai_api_key">,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveSecret(conversation.realtime?.api_key ?? conversation.openai_api_key, ["OPENAI_API_KEY"], env);
}

export function resolveSttApiKey(
  stt: SttSpeakingConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (stt.provider === "deepgram") {
    return resolveSecret(stt.api_key, ["DEEPGRAM_API_KEY"], env);
  }
  return resolveSecret(stt.api_key, ["OPENAI_API_KEY"], env);
}

export function resolveLlmApiKey(
  llm: LlmSpeakingConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (llm.provider === "ollama") {
    // Ollama typically needs no key; allow optional placeholder.
    return resolveSecret(llm.api_key, ["OLLAMA_API_KEY"], env) ?? "ollama";
  }
  if (llm.provider === "openrouter") {
    return resolveSecret(llm.api_key, ["OPENROUTER_API_KEY"], env);
  }
  return resolveSecret(llm.api_key, ["OPENAI_API_KEY"], env);
}

export function resolveTtsApiKey(
  tts: TtsSpeakingConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (tts.provider === "cartesia") {
    return resolveSecret(tts.api_key, ["CARTESIA_API_KEY"], env);
  }
  if (tts.provider === "elevenlabs") {
    return resolveSecret(tts.api_key, ["ELEVEN_API_KEY", "ELEVENLABS_API_KEY"], env);
  }
  return resolveSecret(tts.api_key, ["OPENAI_API_KEY"], env);
}

export function resolveSpeakingReady(
  conversation: SpeakingConversationFields,
  env: NodeJS.ProcessEnv = process.env,
): SpeakingReadyStatus {
  if (conversation.speaking_mode === "realtime") {
    return resolveRealtimeApiKey(conversation, env) ? "ready" : "missing_credentials";
  }
  const sttOk = !!resolveSttApiKey(conversation.stt, env);
  const llmOk = !!resolveLlmApiKey(conversation.llm, env);
  const ttsOk = !!resolveTtsApiKey(conversation.tts, env);
  return sttOk && llmOk && ttsOk ? "ready" : "missing_credentials";
}

export function speakingSummary(conversation: SpeakingConversationFields): string {
  if (conversation.speaking_mode === "realtime") {
    return `OpenAI Realtime · ${conversation.realtime.model} · ${conversation.realtime.voice}`;
  }
  return `${conversation.stt.provider}/${conversation.stt.model} → ${conversation.llm.provider}/${conversation.llm.model} → ${conversation.tts.provider}/${conversation.tts.model}`;
}

export function missingSpeakingCredentials(
  conversation: SpeakingConversationFields,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const missing: string[] = [];
  if (conversation.speaking_mode === "realtime") {
    if (!resolveRealtimeApiKey(conversation, env)) missing.push("OpenAI API key");
    return missing;
  }
  if (!resolveSttApiKey(conversation.stt, env)) {
    missing.push(conversation.stt.provider === "deepgram" ? "Deepgram API key" : "OpenAI API key (STT)");
  }
  if (conversation.llm.provider !== "ollama" && !resolveLlmApiKey(conversation.llm, env)) {
    missing.push(conversation.llm.provider === "openrouter" ? "OpenRouter API key" : "OpenAI API key (LLM)");
  }
  if (!resolveTtsApiKey(conversation.tts, env)) {
    if (conversation.tts.provider === "cartesia") missing.push("Cartesia API key");
    else if (conversation.tts.provider === "elevenlabs") missing.push("ElevenLabs API key");
    else missing.push("OpenAI API key (TTS)");
  }
  return missing;
}
