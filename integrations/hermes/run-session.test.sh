#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fake_bin="$tmp/openconfer"
cat >"$fake_bin" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; sub="${2:-}"
if [[ "$cmd" == "session" && "$sub" == "create" ]]; then
  echo '{"id":"ses_hermes_test","status":"notified","join_url":"http://localhost/join/ses_hermes_test"}'
  exit 0
fi
if [[ "$cmd" == "session" && "$sub" == "wait" ]]; then
  echo '{"id":"ses_hermes_test","status":"completed"}'
  exit 0
fi
if [[ "$cmd" == "session" && "$sub" == "result" ]]; then
  echo '{"id":"ses_hermes_test","status":"completed","result":{"selected_option":"browser","constraints":[]}}'
  exit 0
fi
if [[ "$cmd" == "session" && "$sub" == "ack" ]]; then
  echo '{"id":"ses_hermes_test","status":"result_acknowledged"}'
  exit 0
fi
echo "unexpected: $*" >&2
exit 1
EOF
chmod +x "$fake_bin"

export OPENCONFER_BASE_URL="http://127.0.0.1:8787"
export OPENCONFER_API_TOKEN="oc_test"
export OPENCONFER_BIN="$fake_bin"
export HERMES_STATE_DIR="$tmp/state"

out="$("$root/integrations/hermes/run-session.sh" --file "$root/examples/decision-session/session.json" --run-id run_test --json)"
echo "$out" | grep -q 'ses_hermes_test'
test -f "$tmp/state/last-session-id"
test -f "$tmp/state/ses_hermes_test.result.json"
test -f "$tmp/state/ses_hermes_test.ack.json"
echo "hermes run-session helper ok"
