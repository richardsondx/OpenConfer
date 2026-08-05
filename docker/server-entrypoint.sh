#!/bin/sh
set -eu

state_dir=${OPENCONFER_STATE_DIR:-/root/.openconfer}
config_path=${OPENCONFER_CONFIG:-$state_dir/config.yaml}
token_path=$state_dir/api-token
jwt_path=$state_dir/jwt-secret
mkdir -p "$state_dir"

if [ -n "${OPENCONFER_API_TOKEN:-}" ]; then
  token=$OPENCONFER_API_TOKEN
elif [ -s "$token_path" ]; then
  token=$(cat "$token_path")
else
  token="oc_$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
fi

printf '%s\n' "$token" > "$token_path"
chmod 600 "$token_path"

if [ -n "${OPENCONFER_JWT_SECRET:-}" ]; then
  jwt_secret=$OPENCONFER_JWT_SECRET
elif [ -s "$jwt_path" ]; then
  jwt_secret=$(cat "$jwt_path")
else
  jwt_secret="oc_$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
fi
printf '%s\n' "$jwt_secret" > "$jwt_path"
chmod 600 "$jwt_path"

export OPENCONFER_EFFECTIVE_TOKEN=$token OPENCONFER_EFFECTIVE_JWT_SECRET=$jwt_secret OPENCONFER_STATE_DIR=$state_dir OPENCONFER_CONFIG=$config_path
node --input-type=module <<'EOF'
import { writeFileSync } from "node:fs";

const env = process.env;
const config = {
  server: {
    base_url: env.OPENCONFER_API_URL || "http://localhost:8787",
    web_url: env.OPENCONFER_PUBLIC_URL || "http://localhost:5173",
    port: 8787,
    host: "0.0.0.0",
  },
  storage: {
    adapter: "sqlite",
    path: `${env.OPENCONFER_STATE_DIR}/openconfer.db`,
  },
  conversation: {
    adapter: "livekit",
    model: "openai-compatible",
    voice: "default",
    ...(env.LIVEKIT_URL ? { livekit_url: env.LIVEKIT_URL } : {}),
    ...(env.LIVEKIT_PUBLIC_URL ? { livekit_public_url: env.LIVEKIT_PUBLIC_URL } : {}),
    ...(env.LIVEKIT_API_KEY ? { livekit_api_key: env.LIVEKIT_API_KEY } : {}),
    ...(env.LIVEKIT_API_SECRET ? { livekit_api_secret: env.LIVEKIT_API_SECRET } : {}),
  },
  routes: {
    default: { notify: ["secure_link"], connect: ["browser"], fallback: [] },
  },
  operators: { me: { timezone: "UTC" } },
  auth: {
    api_token: env.OPENCONFER_EFFECTIVE_TOKEN,
    jwt_secret: env.OPENCONFER_EFFECTIVE_JWT_SECRET,
  },
};
writeFileSync(env.OPENCONFER_CONFIG, JSON.stringify(config, null, 2));
EOF

exec "$@"
