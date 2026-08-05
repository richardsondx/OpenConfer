import { describe, expect, it } from "vitest";
import {
  evaluatePolicy,
  checkRateLimit,
  isOperatorInQuietHours,
  nextOperatorQuietHoursEnd,
} from "./policy.js";
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

  it("finds the end of overnight quiet hours for retry deferral", () => {
    const during = new Date("2026-08-05T23:30:00.000Z");
    expect(isOperatorInQuietHours("UTC", "22:00-07:00", during)).toBe(true);
    expect(nextOperatorQuietHoursEnd("UTC", "22:00-07:00", during)?.toISOString()).toBe(
      "2026-08-06T07:00:00.000Z",
    );
    expect(isOperatorInQuietHours("UTC", "22:00-07:00", new Date("2026-08-06T07:00:00.000Z")))
      .toBe(false);
  });
});
