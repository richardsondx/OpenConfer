import { describe, expect, it } from "vitest";
import { normalizeAlertPrefs, ringProfileFor } from "./alert-prefs";

describe("alert prefs", () => {
  it("defaults to subtle office style", () => {
    expect(normalizeAlertPrefs(undefined).style).toBe("subtle");
    expect(normalizeAlertPrefs(null).snooze_minutes).toBe(3);
    expect(normalizeAlertPrefs({ snooze_presets: [5, 15] } as never).snooze_minutes).toBe(5);
  });

  it("returns null ring profile when style is off", () => {
    expect(
      ringProfileFor("incident", normalizeAlertPrefs({ style: "off" })),
    ).toBeNull();
  });

  it("scales pulses by urgency", () => {
    const prefs = normalizeAlertPrefs({ style: "subtle", sound: true });
    const normal = ringProfileFor("normal", prefs)!;
    const high = ringProfileFor("high", prefs)!;
    const incident = ringProfileFor("incident", prefs)!;
    expect(high.pulses).toBeGreaterThan(normal.pulses);
    expect(incident.pulses).toBeGreaterThanOrEqual(high.pulses);
    expect(incident.preferBrowserNotification).toBe(true);
  });
});
