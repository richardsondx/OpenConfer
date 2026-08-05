export const DEFAULT_VOICE_IDLE_TIMEOUT_MS = 90_000;
export const DEFAULT_VOICE_MAX_DURATION_MS = 10 * 60_000;

export type VoiceDisconnectReason = "idle_timeout" | "max_duration";

export interface VoiceSessionTimeouts {
  idleTimeoutMs: number;
  maxDurationMs: number;
}

function positiveMilliseconds(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function readVoiceSessionTimeouts(
  env: NodeJS.ProcessEnv = process.env,
): VoiceSessionTimeouts {
  const idleTimeoutMs = positiveMilliseconds(
    env.OPENCONFER_VOICE_IDLE_TIMEOUT_MS,
    DEFAULT_VOICE_IDLE_TIMEOUT_MS,
  );
  const configuredMaximum = positiveMilliseconds(
    env.OPENCONFER_VOICE_MAX_DURATION_MS,
    DEFAULT_VOICE_MAX_DURATION_MS,
  );
  return {
    idleTimeoutMs,
    maxDurationMs: Math.max(idleTimeoutMs, configuredMaximum),
  };
}

export function createVoiceSessionTimeoutGuard(
  timeouts: VoiceSessionTimeouts,
  onDisconnect: (reason: VoiceDisconnectReason) => void | Promise<void>,
): { markUserActivity(): void; stop(): void } {
  let stopped = false;
  let idleTimer: ReturnType<typeof setTimeout>;

  const disconnect = (reason: VoiceDisconnectReason) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    void Promise.resolve(onDisconnect(reason)).catch((error) => {
      console.error("[openconfer] voice timeout cleanup failed", error);
    });
  };
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => disconnect("idle_timeout"), timeouts.idleTimeoutMs);
    idleTimer.unref?.();
  };
  const maxTimer = setTimeout(() => disconnect("max_duration"), timeouts.maxDurationMs);
  maxTimer.unref?.();
  armIdleTimer();

  return {
    markUserActivity() {
      if (!stopped) armIdleTimer();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
    },
  };
}
