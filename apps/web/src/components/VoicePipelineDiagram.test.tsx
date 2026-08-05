import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VoicePipelineDiagram } from "./VoicePipelineDiagram";

describe("VoicePipelineDiagram", () => {
  it("shows realtime path for Live preset", () => {
    render(
      <VoicePipelineDiagram
        mode="realtime"
        preset="live"
        realtimeModel="gpt-realtime-2.1"
        realtimeVoice="marin"
        sttProvider="deepgram"
        sttModel="nova-3"
        llmProvider="openrouter"
        llmModel="openai/gpt-4o-mini"
        ttsProvider="cartesia"
        ttsModel="sonic-3"
      />,
    );
    expect(screen.getByText("Realtime")).toBeInTheDocument();
    expect(screen.getByText(/gpt-realtime-2.1 · marin/i)).toBeInTheDocument();
    expect(screen.getByText(/LiveKit/i)).toBeInTheDocument();
    expect(screen.queryByText("Transcriber")).not.toBeInTheDocument();
  });

  it("shows Transcriber → Model → Voice for pipeline presets", () => {
    render(
      <VoicePipelineDiagram
        mode="pipeline"
        preset="flexible"
        realtimeModel="gpt-realtime-2.1"
        realtimeVoice="marin"
        sttProvider="deepgram"
        sttModel="nova-3"
        llmProvider="openrouter"
        llmModel="openai/gpt-4o-mini"
        ttsProvider="cartesia"
        ttsModel="sonic-3"
      />,
    );
    expect(screen.getByText("Transcriber")).toBeInTheDocument();
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByText("Voice")).toBeInTheDocument();
    expect(screen.getByText(/deepgram · nova-3/i)).toBeInTheDocument();
    expect(screen.getByText(/openrouter · openai\/gpt-4o-mini/i)).toBeInTheDocument();
    expect(screen.getByText(/cartesia · sonic-3/i)).toBeInTheDocument();
  });
});
