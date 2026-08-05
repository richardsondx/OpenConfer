import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const LIVEKIT_IMAGE = "livekit/livekit-server:v1.9.7";
const CONTAINER_NAME = "openconfer-livekit";

export const LOCAL_LIVEKIT = {
  url: "ws://127.0.0.1:7880",
  publicUrl: "ws://127.0.0.1:7880",
  apiKey: "devkey",
  apiSecret: "secret",
} as const;

function configPath(): string {
  return process.env.OPENCONFER_CONFIG ?? join(homedir(), ".openconfer", "config.yaml");
}

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function livekitReachable(url = LOCAL_LIVEKIT.url): Promise<boolean> {
  // LiveKit HTTP health is on the same host port in --dev mode
  const httpUrl = url.replace(/^ws/i, "http").replace(/\/$/, "") + "/";
  try {
    const res = await fetch(httpUrl, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status === 404 || res.status === 200;
  } catch {
    return false;
  }
}

function normalizeLiveKitUrl(url: unknown): string {
  return String(url ?? "")
    .trim()
    .replace(/\/$/, "")
    .toLowerCase()
    .replace(/^http/, "ws");
}

/** Local serve / Docker --dev only accepts the built-in devkey pair. */
export function isLocalLiveKitUrl(url: unknown): boolean {
  const normalized = normalizeLiveKitUrl(url);
  return (
    normalized === normalizeLiveKitUrl(LOCAL_LIVEKIT.url) ||
    normalized === "ws://localhost:7880"
  );
}

/**
 * Ensure config.yaml has credentials that work with local LiveKit --dev.
 * Also heals the common Day-1 mistake: Cloud API keys saved against ws://127.0.0.1:7880,
 * which makes join fail with a bare LiveKit "Unauthorized".
 */
export function ensureLocalLiveKitConfig(): { wrote: boolean; healed: boolean; path: string } {
  const path = configPath();
  if (!existsSync(path)) {
    return { wrote: false, healed: false, path };
  }
  const raw = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
  const conversation = (raw.conversation ?? {}) as Record<string, unknown>;
  let wrote = false;
  let healed = false;

  const url = conversation.livekit_url || LOCAL_LIVEKIT.url;
  const pointingLocal = isLocalLiveKitUrl(url);
  const missingKey = !conversation.livekit_api_key;
  const mismatchedLocalKeys =
    pointingLocal &&
    (conversation.livekit_api_key !== LOCAL_LIVEKIT.apiKey ||
      conversation.livekit_api_secret !== LOCAL_LIVEKIT.apiSecret);

  if (missingKey || mismatchedLocalKeys) {
    conversation.livekit_url = pointingLocal ? url : LOCAL_LIVEKIT.url;
    conversation.livekit_public_url =
      conversation.livekit_public_url && isLocalLiveKitUrl(conversation.livekit_public_url)
        ? conversation.livekit_public_url
        : LOCAL_LIVEKIT.publicUrl;
    conversation.livekit_api_key = LOCAL_LIVEKIT.apiKey;
    conversation.livekit_api_secret = LOCAL_LIVEKIT.apiSecret;
    raw.conversation = conversation;
    wrote = true;
    healed = mismatchedLocalKeys;
  }
  if (wrote) {
    writeFileSync(path, `# OpenConfer configuration\n${stringifyYaml(raw)}`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  return { wrote, healed, path };
}

function containerRunning(): boolean {
  try {
    const out = execSync(`docker inspect -f '{{.State.Running}}' ${CONTAINER_NAME}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}

/** Start a local LiveKit --dev container if needed. Returns status message. */
export async function ensureLocalLiveKitRuntime(): Promise<{
  ok: boolean;
  message: string;
}> {
  if (await livekitReachable()) {
    return { ok: true, message: `LiveKit already running at ${LOCAL_LIVEKIT.publicUrl}` };
  }

  if (!dockerAvailable()) {
    return {
      ok: false,
      message:
        "LiveKit is required for voice. Install Docker Desktop (or set LiveKit Cloud credentials in Settings → Voice), then run openconfer serve again.",
    };
  }

  if (containerRunning()) {
    // Container up but not reachable yet — brief wait
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await livekitReachable()) {
        return { ok: true, message: `LiveKit ready at ${LOCAL_LIVEKIT.publicUrl}` };
      }
    }
  }

  try {
    // Remove stale stopped container with same name
    try {
      execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "ignore" });
    } catch {
      /* ignore */
    }

    const child = spawn(
      "docker",
      [
        "run",
        "-d",
        "--name",
        CONTAINER_NAME,
        "-p",
        "7880:7880",
        "-p",
        "7881:7881",
        LIVEKIT_IMAGE,
        "--dev",
        "--bind",
        "0.0.0.0",
        "--node-ip",
        "127.0.0.1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`docker run exited ${code}`));
      });
    });

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await livekitReachable()) {
        return {
          ok: true,
          message: `Started local LiveKit at ${LOCAL_LIVEKIT.publicUrl}`,
        };
      }
    }
    return {
      ok: false,
      message: "Started LiveKit container but it did not become ready in time.",
    };
  } catch (error) {
    return {
      ok: false,
      message: `Could not start LiveKit: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function prepareVoiceForServe(): Promise<void> {
  const { wrote, healed } = ensureLocalLiveKitConfig();
  if (healed) {
    console.log(
      `Reset LiveKit credentials to local --dev defaults (devkey) in ${configPath()} — Cloud keys cannot authenticate against ws://127.0.0.1:7880.`,
    );
  } else if (wrote) {
    console.log(`Configured local LiveKit credentials in ${configPath()}`);
  }
  const runtime = await ensureLocalLiveKitRuntime();
  console.log(runtime.ok ? `✓ ${runtime.message}` : `✗ ${runtime.message}`);
  if (!runtime.ok) {
    console.log("  Text decisions still work; voice rooms need LiveKit.");
  }
}
