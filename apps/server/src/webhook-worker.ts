import type { SessionStore } from "@openconfer/storage-sqlite";
import { lookup } from "node:dns/promises";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isCallbackUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.hash) return false;
    const host = parsed.hostname.toLowerCase();
    const localOptIn = process.env.OPENCONFER_ALLOW_LOCAL_CALLBACKS === "1";
    if (LOCAL_HOSTS.has(host) || host.endsWith(".localhost")) {
      return localOptIn && ["http:", "https:"].includes(parsed.protocol);
    }
    if (parsed.protocol !== "https:") return false;
    if (
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      host === "metadata.google.internal" ||
      host.startsWith("127.") ||
      host.startsWith("169.254.") ||
      host.startsWith("100.64.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.startsWith("[fc") ||
      host.startsWith("[fd") ||
      host.startsWith("[fe80:")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(value)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1];
  const ipv4 = mapped ?? (/^\d+\.\d+\.\d+\.\d+$/.test(value) ? value : undefined);
  if (!ipv4) return false;
  const parts = ipv4.split(".").map(Number);
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a! >= 224 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19));
}

async function isResolvedCallbackAllowed(url: string): Promise<boolean> {
  if (!isCallbackUrlAllowed(url)) return false;
  const parsed = new URL(url);
  if (LOCAL_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith(".localhost")) return true;
  try {
    const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address }) => !isPrivateAddress(address));
  } catch {
    return false;
  }
}

let workerRunning = false;

export async function runWebhookBatch(
  store: SessionStore,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const pending = store.claimPendingWebhooks();
  for (const item of pending) {
        if (!(await isResolvedCallbackAllowed(item.url))) {
          store.markWebhookFailed(item.id, "Callback URL not allowed", new Date(Date.now() + 3_600_000).toISOString());
          continue;
        }
        if (!item.signature) {
          store.markWebhookFailed(item.id, "Webhook signature missing", new Date(Date.now() + 3_600_000).toISOString());
          continue;
        }
        try {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "X-OpenConfer-Event": "session.result_ready",
            "X-OpenConfer-Event-Id": item.eventId,
            "X-OpenConfer-Timestamp": item.timestamp,
            "X-OpenConfer-Signature": item.signature,
          };
          const res = await fetchImpl(item.url, {
            method: "POST",
            headers,
            body: JSON.stringify(item.payload),
            signal: AbortSignal.timeout(10_000),
            redirect: "manual",
          });
          if (res.ok) {
            store.markWebhookDeliveredWithEvent(item.id, item.sessionId, item.url);
          } else {
            const next = new Date(Date.now() + Math.min(60_000 * 2 ** item.attempts, 3_600_000));
            store.markWebhookFailed(item.id, `HTTP ${res.status}`, next.toISOString());
          }
        } catch (err) {
          const next = new Date(Date.now() + Math.min(60_000 * 2 ** item.attempts, 3_600_000));
          store.markWebhookFailed(
            item.id,
            err instanceof Error ? err.message : "Unknown error",
            next.toISOString(),
          );
        }
  }
}

export function startWebhookWorker(store: SessionStore, intervalMs = 5000): NodeJS.Timeout {
  return setInterval(async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      await runWebhookBatch(store);
    } finally {
      workerRunning = false;
    }
  }, intervalMs);
}

export { isCallbackUrlAllowed, isPrivateAddress, isResolvedCallbackAllowed };
