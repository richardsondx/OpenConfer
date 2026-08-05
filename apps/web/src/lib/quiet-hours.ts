/** Server quiet-hours format: `HH:MM-HH:MM` (may wrap overnight). */

export type QuietHoursRange = {
  from: string;
  to: string;
};

export const QUIET_HOURS_PRESETS: Array<{
  id: string;
  label: string;
  range: QuietHoursRange | null;
  hint: string;
}> = [
  { id: "off", label: "Off", range: null, hint: "No quiet hours" },
  {
    id: "evenings",
    label: "Evenings",
    range: { from: "22:00", to: "07:00" },
    hint: "10pm – 7am",
  },
  {
    id: "nights",
    label: "Nights",
    range: { from: "00:00", to: "06:00" },
    hint: "Midnight – 6am",
  },
  {
    id: "custom",
    label: "Custom",
    range: { from: "22:00", to: "07:00" },
    hint: "Pick start and end",
  },
];

export function normalizeTimeValue(value: string): string {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!match) return "00:00";
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseQuietHours(spec?: string | null): QuietHoursRange | null {
  if (!spec?.trim()) return null;
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(spec.trim());
  if (!match) return null;
  return {
    from: `${match[1]}:${match[2]}`,
    to: `${match[3]}:${match[4]}`,
  };
}

export function formatQuietHours(range: QuietHoursRange | null): string | null {
  if (!range) return null;
  return `${normalizeTimeValue(range.from)}-${normalizeTimeValue(range.to)}`;
}

export function quietHoursWrapsOvernight(range: QuietHoursRange): boolean {
  const [fh, fm] = normalizeTimeValue(range.from).split(":").map(Number);
  const [th, tm] = normalizeTimeValue(range.to).split(":").map(Number);
  return (fh! * 60 + fm!) > (th! * 60 + tm!);
}

export function describeQuietHours(range: QuietHoursRange | null): string {
  if (!range) return "Quiet hours are off — agents can create sessions any time.";
  const from = normalizeTimeValue(range.from);
  const to = normalizeTimeValue(range.to);
  if (quietHoursWrapsOvernight(range)) {
    return `Blocks new non-incident sessions from ${from} to ${to} the next morning.`;
  }
  return `Blocks new non-incident sessions from ${from} to ${to}.`;
}

export function matchQuietHoursPreset(range: QuietHoursRange | null): string {
  if (!range) return "off";
  const formatted = formatQuietHours(range);
  const preset = QUIET_HOURS_PRESETS.find(
    (item) => item.id !== "custom" && item.id !== "off" && formatQuietHours(item.range) === formatted,
  );
  return preset?.id ?? "custom";
}
