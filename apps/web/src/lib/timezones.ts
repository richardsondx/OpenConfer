/** Common operator timezones when Intl.supportedValuesOf is unavailable. */
const FALLBACK_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Stockholm",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
] as const;

/** IANA timezone ids for the operator quiet-hours dropdown. */
export function listTimeZones(): string[] {
  let zones: string[] = [...FALLBACK_TIMEZONES];
  try {
    const intlWithZones = Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    };
    const supported = intlWithZones.supportedValuesOf?.("timeZone");
    if (supported?.length) zones = supported;
  } catch {
    /* keep fallback */
  }
  // OpenConfer defaults to UTC; some runtimes omit it from supportedValuesOf.
  if (!zones.includes("UTC")) zones = ["UTC", ...zones];
  return zones;
}

/** Ensure a stored/custom value still appears as a selectable option. */
export function timeZoneOptions(current?: string): string[] {
  const zones = listTimeZones();
  if (current && !zones.includes(current)) {
    return [current, ...zones];
  }
  return zones;
}
