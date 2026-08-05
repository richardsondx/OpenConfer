import { describe, expect, it } from "vitest";
import { listTimeZones, timeZoneOptions } from "./timezones";

describe("timezones", () => {
  it("lists IANA zones including UTC", () => {
    const zones = listTimeZones();
    expect(zones.length).toBeGreaterThan(10);
    expect(zones).toContain("UTC");
  });

  it("keeps an unknown current value selectable", () => {
    const options = timeZoneOptions("Etc/Unknown_Custom");
    expect(options[0]).toBe("Etc/Unknown_Custom");
    expect(options).toContain("UTC");
  });
});
