import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isTerminal,
  type SessionState,
} from "./session.js";

describe("session state machine", () => {
  it("allows happy path transitions", () => {
    const path: SessionState[] = [
      "created",
      "policy_check",
      "queued",
      "dispatching",
      "notified",
      "joining",
      "active",
      "confirming",
      "completed",
      "result_delivered",
      "result_acknowledged",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("allows snooze and wake transitions", () => {
    expect(canTransition("notified", "snoozed")).toBe(true);
    expect(canTransition("snoozed", "dispatching")).toBe(true);
    expect(canTransition("snoozed", "joining")).toBe(true);
    expect(canTransition("snoozed", "declined")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(canTransition("created", "active")).toBe(false);
    expect(canTransition("completed", "active")).toBe(false);
    expect(canTransition("snoozed", "notified")).toBe(false);
  });

  it("marks terminal states", () => {
    expect(isTerminal("result_acknowledged")).toBe(true);
    expect(isTerminal("declined")).toBe(true);
    expect(isTerminal("active")).toBe(false);
  });

  it("throws on invalid assertTransition", () => {
    expect(() => assertTransition("created", "active")).toThrow();
  });
});
