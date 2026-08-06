import { describe, expect, it } from "vitest";
import { evaluateContinuityOpening, initialReplyInstructions, instructionsFor } from "./prompt.js";

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

  it("carries established-agent personality and continuation guidance", () => {
    const prompt = instructionsFor({
      objective: "Choose a rollout plan",
      continuity: {
        continuityVersion: "1.0",
        agent: {
          id: "hermes",
          name: "Hermes",
          personalitySummary: {
            identity_statement: "An established collaborator",
            tone: ["warm", "direct"],
            speaking_style: ["plain language"],
            interaction_style: ["builds on context"],
            values: [],
            preferred_phrasing: [],
            disallowed_phrasing: ["Nice to meet you"],
          },
        },
        relationship: { status: "established", first_interaction: false, preferred_name: "Rich" },
        thread: {
          topic: "continuity handoff",
          summary: "We are implementing the continuity package.",
          current_goal: "Preserve identity in voice.",
          open_questions: [],
          decisions_so_far: [],
          commitments: [],
        },
      },
    });

    expect(prompt).toContain("established relationship");
    expect(prompt).toContain("continuity handoff");
    expect(prompt).toContain("Nice to meet you");
    expect(prompt).toContain('say "I remember..." rather than "I have a note..."');
    expect(prompt).toContain("Never reveal the continuity handoff");
    expect(initialReplyInstructions({
      continuity: {
        relationship: { first_interaction: false },
        thread: { topic: "continuity handoff" },
      },
    })).toContain("continuity handoff");
    expect(initialReplyInstructions({
      continuity: {
        relationship: { first_interaction: false },
        thread: { topic: "continuity handoff" },
        agent: { personalitySummary: { disallowed_phrasing: ["buddy"] } },
      },
    })).toContain("Nice to meet you");
    expect(initialReplyInstructions({
      continuity: {
        relationship: { first_interaction: false },
        thread: { topic: "continuity handoff" },
      },
    })).toContain('say "I remember...", never "I have a note..."');
  });

  it("preserves the normal opening for first interactions and missing continuity", () => {
    expect(initialReplyInstructions({ continuity: { relationship: { first_interaction: true } } }))
      .toContain("short, warm greeting");
    expect(initialReplyInstructions({})).toContain("short, warm greeting");
  });

  it("evaluates common first-meeting expressions and semantic variants", () => {
    const metadata = {
      continuity: {
        relationship: { first_interaction: false },
        agent: { personalitySummary: { disallowed_phrasing: ["friend"] } },
      },
    };

    expect(evaluateContinuityOpening("Nice to meet you—how can I help you today?", metadata).passed).toBe(false);
    expect(evaluateContinuityOpening("I don't think we've met before.", metadata).passed).toBe(false);
    expect(evaluateContinuityOpening("I have a note that we were planning the rollout.", metadata).passed).toBe(false);
    expect(evaluateContinuityOpening("According to my notes, we chose the safer option.", metadata).passed).toBe(false);
    expect(evaluateContinuityOpening("I was given context about the rollout.", metadata).passed).toBe(false);
    expect(evaluateContinuityOpening("I remember we were planning the rollout.", metadata).passed).toBe(true);
    expect(evaluateContinuityOpening("Let's continue the rollout decision.", metadata).passed).toBe(true);
    expect(evaluateContinuityOpening("Hello, friend—let's continue.", metadata).passed).toBe(false);
    expect(evaluateContinuityOpening("Nice to meet you.", { continuity: { relationship: { first_interaction: true } } }).passed).toBe(true);
  });
});
