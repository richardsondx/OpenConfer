import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export type ConnectResult = {
  harness: string;
  steps: string[];
  skillPath?: string;
  envPath?: string;
  configPath?: string;
};

function getOpenConferConfig(): { baseUrl: string; token: string } {
  const configPath = process.env.OPENCONFER_CONFIG ?? join(homedir(), ".openconfer", "config.yaml");
  if (!existsSync(configPath)) {
    throw new Error("No OpenConfer config found. Run: openconfer init");
  }
  const config = parseYaml(readFileSync(configPath, "utf8")) as {
    server?: { base_url?: string };
    auth?: { api_token?: string };
  };
  const token = process.env.OPENCONFER_API_TOKEN ?? config.auth?.api_token ?? "";
  if (!token) throw new Error("No API token in config. Run: openconfer init");
  const baseUrl =
    process.env.OPENCONFER_BASE_URL ?? config.server?.base_url ?? "http://127.0.0.1:8787";
  return { baseUrl, token };
}

function upsertEnvFile(path: string, vars: Record<string, string>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let content = existsSync(path) ? readFileSync(path, "utf8") : "";
  const blockKeys = Object.keys(vars);
  for (const key of blockKeys) {
    const value = vars[key]!;
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      const suffix = content.trimEnd().length ? "\n" : "";
      content = `${content.trimEnd()}${suffix}\n# OpenConfer\n${line}\n`;
    }
  }
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function findRepoSkill(): string | null {
  const candidates = [
    process.env.OPENCONFER_SOURCE_DIR
      ? join(process.env.OPENCONFER_SOURCE_DIR, "integrations/hermes/SKILL.md")
      : "",
    join(process.cwd(), "integrations/hermes/SKILL.md"),
    // From installed CLI: .../lib/openconfer/dist → try sibling checkout is uncommon;
    // prefer bundled template via generateHermesSkill.
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  // Resolve relative to this file when running from monorepo apps/cli/dist
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const fromCliDist = join(here, "../../../integrations/hermes/SKILL.md");
    if (existsSync(fromCliDist)) return fromCliDist;
  } catch {
    /* ignore */
  }
  return null;
}

export function generateHermesSkillMarkdown(baseUrl: string): string {
  const source = findRepoSkill();
  if (source) {
    const md = readFileSync(source, "utf8");
    return md.replace(
      /## Environment\n\n- `OPENCONFER_BASE_URL`/,
      `## Environment\n\nExpected base URL: \`${baseUrl}\`\n\n- \`OPENCONFER_BASE_URL\``,
    );
  }
  return `# Hermes ↔ OpenConfer

Use OpenConfer when you cannot proceed safely without human judgment.

## Immediate path

The operator already ran \`openconfer connect hermes\`. The CLI and environment are ready.

Do not inspect the repository or run setup/discovery commands. Call \`openconfer\` through the shell tool. Never create or edit a session JSON file; pass the payload with \`--stdin\`.

Never open a browser, \`join_url\`, or the operator inbox. Ignore \`join_url\`; OpenConfer notifies the operator separately. The operator provides no per-run values.

Expected API: \`${baseUrl}\`

## Create directly through the CLI

Use a task-specific \`decision_key\`; reuse it only for retries of the exact same decision.

\`\`\`bash
run_id="\${HERMES_RUN_ID:-hermes-local-$(date +%s)-$$}"
decision_key="<short-task-specific-key>-v1"
idempotency_key="hermes:\${run_id}:\${decision_key}"
openconfer session create --stdin --json <<JSON
{
  "type": "decision",
  "initiator": { "agent_id": "hermes", "harness": "hermes", "project": "openconfer" },
  "participant": { "operator_id": "me" },
  "objective": "<one sentence describing the decision needed>",
  "brief": {
    "reason": "<why work is blocked>",
    "completed": ["<relevant completed step>"],
    "recommendation": "<agent recommendation>",
    "options": [{ "id": "<option-id>", "label": "<human-readable option>" }]
  },
  "result_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["selected_option", "constraints"],
    "properties": {
      "selected_option": { "type": "string", "enum": ["<option-id>", "defer"] },
      "constraints": { "type": "array", "items": { "type": "string" } }
    }
  },
  "routing": { "policy": "default" },
  "continuation": { "run_id": "\${run_id}", "opaque_token": "\${decision_key}" },
  "urgency": "normal",
  "estimated_duration_minutes": 3,
  "idempotency_key": "\${idempotency_key}"
}
JSON
\`\`\`

Keep the returned ID in agent task state, not a file. Then wait, read only after a completed status, verify/apply the structured result, and acknowledge only after applying it:

\`\`\`bash
openconfer session wait SESSION_ID --json
openconfer session result SESSION_ID --json
# Apply the validated result before the next command.
openconfer session ack SESSION_ID --run-id RUN_ID --json
\`\`\`

## Terminal states and errors

For \`declined\`, \`expired\`, \`cancelled\`, \`failed\`, or \`policy_blocked\`, stop without acknowledging or inventing a decision. On any command or HTTP/configuration error, stop; do not edit a payload file or retry with a fresh key.
`;
}

