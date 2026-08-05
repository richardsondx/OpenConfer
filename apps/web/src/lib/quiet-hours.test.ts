import { describe, expect, it } from "vitest";
import {
  describeQuietHours,
  formatQuietHours,
  matchQuietHoursPreset,
  normalizeTimeValue,
  parseQuietHours,
  quietHoursWrapsOvernight,
} from "./quiet-hours";

describe("quiet hours helpers", () => {
  it("parses and formats server specs", () => {
    expect(parseQuietHours("22:00-07:00")).toEqual({ from: "22:00", to: "07:00" });
    expect(formatQuietHours({ from: "22:00", to: "07:00" })).toBe("22:00-07:00");
    expect(parseQuietHours("")).toBeNull();
    expect(formatQuietHours(null)).toBeNull();
  });

  it("normalizes time inputs", () => {
    expect(normalizeTimeValue("9:05")).toBe("09:05");
    expect(normalizeTimeValue("22:00:00")).toBe("22:00");
  });

  it("detects overnight wrap and presets", () => {
    expect(quietHoursWrapsOvernight({ from: "22:00", to: "07:00" })).toBe(true);
    expect(quietHoursWrapsOvernight({ from: "12:00", to: "13:00" })).toBe(false);
    expect(matchQuietHoursPreset(null)).toBe("off");
    expect(matchQuietHoursPreset({ from: "22:00", to: "07:00" })).toBe("evenings");
    expect(matchQuietHoursPreset({ from: "13:00", to: "14:00" })).toBe("custom");
    expect(describeQuietHours({ from: "22:00", to: "07:00" })).toMatch(/next morning/);
  });
});
