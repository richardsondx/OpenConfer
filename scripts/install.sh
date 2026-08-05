#!/usr/bin/env bash
set -euo pipefail

package=${OPENCONFER_PACKAGE:-@openconfer/cli}
version=${OPENCONFER_VERSION:-latest}
source=${OPENCONFER_SOURCE:-npm}

# When install.sh is run from a source checkout (not curl | bash), default to local.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checkout_root="$(cd "$script_dir/.." && pwd)"
if [[ "$source" == "npm" && -f "$checkout_root/pnpm-workspace.yaml" && -f "$checkout_root/apps/cli/package.json" ]]; then
  source=local
fi

case "$package" in
  ""|-*|*[!A-Za-z0-9@/._-]*)
    printf 'Invalid OPENCONFER_PACKAGE: %s\n' "$package" >&2
    exit 2
    ;;
esac

case "$version" in
  *[!A-Za-z0-9._+-]*)
    printf 'Invalid OPENCONFER_VERSION: %s\n' "$version" >&2
    exit 2
    ;;
esac

case "$source" in
  npm)
    command -v npm >/dev/null 2>&1 || {
      printf 'npm is required (Node.js 20 or newer).\n' >&2
      exit 1
    }
    install_args=(--global "${package}@${version}")
    if [[ -n "${OPENCONFER_PREFIX:-}" ]]; then
      install_args+=(--prefix "$OPENCONFER_PREFIX")
    fi
    npm install "${install_args[@]}"
    installed_command="${OPENCONFER_PREFIX:-$(npm prefix --global)}/bin/openconfer"
    ;;
  local)
    root=${OPENCONFER_SOURCE_DIR:-$PWD}
    [[ -f "$root/pnpm-workspace.yaml" && -f "$root/apps/cli/package.json" ]] || {
      printf 'OPENCONFER_SOURCE=local requires OPENCONFER_SOURCE_DIR to be a source checkout.\n' >&2
      exit 1
    }
    command -v pnpm >/dev/null 2>&1 || {
      printf 'pnpm is required for a local source install.\n' >&2
      exit 1
    }
    prefix=${OPENCONFER_PREFIX:-$HOME/.local}
    target="$prefix/lib/openconfer"
    mkdir -p "$prefix/bin" "$prefix/lib"
    pnpm --dir "$root" install --frozen-lockfile
    pnpm --dir "$root" --filter @openconfer/cli... build
    # Ensure newly added server modules (e.g. settings.js) exist before deploy.
    [[ -f "$root/apps/server/dist/settings.js" ]] || {
      printf 'Server build is missing dist/settings.js — run: pnpm --filter @openconfer/server build\n' >&2
      exit 1
    }
    rm -rf "$target"
    pnpm --dir "$root" --filter @openconfer/cli deploy --prod --legacy "$target"
    chmod +x "$target/dist/index.js"
    # pnpm deploy can omit newly added dist files when the store hardlink snapshot is stale.
    deployed_server="$(find "$target/node_modules" -path '*/@openconfer/server/dist/index.js' | head -n1 || true)"
    if [[ -z "$deployed_server" ]]; then
      printf 'Deploy did not include @openconfer/server dist under %s\n' "$target" >&2
      exit 1
    fi
    deployed_dist="$(dirname "$deployed_server")"
    rsync -a --delete --exclude='*.test.js' --exclude='*.test.d.ts' --exclude='*.map' \
      "$root/apps/server/dist/" "$deployed_dist/"
    if [[ ! -f "$deployed_dist/settings.js" ]]; then
      printf 'Deployed server is missing settings.js under %s\n' "$deployed_dist" >&2
      exit 1
    fi
    # Keep conversation-worker dist in sync (session-factory + friends).
    deployed_worker="$(find "$target/node_modules" -path '*/@openconfer/conversation-worker/dist/index.js' | head -n1 || true)"
    if [[ -n "$deployed_worker" && -d "$root/apps/conversation-worker/dist" ]]; then
      deployed_worker_dist="$(dirname "$deployed_worker")"
      rsync -a --delete --exclude='*.test.js' --exclude='*.test.d.ts' --exclude='*.map' \
        "$root/apps/conversation-worker/dist/" "$deployed_worker_dist/"
      if [[ ! -f "$deployed_worker_dist/session-factory.js" ]]; then
        printf 'Deployed conversation-worker is missing session-factory.js under %s\n' "$deployed_worker_dist" >&2
        exit 1
      fi
    fi
    ln -sf "$target/dist/index.js" "$prefix/bin/openconfer"
    # Remember the checkout so `openconfer web` works from any directory.
    mkdir -p "$HOME/.openconfer"
    printf '%s\n' "$root" >"$HOME/.openconfer/source-dir"
    printf 'Installed openconfer to %s/bin/openconfer\n' "$prefix"
    installed_command="$prefix/bin/openconfer"
    ;;
  *)
    printf 'OPENCONFER_SOURCE must be npm or local.\n' >&2
    exit 2
    ;;
esac

[[ -x "$installed_command" ]] || {
  printf 'Install did not create an executable at %s.\n' "$installed_command" >&2
  exit 1
}
"$installed_command" --version

bindir="$(dirname "$installed_command")"
if ! echo ":$PATH:" | grep -q ":${bindir}:"; then
  printf '\nAdd openconfer to your PATH:\n\n'
  printf '  export PATH="%s:$PATH"\n\n' "$bindir"
  printf 'Add that line to ~/.zshrc or ~/.bashrc, then open a new terminal.\n'
  printf 'Until then, run:\n\n'
  printf '  %s serve\n\n' "$installed_command"
else
  printf '\nNext steps:\n\n'
  printf '  openconfer init\n'
  printf '  openconfer doctor\n'
  printf '  openconfer serve\n'
  printf '  openconfer web\n\n'
fi