function connectHermes(): ConnectResult {
  const { baseUrl, token } = getOpenConferConfig();
  const hermesHome = process.env.HERMES_HOME ?? join(homedir(), ".hermes");
  const envPath = join(hermesHome, ".env");
  const skillDir = join(hermesHome, "skills", "openconfer");
  const skillPath = join(skillDir, "SKILL.md");

  if (!existsSync(hermesHome)) {
    throw new Error(
      `Hermes folder not found at ${hermesHome}. Install Hermes first, or set HERMES_HOME.`,
    );
  }

  upsertEnvFile(envPath, {
    OPENCONFER_BASE_URL: baseUrl,
    OPENCONFER_API_TOKEN: token,
  });

  mkdirSync(skillDir, { recursive: true });
  const skill = generateHermesSkillMarkdown(baseUrl);
  writeFileSync(skillPath, skill, "utf8");

  // Also stash under OpenConfer home for the UI / recovery
  const stashDir = join(homedir(), ".openconfer", "harness", "hermes");
  mkdirSync(stashDir, { recursive: true });
  writeFileSync(join(stashDir, "SKILL.md"), skill, "utf8");
  writeFileSync(
    join(stashDir, "env"),
    `OPENCONFER_BASE_URL=${baseUrl}\nOPENCONFER_API_TOKEN=${token}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  return {
    harness: "hermes",
    envPath,
    skillPath,
    steps: [
      `Saved OpenConfer credentials to ${envPath}`,
      `Installed Hermes skill at ${skillPath}`,
      "Restart Hermes (or start a new chat) so it picks up the skill and env.",
      "When Hermes needs a human, a session appears in your OpenConfer inbox.",
    ],
  };
}

function connectOpenclaw(): ConnectResult {
  const { baseUrl, token } = getOpenConferConfig();
  const stashDir = join(homedir(), ".openconfer", "harness", "openclaw");
  mkdirSync(stashDir, { recursive: true });
  const configPath = join(stashDir, "openconfer.plugin.config.json");
  const pluginConfig = {
    baseUrl,
    apiToken: token,
    agentId: "openclaw",
    operatorId: "me",
    webhookPort: 8788,
    callbackUrl: "http://127.0.0.1:8788/openconfer/events",
  };
  writeFileSync(configPath, `${JSON.stringify(pluginConfig, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  const repoPlugin = [
    process.env.OPENCONFER_SOURCE_DIR
      ? join(process.env.OPENCONFER_SOURCE_DIR, "integrations/openclaw")
      : "",
    join(process.cwd(), "integrations/openclaw"),
  ].find((p) => p && existsSync(join(p, "openclaw.plugin.json")));

  const steps = [
    `Wrote OpenClaw plugin config to ${configPath}`,
  ];
  if (repoPlugin) {
    steps.push(
      `From your OpenConfer checkout, run:`,
      `  openclaw plugins install --link ${repoPlugin}`,
      `  openclaw plugins enable openconfer`,
      `  openclaw gateway restart`,
      `Then paste the JSON from ${configPath} into plugins.entries.openconfer.config in openclaw.json`,
    );
  } else {
    steps.push(
      "Install the OpenConfer OpenClaw plugin from your OpenConfer checkout:",
      "  openclaw plugins install --link ./integrations/openclaw",
      "  openclaw plugins enable openconfer",
      `Merge ${configPath} into plugins.entries.openconfer.config`,
    );
  }
  steps.push("Start OpenConfer with OPENCONFER_ALLOW_LOCAL_CALLBACKS=1 for local webhooks.");

  return { harness: "openclaw", configPath, steps };
}

const HARNESSES = ["hermes", "openclaw"] as const;
export type HarnessName = (typeof HARNESSES)[number];

export function connectHarness(name: string): ConnectResult {
  const harness = name.toLowerCase() as HarnessName;
  if (!HARNESSES.includes(harness)) {
    throw new Error(`Unknown harness "${name}". Supported: ${HARNESSES.join(", ")}`);
  }
  if (harness === "hermes") return connectHermes();
  return connectOpenclaw();
}

export function listHarnesses(): string[] {
  return [...HARNESSES];
}
