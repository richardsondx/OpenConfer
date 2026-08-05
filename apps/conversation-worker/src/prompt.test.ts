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
});
