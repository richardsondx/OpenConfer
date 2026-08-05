import { describe, expect, it, vi } from "vitest";
import { previewAlertStyle, shouldRingSession } from "./incoming-ring";

describe("shouldRingSession", () => {
  it("rings notified waiting sessions", () => {
    expect(shouldRingSession({ status: "notified" })).toBe(true);
    expect(shouldRingSession({ status: "snoozed" })).toBe(false);
    expect(shouldRingSession({ status: "active" })).toBe(false);
  });
});

describe("previewAlertStyle", () => {
  it("is a no-op for off or muted sound", () => {
    const AudioContextMock = vi.fn();
    vi.stubGlobal("AudioContext", AudioContextMock);
    previewAlertStyle("off", true);
    previewAlertStyle("subtle", false);
    expect(AudioContextMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
