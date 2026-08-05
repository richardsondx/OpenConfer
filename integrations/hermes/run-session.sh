#!/usr/bin/env bash
# Hermes helper: create → wait → validate → resume → acknowledge.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: run-session.sh --file SESSION.json [--run-id RUN_ID] [--json]

Requires:
  OPENCONFER_BASE_URL
  OPENCONFER_API_TOKEN
  openconfer on PATH (or OPENCONFER_BIN)
EOF
}

file=""
run_id="${HERMES_RUN_ID:-hermes-$(date +%s)}"
json=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) file="$2"; shift 2 ;;
    --run-id) run_id="$2"; shift 2 ;;
    --json) json=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$file" || ! -f "$file" ]]; then
  echo "--file SESSION.json is required" >&2
  exit 2
fi

: "${OPENCONFER_BASE_URL:?Set OPENCONFER_BASE_URL}"
: "${OPENCONFER_API_TOKEN:?Set OPENCONFER_API_TOKEN}"

bin="${OPENCONFER_BIN:-openconfer}"
if ! command -v "$bin" >/dev/null 2>&1; then
  echo "openconfer executable not found; set OPENCONFER_BIN" >&2
  exit 1
fi

state_dir="${HERMES_STATE_DIR:-${TMPDIR:-/tmp}/openconfer-hermes}"
mkdir -p "$state_dir"

create_json="$("$bin" session create --file "$file" --json)"
session_id="$(printf '%s' "$create_json" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
if [[ -z "$session_id" ]]; then
  echo "Failed to parse session id from create response" >&2
  echo "$create_json" >&2
  exit 1
fi

printf '%s\n' "$session_id" >"$state_dir/last-session-id"
printf '%s\n' "$create_json" >"$state_dir/$session_id.create.json"

"$bin" session wait "$session_id" --json >"$state_dir/$session_id.wait.json"
result_json="$("$bin" session result "$session_id" --json)"
printf '%s' "$result_json" >"$state_dir/$session_id.result.json"

if ! printf '%s' "$result_json" | grep -q '"status"[[:space:]]*:[[:space:]]*"completed"\|"result_delivered"\|"result_acknowledged"'; then
  # Accept completed/result_* payloads; also allow nested status fields from CLI.
  if ! printf '%s' "$result_json" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"(completed|result_delivered|result_acknowledged)"'; then
    echo "Result is not in a resumable completed state" >&2
    echo "$result_json" >&2
    exit 1
  fi
fi

# Validate that a result object is present before acknowledging.
if ! printf '%s' "$result_json" | grep -q '"result"'; then
  echo "Result payload missing result object" >&2
  exit 1
fi

ack_json="$("$bin" session ack "$session_id" --run-id "$run_id" --json)"
printf '%s' "$ack_json" >"$state_dir/$session_id.ack.json"

if [[ "$json" -eq 1 ]]; then
  printf '{"session_id":"%s","run_id":"%s","create":%s,"result":%s,"ack":%s}\n' \
    "$session_id" "$run_id" "$create_json" "$result_json" "$ack_json"
else
  echo "Session $session_id completed and acknowledged for run $run_id"
  echo "State directory: $state_dir"
fi
