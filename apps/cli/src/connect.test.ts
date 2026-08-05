import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateHermesSkillMarkdown } from "./connect.js";

describe("generateHermesSkillMarkdown", () => {
  it("injects the base URL and requires direct CLI input without file edits", () => {
    const skill = generateHermesSkillMarkdown("https://confer.example.test");

    assert.match(skill, /Expected base URL: `https:\/\/confer\.example\.test`/);
    assert.match(skill, /Never create or edit a session JSON file/);
    assert.match(skill, /openconfer session create --stdin --json/);
    assert.match(skill, /Never open a browser, `join_url`, or the operator inbox/);
    assert.match(skill, /hermes-local-\$\(date \+%s\)-\$\$/);
    assert.match(skill, /"initiator": \{/);
    assert.match(skill, /"participant": \{/);
    assert.match(skill, /"result_schema": \{/);
    assert.match(skill, /"idempotency_key": "\$\{idempotency_key\}"/);
    assert.match(skill, /Keep that ID and `run_id`\s+in the agent's task state, not in a file/);
    assert.doesNotMatch(skill, /cat >|session_file|state_dir|session create --file/);
    assert.doesNotMatch(skill, /See `examples\/decision-session\/session\.json`/);
  });
});
