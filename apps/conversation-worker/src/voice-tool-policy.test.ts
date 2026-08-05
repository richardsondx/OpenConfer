import { describe, expect, it, vi } from "vitest";
import {
  BoundedSaveRetry,
  retryAuthorizationMessage,
  saveFailureMessage,
  submitToolDescription,
  understandingSavedMessage,
  understandingToolDescription,
  understandingToolName,
} from "./voice-tool-policy.js";

const visualLanguage = /\bpreview\b|\bscreen\b|\bbuttons?\b|\bforms?\b|on-screen/i;

describe("phone voice tool policy", () => {
  it("keeps every model-visible phone message audio-only", () => {
    const rawBackendError = "The pending decision changed; preview again before submitting";
    const messages = [
      understandingToolName("phone"),
      understandingToolDescription("phone"),
      submitToolDescription("phone"),
      understandingSavedMessage("phone"),
      saveFailureMessage("phone", "understanding", false, rawBackendError),
      saveFailureMessage("phone", "understanding", true),
      saveFailureMessage("phone", "submission", false, rawBackendError),
      saveFailureMessage("phone", "submission", true),
      retryAuthorizationMessage("understanding"),
      retryAuthorizationMessage("submission"),
    ];

    expect(messages.join("\n")).not.toMatch(visualLanguage);
    expect(messages.join("\n")).not.toContain(rawBackendError);
  });

  it("retains the browser preview contract", () => {
    expect(understandingToolName("browser")).toBe("preview_decision");
    expect(understandingToolDescription("browser")).toContain("on-screen preview");
    expect(understandingSavedMessage("browser")).toContain("operator's screen");
  });

  it("allows one authorized retry and blocks every later backend attempt", async () => {
    const gate = new BoundedSaveRetry();
    const backendSave = vi.fn(async () => false);

    const run = async (retryAuthorized: boolean) => {
      const decision = gate.beforeAttempt(retryAuthorized);
      if (decision === "awaiting_authorization" || decision === "exhausted") return decision;
      if (!(await backendSave())) gate.recordFailure();
      else gate.recordSuccess();
      return decision;
    };

    expect(await run(false)).toBe("attempt");
    expect(await run(false)).toBe("awaiting_authorization");
    expect(backendSave).toHaveBeenCalledTimes(1);
    expect(await run(true)).toBe("retry");
    expect(await run(true)).toBe("exhausted");
    expect(await run(true)).toBe("exhausted");
    expect(backendSave).toHaveBeenCalledTimes(2);
  });

  it("resets the retry allowance after a successful draft update", () => {
    const gate = new BoundedSaveRetry();
    gate.recordFailure();
    expect(gate.beforeAttempt(true)).toBe("retry");
    gate.recordSuccess();
    expect(gate.beforeAttempt(false)).toBe("attempt");
  });
});
