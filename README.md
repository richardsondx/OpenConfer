# OpenConfer

> Talk with your AI agents when they need a decision.

OpenConfer is voice infrastructure for autonomous agents to call humans, resolve decisions, and resume work with structured outcomes.

OpenConfer lets autonomous agents call you, explain what they need, and continue working with your answer. An agent creates a confer session with its context and the decision it needs; OpenConfer reaches you by voice (or a configured transport), captures a confirmed outcome, and returns that result to the original run.

OpenConfer does not orchestrate your agents. It gives them a human decision interface.

Self-hosted · Model-agnostic · Transport-agnostic · Apache 2.0

## Quick start

### From source (recommended for development)

**Requirements:** Node.js 20+ and pnpm (`corepack enable`)

```bash
git clone https://github.com/openconfer/openconfer.git
cd openconfer
pnpm setup
```

This builds the repo and installs the `openconfer` command to `~/.local/bin/openconfer`.

If you see `command not found: openconfer`, add the install directory to your PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add that line to `~/.zshrc` or `~/.bashrc`, then open a new terminal.

Verify the install, then open the operator UI:

```bash
openconfer --version
openconfer init
openconfer doctor
openconfer serve
```

In a second terminal:

```bash
openconfer web
```

`openconfer init` prints your **access key** (re-print with `openconfer token`).
Open [http://127.0.0.1:5173](http://127.0.0.1:5173), paste that key, then
**Start test call** (sandbox, no agent) or connect Hermes with one command:

```bash
openconfer connect hermes
```

That writes credentials into `~/.hermes/.env` and installs the skill at
`~/.hermes/skills/openconfer/`. The web **Settings → Connect Hermes** panel
shows the same command plus a skill.md preview you can copy. Settings saves
supported fields back to `config.yaml`.

Alternative install (same result):

```bash
./scripts/setup.sh
# or
./scripts/install.sh   # auto-detects a source checkout
```

### Without installing the CLI

If you prefer not to add `openconfer` to your PATH:

```bash
pnpm install
pnpm build
node apps/cli/dist/index.js init
node apps/cli/dist/index.js serve
node apps/cli/dist/index.js web
```

### Published npm install

Once `@openconfer/cli` releases are published, the installer defaults to npm
and accepts a pinned version:

```bash
curl -fsSL https://raw.githubusercontent.com/openconfer/openconfer/main/scripts/install.sh | \
  OPENCONFER_VERSION=0.2.0 bash
```

The installer fails if the requested package/version cannot be installed. Use
`OPENCONFER_PREFIX` for a non-default install prefix.

### Docker

```bash
docker compose up --build
docker compose exec openconfer-server cat /root/.openconfer/api-token
```

Compose generates and persists an API token when `OPENCONFER_API_TOKEN` is not
set. Set `OPENCONFER_PUBLIC_URL` when the browser is not available at
`http://localhost:5173`; generated join links use that public origin.

## Core flow

1. Agent pings → confer session created
2. Operator joins in browser
3. Human confirms structured decision
4. Result delivered via webhook
5. Agent acknowledges and resumes

Run the signed-webhook example from a source checkout with local callbacks
explicitly enabled:

```bash
OPENCONFER_ALLOW_LOCAL_CALLBACKS=1 openconfer serve
node examples/decision-session/harness.mjs
openconfer session create --file examples/decision-session/session.json
```

The harness verifies the timestamped signature, rejects replayed event IDs,
acknowledges the result, and prints when the originating run resumes. Change the
example secret before adapting it outside local development.

## CLI

Install the CLI first with `pnpm setup` (see Quick start), then:

```bash
openconfer init
openconfer serve
openconfer doctor
openconfer session create --file session.json
openconfer session wait SESSION_ID
openconfer session result SESSION_ID
openconfer session ack SESSION_ID
openconfer events tail --session SESSION_ID
```

## Troubleshooting

**`command not found: openconfer`**

Run `pnpm setup` from the repo root, then add `~/.local/bin` to your PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

**`openconfer doctor` reports the server is unreachable**

Start the server in another terminal with `openconfer serve`.

**API calls fail with `{}` or unexpected responses**

Another process may be bound to port 8787. Prefer `127.0.0.1` over `localhost` in
`~/.openconfer/config.yaml`:

```yaml
server:
  base_url: http://127.0.0.1:8787
```

## Notifications

The default notifier is `secure_link` (prints or delivers a signed join URL).
Web push is post-MVP and is not treated as available until VAPID keys and a
subscription store ship.

When a session is Waiting, the operator inbox rings briefly (soft chime + pulse).
**Snooze** parks the session for a duration you set in Settings (default 3
minutes) and alerts you again through every configured channel when the timer
fires. Ignoring a short ring leaves the session Waiting in the inbox until you
act or snooze. Each inbox session has an obvious **Copy link** action for its
secure join URL. Alert style, sound, snooze duration, and quiet hours are
configurable under Settings → Incoming calls.

Outbound phone calls use a bounded callback policy configured in **Settings →
Incoming calls**. The default **Brief** policy retries at about 1 and 5 minutes
and stops after 10 minutes; **Persistent** retries at about 1, 3, 7, 15, and 25
minutes and stops after 30 minutes; **Never** disables automatic callbacks. A
dropped call preserves the latest unconfirmed decision preview. The next call
reads it back and requires fresh confirmation. Operators can call again
manually or stop callbacks for an individual open session at any time.

Connected voice calls are bounded to prevent idle model and phone spend. After
90 seconds without user speech, or after 10 minutes total, OpenConfer closes the
Realtime connection, LiveKit room, and any Twilio call while leaving the
decision open in the inbox. Override these limits with
`OPENCONFER_VOICE_IDLE_TIMEOUT_MS` and `OPENCONFER_VOICE_MAX_DURATION_MS`.

## Conversation modes

Voice has two independent parts:

1. **LiveKit room** — audio transport. `openconfer serve` writes local credentials
   and starts a LiveKit dev server when Docker is available (`--no-livekit` to skip).
2. **OpenAI Realtime speaking agent** — `gpt-realtime-2.1` in the room. This uses
   the developer Realtime API, not ChatGPT's GPT-Live model (which is not yet API-accessible). Paste an
   OpenAI API key in **Settings → Voice** (or set `OPENAI_API_KEY`). `openconfer serve`
   starts the conversation worker when a key is present (`--no-voice-worker` to skip).

The UI reports **Voice ready** only when LiveKit is actually reachable **and** an
OpenAI key is configured. Saved LiveKit credentials alone are not “ready.”

Text decision forms remain available if either piece is down.

For LiveKit Cloud, set credentials in **Settings → Voice** (or env
`LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` in Compose).

## License

Apache 2.0

## Author

[Richardson Dackam](https://github.com/richardsondx) · [X](http://x.com/richardsondx)
