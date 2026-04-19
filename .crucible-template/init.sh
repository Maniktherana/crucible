#!/usr/bin/env bash
# Crucible bootstrap script.
#
# Detects the package manager used by the target repository and installs
# dependencies. Safe to run repeatedly - it is idempotent beyond the
# installer's own caching behaviour.
set -euo pipefail

# Run from the directory that hosts this script's *parent* project root.
# When installed into `.crucible/init.sh`, that is the repository root.
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$ROOT"

log() {
  printf '[crucible] %s\n' "$*"
}

if [ ! -f "package.json" ]; then
  log "No package.json in $ROOT; nothing to install."
  exit 0
fi

PM=""
PM_ARGS=("install")

if [ -f "bun.lock" ] || [ -f "bun.lockb" ]; then
  PM="bun"
elif [ -f "pnpm-lock.yaml" ]; then
  PM="pnpm"
elif [ -f "yarn.lock" ]; then
  PM="yarn"
elif [ -f "package-lock.json" ]; then
  PM="npm"
  PM_ARGS=("ci")
else
  # Fall back to whatever is available, preferring modern/fast tools first.
  for candidate in bun pnpm yarn npm; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PM="$candidate"
      if [ "$candidate" = "npm" ]; then
        PM_ARGS=("install")
      fi
      break
    fi
  done
fi

if [ -z "$PM" ]; then
  log "No supported package manager found (bun/pnpm/yarn/npm); skipping install."
  exit 0
fi

if ! command -v "$PM" >/dev/null 2>&1; then
  log "Detected $PM lockfile but '$PM' is not installed; skipping install."
  exit 0
fi

log "Installing dependencies with $PM ${PM_ARGS[*]}"
"$PM" "${PM_ARGS[@]}"
log "Install complete."
