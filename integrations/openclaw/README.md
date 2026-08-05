# OpenClaw integration

Native OpenClaw plugin that creates OpenConfer sessions, waits for human
results, verifies signed webhooks, routes them to the correct OpenClaw task,
and acknowledges automatically.

## Install from this checkout

```bash
openclaw plugins install --link ./integrations/openclaw
openclaw plugins enable openconfer
openclaw gateway restart
openclaw plugins inspect openconfer --runtime --json
```

Configure `plugins.entries.openconfer.config` in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openconfer": {
        "enabled": true,
        "config": {
          "baseUrl": "http://localhost:8787",
          "apiToken": "oc_your_token",
          "agentId": "openclaw",
          "operatorId": "me",
          "webhookSecret": "callback-secret-long-enough",
          "callbackUrl": "http://127.0.0.1:8788/openconfer/events",
          "webhookPort": 8788
        }
      }
    }
  }
}
```

For local callbacks, start OpenConfer with `OPENCONFER_ALLOW_LOCAL_CALLBACKS=1`.

## Flow

1. Agent calls `request_human_session` (idempotent via tool-call ID)
2. Plugin POSTs to OpenConfer `/v1/sessions` with `continuation.run_id`
3. Human joins, decides, and confirms
4. OpenConfer delivers a signed webhook to the plugin receiver
5. Plugin verifies signature + replay window, routes to the tracked task, and ACKs
6. Or the agent polls with `wait_human_session` / `acknowledge_human_session`

## Tests

```bash
pnpm --filter @openconfer/openclaw test
```
