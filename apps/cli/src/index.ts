#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { DEFAULT_REALTIME_MODEL } from "@openconfer/schemas";
import { readSessionCreateInput } from "./session-input.js";

const program = new Command();

function getConfig() {
  const configPath = process.env.OPENCONFER_CONFIG ?? join(homedir(), ".openconfer", "config.yaml");
  if (!existsSync(configPath)) return null;
  return parseYaml(readFileSync(configPath, "utf8")) as {
    server?: { base_url?: string };
    auth?: { api_token?: string };
  };
}

function getBaseUrl(): string {
  return getConfig()?.server?.base_url ?? process.env.OPENCONFER_BASE_URL ?? "http://127.0.0.1:8787";
}

async function checkServerHealth(baseUrl: string): Promise<Response | null> {
  try {
    return await fetch(`${baseUrl}/health`);
  } catch {
    return null;
  }
}

function localhostFallbackUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.hostname !== "localhost") return null;
    url.hostname = "127.0.0.1";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function getToken(): string {
  return (
    process.env.OPENCONFER_API_TOKEN ??
    getConfig()?.auth?.api_token ??
    ""
  );
}

function isOpenConferRoot(dir: string): boolean {
  return (
    existsSync(join(dir, "pnpm-workspace.yaml")) &&
    existsSync(join(dir, "apps", "web", "package.json"))
  );
}

function walkUpForRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (isOpenConferRoot(dir)) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Locate a source checkout that contains apps/web (for `openconfer web`). */
function findSourceRoot(): string | null {
  const fromEnv = process.env.OPENCONFER_SOURCE_DIR;
  if (fromEnv && isOpenConferRoot(fromEnv)) return fromEnv;

  const marker = join(homedir(), ".openconfer", "source-dir");
  if (existsSync(marker)) {
    const recorded = readFileSync(marker, "utf8").trim();
    if (recorded && isOpenConferRoot(recorded)) return recorded;
  }

  const fromCwd = walkUpForRoot(process.cwd());
  if (fromCwd) return fromCwd;

  // Running from apps/cli/dist or a local deploy that still sits in-tree.
  try {
    return walkUpForRoot(fileURLToPath(new URL(".", import.meta.url)));
  } catch {
    return null;
  }
}

async function api(path: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...options.headers,
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }
  return body;
}

program.name("openconfer").description("OpenConfer — human decision infrastructure for AI agents").version("0.1.0");

program
  .command("init")
  .description("Initialize OpenConfer configuration")
  .action(async () => {
    const { mkdirSync, writeFileSync, existsSync: ex, readFileSync: read } = await import("node:fs");
    const { randomBytes } = await import("node:crypto");
    const dir = join(homedir(), ".openconfer");
    const configPath = process.env.OPENCONFER_CONFIG ?? join(dir, "config.yaml");

    if (ex(configPath)) {
      const existing = getToken() || /api_token:\s*(\S+)/.exec(read(configPath, "utf8"))?.[1] || "";
      console.log(`Config already exists: ${configPath}`);
      if (existing) {
        console.log("");
        console.log("Your API token (paste into the web inbox):");
        console.log("");
        console.log(existing);
        console.log("");
      }
      console.log("Next steps:");
      console.log("  1. openconfer serve");
      console.log("  2. In another terminal: openconfer web");
      console.log("  3. Open http://127.0.0.1:5173 and paste the token above");
      return;
    }

    if (!ex(dir)) mkdirSync(dir, { recursive: true });
    const token = `oc_${randomBytes(32).toString("hex")}`;
    const jwtSecret = `oc_${randomBytes(32).toString("hex")}`;
    writeFileSync(
      configPath,
      `# OpenConfer configuration
server:
  base_url: http://127.0.0.1:8787
  web_url: http://127.0.0.1:5173
  port: 8787
  host: 0.0.0.0

storage:
  adapter: sqlite
  path: ~/.openconfer/openconfer.db

conversation:
  adapter: livekit
  speaking_mode: realtime
  preset: live
  model: ${DEFAULT_REALTIME_MODEL}
  voice: marin
  livekit_url: ws://127.0.0.1:7880
  livekit_public_url: ws://127.0.0.1:7880
  livekit_api_key: devkey
  livekit_api_secret: secret
  realtime:
    provider: openai
    model: ${DEFAULT_REALTIME_MODEL}
    voice: marin

routes:
  default:
    notify:
      - secure_link
    connect:
      - browser
    fallback: []

operators:
  me:
    timezone: UTC

auth:
  api_token: ${token}
  jwt_secret: ${jwtSecret}
`,
      { encoding: "utf8", mode: 0o600 },
    );
    console.log(`Created ${configPath}`);
    console.log("");
    console.log("Your API token (copy now — you will paste it in the browser):");
    console.log("");
    console.log(token);
    console.log("");
    console.log("Next steps:");
    console.log("  1. openconfer serve");
    console.log("  2. In another terminal: openconfer web");
    console.log("  3. Open http://127.0.0.1:5173 and paste the token");
  });

