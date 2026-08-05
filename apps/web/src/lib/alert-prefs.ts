/** Client-side alert preference helpers (mirrors server OperatorAlerts). */

export type AlertStyle = "off" | "subtle" | "standard";

export type AlertPrefs = {
  style: AlertStyle;
  sound: boolean;
  browser_notifications: boolean;
  snooze_minutes: number;
  phone_retry_policy: "never" | "brief" | "persistent";
};

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  style: "subtle",
  sound: true,
  browser_notifications: false,
  snooze_minutes: 3,
  phone_retry_policy: "brief",
};

export const ALLOWED_SNOOZE_MINUTES = [1, 3, 5, 10, 15, 30] as const;

export type UrgencyLevel = "normal" | "high" | "incident";

export type RingProfile = {
  pulses: number;
  gapMs: number;
  volume: number;
  preferBrowserNotification: boolean;
};

export function ringProfileFor(
  urgency: string | undefined,
  prefs: AlertPrefs,
): RingProfile | null {
  if (prefs.style === "off") return null;
  const level: UrgencyLevel =
    urgency === "incident" || urgency === "high" ? urgency : "normal";
  const standard = prefs.style === "standard";

  if (level === "incident") {
    return {
      pulses: standard ? 6 : 5,
      gapMs: standard ? 900 : 1100,
      volume: standard ? 0.22 : 0.16,
      preferBrowserNotification: true,
    };
  }
  if (level === "high") {
    return {
      pulses: standard ? 5 : 4,
      gapMs: standard ? 1100 : 1400,
      volume: standard ? 0.18 : 0.12,
      preferBrowserNotification: prefs.browser_notifications,
    };
  }
  return {
    pulses: standard ? 3 : 2,
    gapMs: standard ? 1400 : 1800,
    volume: standard ? 0.14 : 0.08,
    preferBrowserNotification: false,
  };
}

export function normalizeAlertPrefs(
  raw: (Partial<AlertPrefs> & { snooze_presets?: number[] }) | undefined | null,
): AlertPrefs {
  const fromLegacy = Array.isArray(raw?.snooze_presets)
    ? raw.snooze_presets.find((m) => (ALLOWED_SNOOZE_MINUTES as readonly number[]).includes(m))
    : undefined;
  const minutes = raw?.snooze_minutes ?? fromLegacy ?? DEFAULT_ALERT_PREFS.snooze_minutes;
  return {
    style: raw?.style === "off" || raw?.style === "standard" || raw?.style === "subtle"
      ? raw.style
      : DEFAULT_ALERT_PREFS.style,
    sound: raw?.sound !== false,
    browser_notifications: raw?.browser_notifications === true,
    snooze_minutes: (ALLOWED_SNOOZE_MINUTES as readonly number[]).includes(minutes)
      ? minutes
      : DEFAULT_ALERT_PREFS.snooze_minutes,
    phone_retry_policy:
      raw?.phone_retry_policy === "never" || raw?.phone_retry_policy === "persistent"
        ? raw.phone_retry_policy
        : "brief",
  };
}
