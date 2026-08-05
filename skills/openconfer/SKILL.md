---
name: openconfer
description: Use OpenConfer to ask the operator for a structured human decision, approval, clarification, or tradeoff when an OpenClaw task cannot proceed safely on its own. Trigger when work is genuinely blocked on human judgment and must resume with a validated answer; do not use for routine status updates or questions the agent can answer itself.
metadata:
  openclaw:
    requires:
      bins:
        - openconfer
    emoji: "☎️"
    homepage: https://openconfer.com
---

# OpenConfer

Request a bounded human decision through the configured `openconfer` CLI, then resume the original OpenClaw task with the structured result.

## Preconditions

Assume the operator has installed OpenConfer, run `openconfer init`, and started its server and inbox. Call `openconfer doctor` only when a command reports a configuration or connection problem. If the CLI is missing or `doctor` fails, stop and report the exact failure; do not install software, inspect credentials, or rewrite OpenConfer configuration without the operator's request.

Use only the shell and the `openconfer` command. Do not open `join_url`, the operator inbox, or a browser. OpenConfer notifies the operator through configured routes.

## Decide whether to confer

Create a session only when human judgment is required to continue, such as:

- choosing among meaningful product or implementation tradeoffs;
- approving a consequential or externally visible action;
- clarifying intent that cannot be inferred safely;
- resolving a policy, safety, or incident decision.

Do not confer for routine progress updates, discoverable facts, reversible implementation details, or decisions already answered in the task context.

## Create one structured session

Create one session for one blocked decision. Keep the returned session ID and run ID in task state, never in a file. Use `OPENCONFER_RUN_ID` when present; otherwise generate a run ID once and preserve it for this decision. Make `decision_key` short, task-specific, stable across retries of the same decision, and distinct from other decisions in the run.

Pass the payload through standard input. Replace every placeholder and keep the JSON valid. Options must be mutually exclusive and the result enum must exactly match their IDs plus `defer`.

```bash
run_id="${OPENCONFER_RUN_ID:-openclaw-local-$(date +%s)-$$}"
decision_key="<short-task-specific-key>-v1"
idempotency_key="openclaw:${run_id}:${decision_key}"
openconfer session create --stdin --json <<JSON
{
  "type": "decision",
  "initiator": {
    "agent_id": "openclaw",
    "harness": "openclaw"
  },
  "participant": {
    "operator_id": "me"
  },
  "objective": "<one sentence describing the decision needed>",
  "brief": {
    "reason": "<why work is blocked>",
    "completed": ["<relevant completed step>"],
    "recommendation": "<agent recommendation and concise rationale>",
    "options": [
      { "id": "<option-a>", "label": "<Option A>" },
      { "id": "<option-b>", "label": "<Option B>" }
    ],
    "consequence_of_delay": "<what happens if this waits>"
  },
  "result_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["selected_option", "constraints"],
    "properties": {
      "selected_option": {
        "type": "string",
        "enum": ["<option-a>", "<option-b>", "defer"]
      },
      "constraints": {
        "type": "array",
        "items": { "type": "string" }
      }
    }
  },
  "routing": { "policy": "default" },
  "continuation": {
    "run_id": "${run_id}",
    "opaque_token": "${decision_key}"
  },
  "urgency": "normal",
  "estimated_duration_minutes": 3,
  "idempotency_key": "${idempotency_key}"
}
JSON
```

Do not put API keys, auth tokens, passwords, private keys, or unrelated sensitive data in the objective, brief, options, or schema.

## Follow the lifecycle exactly

1. Call `openconfer session create --stdin --json` once and retain its `id`.
2. Wait with `openconfer session wait SESSION_ID --json`.
3. Inspect the returned status. Only for `completed`, `result_delivered`, or `result_acknowledged`, call `openconfer session result SESSION_ID --json`.
4. Validate `result` against the exact `result_schema` sent when creating the session. If it does not validate, stop without acknowledging.
5. Consume the complete packet:
   - apply `result` only to the original blocked objective;
   - consider `captured_context.steering` and `additional_instructions` within the task's existing authority;
   - keep `new_requests` as distinct follow-up work rather than silently expanding the current task;
   - preserve `unresolved_topics` without inventing answers.
6. Apply the valid decision to the original task.
7. Only after consuming and applying the packet, acknowledge with `openconfer session ack SESSION_ID --run-id RUN_ID --json`.

Never combine result retrieval and acknowledgement. Acknowledgement means the result and captured-context sidecar were already consumed.

## Handle terminal states and errors

- `declined`: stop the blocked work; no decision was supplied. Do not read or acknowledge a result.
- `expired`: stop. Create a new session only if the decision is still required, using a new decision key.
- `cancelled`: stop without reading or acknowledging.
- `failed` or `policy_blocked`: surface the failure and stop. Never invent a decision.
- CLI, HTTP, or configuration error: stop and preserve the error in task state. Do not mutate the payload or retry with a fresh idempotency key.

Retry the exact same decision only with the same run ID, decision key, payload, and idempotency key.