program
  .command("token")
  .description("Print the local API token for the operator inbox / Hermes")
  .action(() => {
    const token = getToken();
    if (!token) {
      console.error("No API token found. Run: openconfer init");
      process.exit(1);
    }
    console.log(token);
  });

program
  .command("connect")
  .description("Connect an agent harness to this OpenConfer instance")
  .argument("[harness]", "harness name: hermes | openclaw | claude-code | codex", "hermes")
  .option("--list", "List supported harnesses")
  .action(async (harness: string, opts: { list?: boolean }) => {
    const { connectHarness, listHarnesses } = await import("./connect.js");
    if (opts.list) {
      for (const name of listHarnesses()) console.log(name);
      return;
    }
    try {
      const result = connectHarness(harness);
      console.log(`Connected ${result.harness}.\n`);
      for (const step of result.steps) {
        if (step.startsWith("  ")) console.log(step);
        else console.log(`✓ ${step}`);
      }
      console.log("\nThat’s it — no manual env exporting needed.");
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("web")
  .description("Start the operator web UI (Vite dev server)")
  .action(async () => {
    const root = findSourceRoot();
    if (!root) {
      console.error("Could not find an OpenConfer source checkout with apps/web.");
      console.error("Run this from the repo, or set OPENCONFER_SOURCE_DIR, or re-run pnpm setup.");
      process.exit(1);
    }

    const { spawn, spawnSync } = await import("node:child_process");
    const pnpmCheck = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
    if (pnpmCheck.status !== 0) {
      console.error("pnpm is required to start the web UI. Enable it with: corepack enable");
      process.exit(1);
    }

    console.log(`Starting web UI from ${root}`);
    console.log("Open http://127.0.0.1:5173");
    const child = spawn("pnpm", ["--filter", "@openconfer/web", "dev"], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (error) => {
      console.error(`Unable to start web UI: ${error.message}`);
      process.exit(1);
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    process.on("SIGINT", () => child.kill("SIGINT"));
    process.on("SIGTERM", () => child.kill("SIGTERM"));
  });

program
  .command("serve")
  .description("Start the OpenConfer server (local LiveKit + optional OpenAI Realtime worker)")
  .option("--no-livekit", "Do not start or configure local LiveKit")
  .option("--no-voice-worker", "Do not start the OpenAI Realtime speaking agent")
  .action(async (opts: { livekit?: boolean; voiceWorker?: boolean }) => {
    if (opts.livekit !== false) {
      const { prepareVoiceForServe } = await import("./livekit-local.js");
      await prepareVoiceForServe();
    }
    let voiceChild: import("node:child_process").ChildProcess | null = null;
    if (opts.voiceWorker !== false) {
      const { startVoiceWorker } = await import("./voice-worker.js");
      const voice = startVoiceWorker();
      console.log(voice.child ? `✓ ${voice.message}` : `· ${voice.message}`);
      voiceChild = voice.child;
    }
    const { spawn } = await import("node:child_process");
    const serverPath = fileURLToPath(import.meta.resolve("@openconfer/server"));
    const serveEnv = {
      ...process.env,
      OPENCONFER_VOICE_AGENT_NAME:
        process.env.OPENCONFER_VOICE_AGENT_NAME || "openconfer-conversation",
    };
    const child = spawn("node", [serverPath], { stdio: "inherit", env: serveEnv });
    const shutdown = (code = 0) => {
      voiceChild?.kill("SIGTERM");
      process.exit(code);
    };
    child.on("error", (error) => {
      console.error(`Unable to start OpenConfer server: ${error.message}`);
      shutdown(1);
    });
    child.on("exit", (code) => shutdown(code ?? 0));
    process.on("SIGINT", () => {
      child.kill("SIGINT");
      voiceChild?.kill("SIGINT");
    });
    process.on("SIGTERM", () => {
      child.kill("SIGTERM");
      voiceChild?.kill("SIGTERM");
    });
  });

program
  .command("doctor")
  .description("Check OpenConfer installation")
  .action(async () => {
    const checks: Array<{ name: string; ok: boolean; message: string }> = [];
    const config = getConfig();
    checks.push({
      name: "config",
      ok: !!config,
      message: config ? "~/.openconfer/config.yaml found" : "Config missing — run openconfer init",
    });
    const baseUrl = getBaseUrl();
    let serverOk = false;
    let serverMessage = "Server not reachable — start it in another terminal with: openconfer serve";

    const primary = await checkServerHealth(baseUrl);
    if (primary?.ok) {
      serverOk = true;
      serverMessage = `Server OK at ${baseUrl}`;
    } else {
      const fallbackUrl = localhostFallbackUrl(baseUrl);
      if (fallbackUrl) {
        const fallback = await checkServerHealth(fallbackUrl);
        if (fallback?.ok) {
          serverOk = false;
          serverMessage =
            `Server reachable at ${fallbackUrl}, but not at ${baseUrl}. ` +
            "Update server.base_url in ~/.openconfer/config.yaml to use 127.0.0.1 instead of localhost.";
        }
      }
    }

    checks.push({
      name: "server",
      ok: serverOk,
      message: serverMessage,
    });
    checks.push({
      name: "auth",
      ok: !!getToken(),
      message: getToken() ? "API token configured" : "API token missing",
    });
    for (const c of checks) {
      console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.message}`);
    }
    if (!checks.every((c) => c.ok)) process.exit(1);
  });

program
  .command("config")
  .description("Show configuration")
  .option("--json", "JSON output")
  .action((opts) => {
    const config = getConfig();
    if (!config) {
      console.error("Config not found");
      process.exit(1);
    }
    const safe = { ...config, auth: { configured: !!config.auth?.api_token } };
    if (opts.json) console.log(JSON.stringify(safe, null, 2));
    else console.log(JSON.stringify(safe, null, 2));
  });

const session = program.command("session").description("Manage confer sessions");

session
  .command("create")
  .description("Create a confer session")
  .option("--file <path>", "Read session JSON from a file")
  .option("--stdin", "Read session JSON from stdin")
  .option("--wait", "Wait for completion")
  .option("--json", "JSON output")
  .action(async (opts) => {
    let body: Record<string, unknown>;
    try {
      body = readSessionCreateInput(opts);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
      return;
    }
    const result = await api("/v1/sessions", { method: "POST", body: JSON.stringify(body) });
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Session created: ${result.id}`);
      console.log(`Status: ${result.status}`);
      if (result.join_url) console.log(`Join: ${result.join_url}`);
    }
    if (opts.wait) {
      await waitForSession(String(result.id), opts.json);
    }
  });

session
  .command("get <id>")
  .option("--json", "JSON output")
  .action(async (id, opts) => {
    const result = await api(`/v1/sessions/${id}`);
    console.log(opts.json ? JSON.stringify(result, null, 2) : formatSession(result));
  });

session
  .command("wait <id>")
  .option("--json", "JSON output")
  .action(async (id, opts) => {
    await waitForSession(id, opts.json);
  });

session
  .command("list")
  .option("--json", "JSON output")
  .action(async (opts) => {
    const result = await api("/v1/sessions");
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const s of (result.sessions as Record<string, unknown>[]) ?? []) {
        console.log(`${s.id}\t${s.status}\t${s.objective}`);
      }
    }
  });

session
  .command("cancel <id>")
  .option("--json", "JSON output")
  .action(async (id, opts) => {
    const result = await api(`/v1/sessions/${id}/cancel`, { method: "POST", body: "{}" });
    console.log(opts.json ? JSON.stringify(result, null, 2) : `Cancelled: ${id}`);
  });

session
  .command("result <id>")
  .option("--json", "JSON output")
  .action(async (id, opts) => {
    const result = await api(`/v1/sessions/${id}`);
    if (!result.result) {
      console.error("No result yet");
      process.exit(1);
    }
    console.log(opts.json ? JSON.stringify(result, null, 2) : JSON.stringify(result.result, null, 2));
  });

session
  .command("ack <id>")
  .description("Acknowledge that a session result was applied")
  .option("--run-id <runId>", "Continuation run ID")
  .option("--json", "JSON output")
  .action(async (id, opts) => {
    const result = await api(`/v1/sessions/${id}/ack`, {
      method: "POST",
      body: JSON.stringify({ run_id: opts.runId }),
    });
    console.log(opts.json ? JSON.stringify(result, null, 2) : `Acknowledged: ${id}`);
  });

const adapter = program.command("adapter").description("Manage adapters");

adapter
  .command("list")
  .description("List available adapters")
  .option("--json", "JSON output")
  .action((opts) => {
    const adapters = [
      { name: "secure_link", kind: "notification", description: "Secure join link notifier" },
      { name: "web_push", kind: "notification", description: "Web push (post-MVP, not available)" },
      { name: "browser", kind: "conversation", description: "Browser WebRTC session" },
      { name: "livekit", kind: "conversation", description: "LiveKit realtime rooms" },
      { name: "sqlite", kind: "storage", description: "SQLite durable storage" },
    ];
    if (opts.json) console.log(JSON.stringify({ adapters }, null, 2));
    else adapters.forEach((a) => console.log(`${a.name}\t${a.kind}\t${a.description}`));
  });

adapter
  .command("test")
  .description("Test an adapter")
  .argument("<name>", "Adapter name")
  .action(async (name) => {
    const tests: Record<string, () => Promise<{ ok: boolean; message: string }>> = {
      secure_link: async () => ({ ok: true, message: "Secure link notifier ready" }),
      web_push: async () => ({
        ok: false,
        message: "Web push is post-MVP; use secure_link as the default notifier",
      }),
      browser: async () => ({ ok: true, message: "Browser conversation adapter ready" }),
      livekit: async () => ({
        ok: !!process.env.LIVEKIT_API_KEY,
        message: process.env.LIVEKIT_API_KEY ? "LiveKit configured" : "Browser mock mode (no LiveKit key)",
      }),
    };
    const test = tests[name];
    if (!test) {
      console.error(`Unknown adapter: ${name}`);
      process.exit(1);
    }
    const result = await test();
    console.log(`${result.ok ? "✓" : "✗"} ${name}: ${result.message}`);
    if (!result.ok) process.exit(1);
  });

const events = program.command("events").description("Session events");

events
  .command("tail")
  .description("Tail session events via polling")
  .requiredOption("--session <id>", "Session ID")
  .action(async (opts) => {
    const seen = new Set<string>();
    while (true) {
      const data = await api(`/v1/sessions/${opts.session}/events`);
      const evts = (data.events as Array<{ id: string; type: string; createdAt?: string; created_at?: string }>) ?? [];
      for (const e of [...evts].reverse()) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        const ts = e.createdAt ?? e.created_at ?? "";
        console.log(`${ts}\t${e.type}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  });

async function waitForSession(id: string, json?: boolean): Promise<Record<string, unknown>> {
  const terminal = [
    "completed",
    "result_delivered",
    "result_acknowledged",
    "declined",
    "expired",
    "cancelled",
    "failed",
    "policy_blocked",
  ];
  while (true) {
    const session = await api(`/v1/sessions/${id}`);
    if (terminal.includes(String(session.status))) {
      if (json) console.log(JSON.stringify(session, null, 2));
      else console.log(`Session ${id}: ${session.status}`);
      if (session.result) console.log(JSON.stringify(session.result, null, 2));
      return session;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function formatSession(s: Record<string, unknown>) {
  return [
    `ID: ${s.id}`,
    `Status: ${s.status}`,
    `Objective: ${s.objective}`,
    s.join_url ? `Join: ${s.join_url}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

program.parse();
