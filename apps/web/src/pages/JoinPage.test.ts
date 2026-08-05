import { describe, expect, it } from "vitest";
import {
  endSessionDialogCopy,
  isBriefNearingExpiry,
  isBriefStale,
  outcomeCopy,
  resolveModeAfterLoad,
  sessionHasCallback,
  shouldPollOutcome,
} from "./JoinPage";

describe("session outcome copy", () => {
  it("does not claim delivery for a practice session without a callback", () => {
    expect(outcomeCopy("completed", false, "web-ui", false)).toEqual({
      title: "Sandbox decision recorded.",
      body: "No agent was waiting — this was a local test call. Connect a harness when you want real work to pause for your answer.",
    });
  });

  it("keeps delivery-pending copy when a callback exists", () => {
    expect(outcomeCopy("completed", false, "hermes", true)).toEqual({
      title: "Decision confirmed.",
      body: "Your decision is recorded. Delivery to the originating agent is still pending.",
    });
  });

  it("distinguishes delivery from acknowledgement", () => {
    expect(outcomeCopy("result_delivered").title).toBe("Decision delivered.");
    expect(outcomeCopy("result_acknowledged").title).toBe("Decision returned. Work resumed.");
  });

  it("describes stale and harness-cancelled terminal states honestly", () => {
    expect(outcomeCopy("expired").body).toMatch(/stale/i);
    expect(outcomeCopy("cancelled", false, "openclaw").title).toMatch(/cancelled by the requesting agent/i);
    expect(outcomeCopy("cancelled", false, "openclaw").body).toMatch(/openclaw harness/i);
  });
});

describe("endSessionDialogCopy", () => {
  it("warns when an understood preview exists but nothing was saved", () => {
    const copy = endSessionDialogCopy({ submitIssue: false, hasUnderstoodPreview: true });
    expect(copy.body).toMatch(/preview/i);
    expect(copy.body).toMatch(/no answer returned/i);
    expect(copy.confirmLabel).toBe("End without answer");
  });

  it("prefers save-failure copy over preview warning", () => {
    const copy = endSessionDialogCopy({ submitIssue: true, hasUnderstoodPreview: true });
    expect(copy.body).toMatch(/may not have been saved/i);
    expect(copy.confirmLabel).toBe("End without answer");
  });

  it("uses the default cancel copy when there is no preview", () => {
    const copy = endSessionDialogCopy({ submitIssue: false, hasUnderstoodPreview: false });
    expect(copy.body).toMatch(/leave view/i);
    expect(copy.confirmLabel).toBe("End session");
  });
});

describe("join lifecycle helpers", () => {
  it("treats reload during joining as rejoinable incoming state", () => {
    expect(resolveModeAfterLoad("joining")).toBe("incoming");
    expect(resolveModeAfterLoad("active")).toBe("incoming");
    expect(resolveModeAfterLoad("notified")).toBe("incoming");
  });

  it("polls outcomes only when a callback can still advance", () => {
    expect(resolveModeAfterLoad("confirming")).toBe("done");
    expect(resolveModeAfterLoad("completed")).toBe("done");
    expect(shouldPollOutcome("confirming", false, true)).toBe(true);
    expect(shouldPollOutcome("completed", false, false)).toBe(false);
    expect(shouldPollOutcome("result_acknowledged", true, true)).toBe(false);
  });

  it("infers demo sessions have no callback when the flag is missing", () => {
    expect(
      sessionHasCallback({
        id: "ses_1",
        type: "decision",
        status: "completed",
        objective: "Should we order pizza or tacos for lunch?",
        brief: { reason: "Hungry" },
        initiator: { agent_id: "openconfer-demo", harness: "web-ui" },
      }),
    ).toBe(false);
    expect(
      sessionHasCallback({
        id: "ses_2",
        type: "decision",
        status: "completed",
        objective: "Ship?",
        brief: { reason: "Paused" },
        initiator: { agent_id: "planner", harness: "hermes" },
        has_callback: true,
      }),
    ).toBe(true);
  });

  it("flags stale and near-expiry briefs", () => {
    const now = Date.parse("2026-08-04T12:00:00.000Z");
    expect(isBriefStale("2026-08-04T11:59:00.000Z", now)).toBe(true);
    expect(isBriefNearingExpiry("2026-08-04T12:03:00.000Z", now)).toBe(true);
    expect(isBriefNearingExpiry("2026-08-04T13:00:00.000Z", now)).toBe(false);
  });
});
