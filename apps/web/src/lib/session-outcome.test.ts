import { describe, expect, it } from "vitest";
import {
  formatDecisionResult,
  formatSessionDetail,
  resolveOptionLabel,
  sessionOutcome,
  shapeCueForSession,
} from "./session-outcome";

describe("formatDecisionResult", () => {
  it("formats a single choice-like field as the choice itself", () => {
    expect(formatDecisionResult({ choice: "pizza" })).toBe("pizza");
  });

  it("resolves option ids to labels", () => {
    expect(
      formatDecisionResult(
        { selected_option: "browser" },
        [
          { id: "browser", label: "Browser-first" },
          { id: "phone", label: "Telephone-first" },
        ],
      ),
    ).toBe("Browser-first");
  });

  it("formats named fields and stops after two", () => {
    expect(formatDecisionResult({ owner: "alex", region: "us" })).toBe("owner: alex · region: us");
  });
});

describe("resolveOptionLabel", () => {
  it("maps id to label and falls back to the raw value", () => {
    expect(resolveOptionLabel("phone", [{ id: "phone", label: "Telephone-first" }])).toBe("Telephone-first");
    expect(resolveOptionLabel("defer", [{ id: "phone", label: "Telephone-first" }])).toBe("defer");
  });
});

describe("shapeCueForSession", () => {
  it("prefers short option labels, else a count", () => {
    expect(
      shapeCueForSession({
        type: "decision",
        brief: {
          reason: "Blocked",
          options: [
            { id: "a", label: "Browser-first" },
            { id: "b", label: "Telephone-first" },
          ],
        },
      }),
    ).toBe("Browser-first · Telephone-first");

    expect(
      shapeCueForSession({
        type: "decision",
        brief: {
          reason: "Research",
          options: [
            { id: "a", label: "Soft launch to existing users this week" },
            { id: "b", label: "Public launch with press" },
            { id: "c", label: "Defer until metrics improve" },
            { id: "d", label: "Kill the project" },
          ],
        },
      }),
    ).toBe("4 choices");
  });

  it("uses updates for standups and Approval for approval checkpoints", () => {
    expect(
      shapeCueForSession({
        type: "briefing",
        brief: { reason: "Standup", completed: ["Shipped API", "Built client"] },
      }),
    ).toBe("2 updates");
    expect(
      shapeCueForSession({
        type: "approval",
        brief: { reason: "Release ready" },
      }),
    ).toBe("Approval");
  });
});

describe("sessionOutcome", () => {
  it("marks completed decisions as ok with summary detail", () => {
    expect(
      sessionOutcome({
        type: "decision",
        status: "completed",
        summary: "Go with pizza",
        result: { choice: "pizza" },
        brief: { reason: "Hungry" },
      }),
    ).toEqual({
      tone: "ok",
      label: "Decided",
      variant: "success",
      detail: "Go with pizza",
      shapeCue: undefined,
    });
  });

  it("formats standup briefings as Synced with next actions", () => {
    expect(
      sessionOutcome({
        type: "briefing",
        status: "completed",
        brief: { reason: "Daily standup", completed: ["Shipped session API"] },
        result: { next_actions: ["Focus webhook reliability", "Ship notify path"] },
      }),
    ).toMatchObject({
      tone: "ok",
      label: "Synced",
      variant: "success",
      detail: "Focus webhook reliability; Ship notify path",
      shapeCue: "1 update",
    });
  });

  it("formats approvals from boolean result", () => {
    expect(
      sessionOutcome({
        type: "approval",
        status: "result_delivered",
        brief: { reason: "Release candidate passed" },
        result: { approved: true, notes: "changelog looks good" },
      }),
    ).toMatchObject({
      tone: "ok",
      label: "Approved",
      detail: "Approved — changelog looks good",
      shapeCue: "Approval",
    });
  });

  it("resolves research decisions via option labels", () => {
    expect(
      sessionOutcome({
        type: "decision",
        status: "completed",
        brief: {
          reason: "Research complete",
          options: [
            { id: "soft", label: "Soft launch to existing users" },
            { id: "public", label: "Public launch" },
          ],
        },
        result: { selected_option: "soft" },
      }),
    ).toMatchObject({
      label: "Decided",
      detail: "Soft launch to existing users",
      shapeCue: "Soft launch to existing users · Public launch",
    });
  });

  it("marks cancelled incidents as bad with a clear empty-detail line", () => {
    expect(
      sessionOutcome({
        type: "incident",
        status: "cancelled",
        brief: { reason: "Pager" },
        urgency: "incident",
      }),
    ).toEqual({
      tone: "bad",
      label: "Cancelled",
      variant: "danger",
      detail: "No decision recorded",
      shapeCue: "Urgent",
    });
  });

  it("omits detail for open sessions but keeps urgency cue", () => {
    expect(
      sessionOutcome({
        type: "decision",
        status: "joining",
        brief: { reason: "Paused" },
      }),
    ).toEqual({
      tone: "open",
      label: "In progress",
      variant: "active",
      shapeCue: undefined,
    });
    expect(
      sessionOutcome({
        type: "incident",
        status: "notified",
        brief: { reason: "Outage" },
        urgency: "incident",
      }),
    ).toMatchObject({
      tone: "open",
      label: "Waiting",
      variant: "urgent",
      shapeCue: "Urgent",
    });
  });
});

describe("formatSessionDetail", () => {
  it("prefers summary over result humanization", () => {
    expect(
      formatSessionDetail({
        type: "briefing",
        status: "completed",
        summary: "Ship as-is; tweak CTA tomorrow",
        brief: { reason: "Build sync", completed: ["Homepage", "Nav"] },
        result: { next_actions: ["ignored"] },
      }),
    ).toBe("Ship as-is; tweak CTA tomorrow");
  });
});
