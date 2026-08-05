import { describe, expect, it } from "vitest";
import { instructionsFor } from "./prompt.js";

describe("voice facilitator prompt", () => {
  it("uses the preferred name and makes the greeting its own turn", () => {
    const prompt = instructionsFor({
      operator: { preferredName: "Richardson" },
      objective: "Choose dinner",
      brief: { options: [{ id: "pizza", label: "Pizza" }] },
    });

    expect(prompt).toContain("Operator preferred name: Richardson");
    expect(prompt).toContain("stop to let the operator respond");
    expect(prompt).toContain("do not repeat a fixed script");
  });

  it("defaults to English unless the operator explicitly requests a switch", () => {
    const prompt = instructionsFor({
      operator: { preferredName: "Sofía" },
      objective: "Review the decisión text in the supplied context",
    });

    expect(prompt).toContain("Conduct the entire call in the session locale (en)");
    expect(prompt).toContain("Session locale (BCP 47): en");
    expect(prompt).toContain("only when the operator clearly asks you to");
    expect(prompt).toContain("speech-transcription artifact is not a request to switch languages");
  });

  it("uses the locale selected by the initiating agent", () => {
    const prompt = instructionsFor({ locale: "it-IT", objective: "Scegliere la cena" });

    expect(prompt).toContain("Conduct the entire call in the session locale (it-IT)");
    expect(prompt).toContain("Session locale (BCP 47): it-IT");
  });

  it("continues from interruptions without replay loops and treats pauses patiently", () => {
    const prompt = instructionsFor({ objective: "Choose a rollout plan" });

    expect(prompt).toContain("Respond to the operator's latest utterance");
    expect(prompt).toContain("do not restart or replay the cut-off sentence");
    expect(prompt).toContain("Treat pauses as thinking time");
    expect(prompt).toContain("ask one brief clarification");
  });

  it("defines silent waiting, focused steering, corrections, and whole-packet confirmation", () => {
    const prompt = instructionsFor({ objective: "Choose a rollout plan" });

    expect(prompt).toContain("call wait_for_user and do not speak afterward");
    expect(prompt).toContain("captured_context.steering");
    expect(prompt).toContain("captured_context.additional_instructions");
    expect(prompt).toContain("captured_context.new_requests");
    expect(prompt).toContain("captured_context.unresolved_topics");
    expect(prompt).toContain("after every correction or material addition");
    expect(prompt).toContain("every non-empty captured-context category");
  });

  it("requires fresh confirmation when a previous phone call left a pending preview", () => {
    const prompt = instructionsFor({
      objective: "Approve rollout",
      pendingDecision: {
        result: { approved: true },
        summary: "Proceed with the rollout",
        revision: 4,
      },
    });

    expect(prompt).toContain("previous call was interrupted");
    expect(prompt).toContain("require a fresh confirmation");
    expect(prompt).toContain('"revision":4');
    expect(prompt).toContain("stop_automatic_callbacks");
  });

  it("uses audio-only language and an internal tool name for phone calls", () => {
    const prompt = instructionsFor({
      surface: "phone",
      objective: "Choose dinner",
      resultSchema: { type: "object" },
    });

    expect(prompt).toContain("This interaction is audio-only");
    expect(prompt).toContain("record_current_understanding");
    expect(prompt).not.toMatch(/\bpreview\b|\bscreen\b|\bbuttons?\b|\bforms?\b|on-screen/i);
  });

  it("keeps visible preview guidance for browser voice sessions", () => {
    const prompt = instructionsFor({ surface: "browser", objective: "Choose dinner" });

    expect(prompt).toContain("preview_decision");
    expect(prompt).toContain("on-screen text fallback");
  });
});
