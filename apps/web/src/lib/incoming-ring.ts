import type { AlertPrefs } from "./alert-prefs";
import { ringProfileFor } from "./alert-prefs";

export type RingHandle = {
  stop: () => void;
};

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedAudioCtx) sharedAudioCtx = new Ctor();
  return sharedAudioCtx;
}

/** Soft two-tone office chime — short, not a phone ring. */
export function playChime(volume: number): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  void ctx.resume().catch(() => undefined);
  const now = ctx.currentTime;
  const notes = [523.25, 659.25]; // C5, E5
  for (let i = 0; i < notes.length; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = notes[i]!;
    gain.gain.setValueAtTime(0.0001, now + i * 0.12);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), now + i * 0.12 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + i * 0.12);
    osc.stop(now + i * 0.12 + 0.32);
  }
}

let previewTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Short settings preview for an alert style (fewer pulses than a real ring).
 * No-op for `off` or when sound is disabled.
 */
export function previewAlertStyle(
  style: AlertPrefs["style"],
  sound = true,
): void {
  if (typeof window === "undefined") return;
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  if (style === "off" || !sound) return;

  const prefs: AlertPrefs = {
    style,
    sound: true,
    browser_notifications: false,
    snooze_minutes: 3,
  };
  const profile = ringProfileFor("normal", prefs);
  if (!profile) return;

  const previewPulses = style === "standard" ? 2 : 1;
  let pulse = 0;
  const tick = () => {
    playChime(profile.volume);
    pulse++;
    if (pulse < previewPulses) {
      previewTimer = setTimeout(tick, Math.min(profile.gapMs, 900));
    } else {
      previewTimer = null;
    }
  };
  tick();
}

function flashTitle(label: string, pulses: number, gapMs: number, signal: { stopped: boolean }): void {
  if (typeof document === "undefined") return;
  const original = document.title;
  let count = 0;
  const tick = () => {
    if (signal.stopped || count >= pulses * 2) {
      document.title = original;
      return;
    }
    document.title = count % 2 === 0 ? `● ${label}` : original;
    count++;
    window.setTimeout(tick, Math.min(gapMs, 900));
  };
  tick();
}

function maybeBrowserNotify(
  title: string,
  body: string,
  prefer: boolean,
  enabled: boolean,
): void {
  if (!prefer && !enabled) return;
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "granted") {
    try {
      new Notification(title, { body, silent: true });
    } catch {
      /* ignore */
    }
    return;
  }
  if (Notification.permission === "default" && (prefer || enabled)) {
    void Notification.requestPermission().then((perm) => {
      if (perm === "granted") {
        try {
          new Notification(title, { body, silent: true });
        } catch {
          /* ignore */
        }
      }
    });
  }
}

/**
 * Start a capped, urgency-aware ring cycle. Auto-stops after pulses.
 * Call stop() early on Answer / Snooze / Decline.
 */
export function startIncomingRing(options: {
  reason: string;
  urgency?: string;
  prefs: AlertPrefs;
  onComplete?: () => void;
}): RingHandle {
  const profile = ringProfileFor(options.urgency, options.prefs);
  const signal = { stopped: false };

  if (!profile) {
    options.onComplete?.();
    return { stop: () => undefined };
  }

  flashTitle(options.reason.slice(0, 40) || "Incoming decision", profile.pulses, profile.gapMs, signal);
  maybeBrowserNotify(
    "OpenConfer",
    options.reason || "A decision is waiting",
    profile.preferBrowserNotification,
    options.prefs.browser_notifications,
  );

  let pulse = 0;
  const playPulse = () => {
    if (signal.stopped) return;
    if (pulse >= profile.pulses) {
      options.onComplete?.();
      return;
    }
    if (options.prefs.sound) playChime(profile.volume);
    pulse++;
    if (pulse < profile.pulses) {
      window.setTimeout(playPulse, profile.gapMs);
    } else {
      // Let the last chime finish, then treat the cycle as ignored / done.
      window.setTimeout(() => {
        if (!signal.stopped) options.onComplete?.();
      }, 400);
    }
  };
  playPulse();

  return {
    stop: () => {
      signal.stopped = true;
      if (typeof document !== "undefined" && document.title.startsWith("● ")) {
        document.title = document.title.replace(/^●\s+/, "");
      }
    },
  };
}

/** Whether the inbox should start a ring for this Waiting session. */
export function shouldRingSession(session: {
  status: string;
}): boolean {
  return session.status === "notified";
}
