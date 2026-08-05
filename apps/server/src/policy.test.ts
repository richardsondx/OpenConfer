import { describe, expect, it } from "vitest";
import { evaluatePolicy, checkRateLimit } from "./policy.js";
import { getDefaultConfig } from "./config.js";

describe("policy engine", () => {
  const config = getDefaultConfig();

  it("blocks missing objective", () => {
    const result = evaluatePolicy(
      {
        type: "decision",
        locale: "en",
        initiator: { agent_id: "a", harness: "h" },
        participant: { operator_id: "me" },
        objective: "",
        brief: { reason: "test" },
        result_schema: { type: "object" },
        routing: { policy: "default" },
        urgency: "normal",
      },
      config,
    );
    expect(result.allowed).toBe(false);
  });

  it("allows valid session", () => {
    const result = evaluatePolicy(
      {
        type: "decision",
        locale: "en",
        initiator: { agent_id: "a", harness: "h" },
        participant: { operator_id: "me" },
        objective: "Choose transport",
        brief: { reason: "Blocked" },
        result_schema: { type: "object", properties: {} },
        routing: { policy: "default" },
        urgency: "normal",
      },
      config,
    );
    expect(result.allowed).toBe(true);
  });

  it("enforces rate limits", () => {
    const agent = `rate-test-${Date.now()}`;
    for (let i = 0; i < 20; i++) {
      expect(checkRateLimit(agent).allowed).toBe(true);
    }
    expect(checkRateLimit(agent).allowed).toBe(false);
  });
});
