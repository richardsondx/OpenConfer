import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVoiceSessionTimeoutGuard,
  DEFAULT_VOICE_IDLE_TIMEOUT_MS,
  DEFAULT_VOICE_MAX_DURATION_MS,
  readVoiceSessionTimeouts,
} from "./idle-policy.js";

describe("voice session timeout policy", () => {
  afterEach(() => vi.useRealTimers());

  it("defaults to a short idle timeout and a bounded call duration", () => {
    expect(readVoiceSessionTimeouts({})).toEqual({
      idleTimeoutMs: DEFAULT_VOICE_IDLE_TIMEOUT_MS,
      maxDurationMs: DEFAULT_VOICE_MAX_DURATION_MS,
    });
  });

  it("resets the idle deadline on user activity", async () => {
    vi.useFakeTimers();
    const disconnect = vi.fn();
    const guard = createVoiceSessionTimeoutGuard(
      { idleTimeoutMs: 1_000, maxDurationMs: 10_000 },
      disconnect,
    );

    await vi.advanceTimersByTimeAsync(900);
    guard.markUserActivity();
    await vi.advanceTimersByTimeAsync(900);
    expect(disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledWith("idle_timeout");
  });

  it("enforces the maximum duration despite continued activity", async () => {
    vi.useFakeTimers();
    const disconnect = vi.fn();
    const guard = createVoiceSessionTimeoutGuard(
      { idleTimeoutMs: 1_000, maxDurationMs: 2_500 },
      disconnect,
    );

    await vi.advanceTimersByTimeAsync(900);
    guard.markUserActivity();
    await vi.advanceTimersByTimeAsync(900);
    guard.markUserActivity();
    await vi.advanceTimersByTimeAsync(700);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledWith("max_duration");
  });
});
