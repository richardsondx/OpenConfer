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

type SkillHarness = "hermes" | "openclaw" | "claude-code" | "codex";

const HARNESS_LABELS: Record<SkillHarness, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
  "claude-code": "Claude Code",
  codex: "Codex",
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

When source context is available, add an optional continuity object with the agent personality, explicit relationship state, and current thread summary. Set continuity.agent.id to the same value as initiator.agent_id. Never put memory provider API keys, tokens, or credentials in this object.

Keep the returned ID in agent task state, not a file. Then wait and read only after a completed status. Consume the complete response packet before acknowledging it:

- Apply \`result\` only to the original blocked objective.
- Consider \`captured_context.steering\` and \`additional_instructions\` within your normal authority and the current task scope.
- Do not silently execute \`new_requests\` as part of the old task; surface or queue them as distinct follow-up work.
- Preserve \`unresolved_topics\` without inventing answers.
- Acknowledge only after consuming both \`result\` and every captured-context category.

\`\`\`bash
openconfer session wait SESSION_ID --json
openconfer session result SESSION_ID --json
# Apply the complete validated result + captured_context packet before the next command.
openconfer session ack SESSION_ID --run-id RUN_ID --json
\`\`\`

## Terminal states and errors

For \`declined\`, \`expired\`, \`cancelled\`, \`failed\`, or \`policy_blocked\`, stop without acknowledging or inventing a decision. On any command or HTTP/configuration error, stop; do not edit a payload file or retry with a fresh key.
`;
}

/** Build the same portable OpenConfer skill with harness-specific task identity. */
export function generateHarnessSkillMarkdown(harness: SkillHarness, baseUrl: string): string {
  const label = HARNESS_LABELS[harness];
  let skill = generateHermesSkillMarkdown(baseUrl);
  if (harness !== "hermes") {
    skill = skill
      .replaceAll("Hermes", label)
      .replaceAll("hermes", harness)
      .replaceAll("HERMES_RUN_ID", "OPENCONFER_RUN_ID");
  }
  if (!skill.startsWith("---\n")) {
    skill = `---\nname: openconfer\ndescription: Use OpenConfer when work is blocked on a human decision, approval, or clarification.\n---\n\n${skill}`;
  }
  return skill;
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
  const skill = generateHarnessSkillMarkdown("hermes", baseUrl);
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

function skillPathFor(harness: Exclude<SkillHarness, "hermes">): string {
  if (harness === "openclaw") return join(homedir(), ".openclaw", "skills", "openconfer", "SKILL.md");
  if (harness === "claude-code") return join(homedir(), ".claude", "skills", "openconfer", "SKILL.md");
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(codexHome, "skills", "openconfer", "SKILL.md");
}

function connectSkillHarness(harness: Exclude<SkillHarness, "hermes">): ConnectResult {
  const { baseUrl, token } = getOpenConferConfig();
  const skillPath = skillPathFor(harness);
  const skill = generateHarnessSkillMarkdown(harness, baseUrl);
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, skill, "utf8");

  const stashDir = join(homedir(), ".openconfer", "harness", harness);
  mkdirSync(stashDir, { recursive: true });
  writeFileSync(join(stashDir, "SKILL.md"), skill, "utf8");
  writeFileSync(
    join(stashDir, "env"),
    `OPENCONFER_BASE_URL=${baseUrl}\nOPENCONFER_API_TOKEN=${token}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const label = HARNESS_LABELS[harness];
  return {
    harness,
    skillPath,
    steps: [
      `Installed the OpenConfer skill for ${label} at ${skillPath}`,
      `OpenConfer credentials remain in ${join(homedir(), ".openconfer", "config.yaml")}; the skill calls the configured CLI directly.`,
      `Restart ${label} (or start a new session) so it discovers the skill.`,
      "When the agent needs a human decision, a session appears in your OpenConfer inbox.",
    ],
  };
}

const HARNESSES = ["hermes", "openclaw", "claude-code", "codex"] as const;
export type HarnessName = (typeof HARNESSES)[number];

export function connectHarness(name: string): ConnectResult {
  const harness = name.toLowerCase() as HarnessName;
  if (!HARNESSES.includes(harness)) {
    throw new Error(`Unknown harness "${name}". Supported: ${HARNESSES.join(", ")}`);
  }
  if (harness === "hermes") return connectHermes();
  return connectSkillHarness(harness);
}

export function listHarnesses(): string[] {
  return [...HARNESSES];
}
