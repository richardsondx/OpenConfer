#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec env OPENCONFER_SOURCE=local OPENCONFER_SOURCE_DIR="$root" "$root/scripts/install.sh"
