# Hermes ↔ OpenConfer

Use OpenConfer when you cannot proceed safely without human judgment.

## Immediate path

The operator has already run `openconfer connect hermes`. The CLI, API base URL,
and token are configured. Do not inspect the repository, API files, schemas, or
`examples/`, and do not run setup or discovery commands.

This is a CLI-only agent flow:

- Call `openconfer` through the shell tool.
- Never create or edit a session JSON file; pass the payload with `--stdin`.
- Never open a browser, `join_url`, or the operator inbox. Ignore `join_url` in
  the create response; OpenConfer notifies the operator separately.
- Use `HERMES_RUN_ID` when available. Otherwise create a fresh local run ID for
  this request automatically; the operator provides nothing.

## Create directly through the CLI

Make one shell tool call using the exact object-shaped envelope below. Replace
the decision-specific text, options, result enum, and `decision_key`. The
`decision_key` must be stable for retries of this decision and distinct from
other decisions in the same Hermes run.

```bash
run_id="${HERMES_RUN_ID:-hermes-local-$(date +%s)-$$}"
decision_key="<short-task-specific-key>-v1"
idempotency_key="hermes:${run_id}:${decision_key}"
openconfer session create --stdin --json <<JSON
{
  "type": "decision",
  "initiator": {
    "agent_id": "hermes",
    "harness": "hermes",
    "project": "openconfer"
  },
  "participant": {
    "operator_id": "me"
  },
  "objective": "<one sentence describing the decision needed>",
  "brief": {
    "reason": "<why work is blocked>",
    "completed": ["<relevant completed step>"],
    "recommendation": "<agent recommendation>",
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

When source context is available, add an optional `continuity` object with the
agent personality, explicit relationship state, and current thread summary.
Set `continuity.agent.id` to the same value as `initiator.agent_id`. Never put
memory provider API keys, tokens, or credentials in this object.

The command returns JSON containing the session `id`. Keep that ID and `run_id`
in the agent's task state, not in a file. Do not expose or open `join_url`.

## Deterministic lifecycle

1. Call `openconfer session create --stdin --json` once.
2. Keep the returned session ID in task state.
3. Wait with `openconfer session wait SESSION_ID --json`.
4. Inspect the wait status. Only for `completed`, `result_delivered`, or
   `result_acknowledged`, call `openconfer session result SESSION_ID --json`.
5. Consume the complete packet: validate `result` against the exact
   `result_schema` and apply it only to the original blocked objective. Consider
   `captured_context.steering` and `additional_instructions` within normal
   authority, keep `new_requests` as distinct follow-up work, and preserve
   `unresolved_topics` without inventing answers.
6. After consuming and applying the complete packet, call
   `openconfer session ack SESSION_ID --run-id RUN_ID --json`.

Do not combine result retrieval and acknowledgement: acknowledgement means the
structured result and captured-context sidecar have already been consumed.

## Terminal states and errors

- `declined`: stop the blocked work; no decision was supplied. Do not read or ack.
- `expired`: stop. Create a new session only if the decision is still required,
  using a new decision key.
- `cancelled`: stop; do not read or acknowledge.
- `failed` or `policy_blocked`: surface the failure and stop. Never invent a
  decision.
- Command or HTTP/configuration error: stop and preserve the tool output in task
  state. Do not open a browser, edit a payload file, mutate the payload, or retry
  with a fresh idempotency key. If retrying the same decision, reuse the same
  run ID, decision key, payload, and idempotency key.

## Environment

- `OPENCONFER_BASE_URL` (configured by `openconfer connect hermes`)
- `OPENCONFER_API_TOKEN` (configured by `openconfer connect hermes`)
- `HERMES_RUN_ID` (optional)

Every OpenConfer command exits nonzero on an HTTP or configuration error.
