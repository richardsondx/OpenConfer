import type { SpeakingMode, SpeakingPreset } from "../lib/settings";

type Stage = {
  id: "transcriber" | "model" | "voice" | "realtime";
  eyebrow: string;
  title: string;
  detail: string;
};

function pipelineStages(args: {
  sttProvider: string;
  sttModel: string;
  llmProvider: string;
  llmModel: string;
  ttsProvider: string;
  ttsModel: string;
}): Stage[] {
  return [
    {
      id: "transcriber",
      eyebrow: "Speech-to-Text (STT)",
      title: "Transcriber",
      detail: `${args.sttProvider} · ${args.sttModel}`,
    },
    {
      id: "model",
      eyebrow: "Intelligence (LLM)",
      title: "Model",
      detail: `${args.llmProvider} · ${args.llmModel}`,
    },
    {
      id: "voice",
      eyebrow: "Text-to-Speech (TTS)",
      title: "Voice",
      detail: `${args.ttsProvider} · ${args.ttsModel}`,
    },
  ];
}

export function VoicePipelineDiagram({
  mode,
  preset,
  realtimeModel,
  realtimeVoice,
  sttProvider,
  sttModel,
  llmProvider,
  llmModel,
  ttsProvider,
  ttsModel,
  roomLabel = "LiveKit room",
}: {
  mode: SpeakingMode;
  preset: SpeakingPreset;
  realtimeModel: string;
  realtimeVoice: string;
  sttProvider: string;
  sttModel: string;
  llmProvider: string;
  llmModel: string;
  ttsProvider: string;
  ttsModel: string;
  roomLabel?: string;
}) {
  const isRealtime = mode === "realtime" || preset === "live";
  const stages: Stage[] = isRealtime
    ? [
        {
          id: "realtime",
          eyebrow: "Speech-to-speech",
          title: "Realtime",
          detail: `${realtimeModel} · ${realtimeVoice}`,
        },
      ]
    : pipelineStages({ sttProvider, sttModel, llmProvider, llmModel, ttsProvider, ttsModel });

  return (
    <div className="voice-pipeline" aria-label="How voice is assembled">
      <div className="voice-pipeline-room">
        <div className="voice-pipeline-room-label">
          <span className="voice-pipeline-room-kicker">Audio room</span>
          <strong>{roomLabel}</strong>
          <span className="voice-pipeline-room-hint">Carries mic audio between browser and agent</span>
        </div>
        <ol className={`voice-pipeline-stages${isRealtime ? " is-realtime" : ""}`}>
          {stages.map((stage) => (
            <li key={stage.id} className={`voice-pipeline-stage is-${stage.id}`}>
              <div className="voice-pipeline-glyph" aria-hidden="true">
                {stage.id === "transcriber" && (
                  <>
                    <span className="voice-pipeline-wave" />
                    <span className="voice-pipeline-arrow">→</span>
                    <span className="voice-pipeline-abc">ABC</span>
                  </>
                )}
                {stage.id === "model" && (
                  <>
                    <span className="voice-pipeline-abc">ABC</span>
                    <span className="voice-pipeline-arrow">→</span>
                    <span className="voice-pipeline-abc">DEF</span>
                  </>
                )}
                {stage.id === "voice" && (
                  <>
                    <span className="voice-pipeline-abc">DEF</span>
                    <span className="voice-pipeline-arrow">→</span>
                    <span className="voice-pipeline-wave" />
                  </>
                )}
                {stage.id === "realtime" && (
                  <>
                    <span className="voice-pipeline-wave" />
                    <span className="voice-pipeline-arrow">↔</span>
                    <span className="voice-pipeline-wave" />
                  </>
                )}
              </div>
              <p className="voice-pipeline-eyebrow">{stage.eyebrow}</p>
              <p className="voice-pipeline-title">{stage.title}</p>
              <p className="voice-pipeline-detail">{stage.detail}</p>
            </li>
          ))}
        </ol>
        <p className="voice-pipeline-caption">
          {isRealtime
            ? "Live preset uses one realtime model inside the room — fastest path."
            : "Flexible/Local/Custom swap Transcriber, Model, and Voice independently inside the room."}
        </p>
      </div>
    </div>
  );
}
