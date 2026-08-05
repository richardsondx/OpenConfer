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

  it("keeps the conversation in English unless the operator explicitly requests a switch", () => {
    const prompt = instructionsFor({
      operator: { preferredName: "Sofía" },
      objective: "Review the decisión text in the supplied context",
    });

    expect(prompt).toContain("Speak in English by default and continue in English");
    expect(prompt).toContain("only when the operator clearly asks you to");
    expect(prompt).toContain("speech-transcription artifact is not a request to switch languages");
  });
});
