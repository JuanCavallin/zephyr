#!/usr/bin/env bash
# Run the repo's checks on Linux (WSL, or any x86_64 Linux box).
#
#   pnpm check:wsl                      from Windows: check:acp + check:hermes-live in WSL Ubuntu
#   bash scripts/wsl-check.sh           same, from a Linux shell
#   bash scripts/wsl-check.sh check:all any root package.json scripts instead of the defaults
#
# Windows' node_modules and Hermes' .venv hold Windows binaries, so this never
# runs in the /mnt/c checkout. It mirrors the repo and the adjacent hermes-agent
# checkout onto the Linux filesystem (skipping .git, node_modules, .venv and
# anything gitignored, so .env files never leave Windows), installs pinned Node,
# pnpm and uv into a user-local directory, and runs the checks there. Nothing is
# installed system-wide; repeat runs reuse the toolchain and dependencies.
#
#   ZEPHYR_LINUX_DIR  work directory           default ~/.cache/zephyr-linux-check
#   HERMES_SRC        hermes-agent checkout    default <repo>/../hermes-agent
set -euo pipefail

NODE_VERSION=22.21.0
PNPM_VERSION=10.30.0 # keep equal to packageManager in package.json
UV_VERSION=0.12.17

[[ "$(uname -s)-$(uname -m)" == Linux-x86_64 ]] || { echo "wsl-check: needs x86_64 Linux" >&2; exit 1; }

REPO_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_SRC="${HERMES_SRC:-$(cd "$REPO_SRC/.." && pwd)/hermes-agent}"
WORK="${ZEPHYR_LINUX_DIR:-$HOME/.cache/zephyr-linux-check}"
TOOLS="$WORK/tools"
CHECKS=("$@")
[[ ${#CHECKS[@]} -gt 0 ]] || CHECKS=(check:acp check:hermes-live)

# Only Linux binaries: WSL appends the Windows PATH, whose node/pnpm/uv shims
# would otherwise win and run the Windows toolchain against Linux files.
export PATH="$TOOLS/node/bin:$TOOLS/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1

step() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null || { echo "wsl-check: missing $1 (sudo apt-get install -y $1)" >&2; exit 1; }; }
for tool in curl rsync tar xz git sha256sum; do need "$tool"; done

# Download $1 to $2 and check it against the sha256 listed for $3 in the sums file at $4.
fetch_verified() {
  local url=$1 out=$2 name=$3 sums_url=$4 expected
  curl -fsSL --retry 3 -o "$out" "$url"
  expected=$(curl -fsSL --retry 3 "$sums_url" | awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }')
  [[ -n "$expected" ]] || { echo "wsl-check: no checksum for $name" >&2; exit 1; }
  echo "$expected  $out" | sha256sum -c --quiet -
}

mkdir -p "$TOOLS/bin" "$WORK/downloads"

if [[ "$(node --version 2>/dev/null)" != "v$NODE_VERSION" ]]; then
  step "installing Node $NODE_VERSION"
  name="node-v$NODE_VERSION-linux-x64.tar.xz"
  base="https://nodejs.org/dist/v$NODE_VERSION"
  fetch_verified "$base/$name" "$WORK/downloads/$name" "$name" "$base/SHASUMS256.txt"
  rm -rf "$TOOLS/node" && mkdir -p "$TOOLS/node"
  tar -xJf "$WORK/downloads/$name" -C "$TOOLS/node" --strip-components=1
fi

if [[ "$(pnpm --version 2>/dev/null)" != "$PNPM_VERSION" ]]; then
  step "installing pnpm $PNPM_VERSION"
  npm install --global --prefix "$TOOLS" --no-fund --no-audit "pnpm@$PNPM_VERSION" >/dev/null
fi

if [[ "$(uv --version 2>/dev/null)" != "uv $UV_VERSION"* ]]; then
  step "installing uv $UV_VERSION"
  name="uv-x86_64-unknown-linux-gnu.tar.gz"
  base="https://github.com/astral-sh/uv/releases/download/$UV_VERSION"
  fetch_verified "$base/$name" "$WORK/downloads/$name" "$name" "$base/$name.sha256"
  tar -xzf "$WORK/downloads/$name" -C "$TOOLS/bin" --strip-components=1
fi

echo "node $(node --version), pnpm $(pnpm --version), $(uv --version), $(git --version)"

# Mirror a checkout without VCS data, dependencies, or anything gitignored.
# Excluded paths on the receiving side survive --delete, so installs are reused.
mirror() {
  rsync -a --delete --exclude .git --exclude node_modules --exclude .venv \
    --filter=':- .gitignore' "$1/" "$2/"
}

step "mirroring $REPO_SRC -> $WORK/repo"
mkdir -p "$WORK/repo"
mirror "$REPO_SRC" "$WORK/repo"
(cd "$WORK/repo" && pnpm install --frozen-lockfile --reporter=append-only | tail -n 3)

if printf '%s\n' "${CHECKS[@]}" | grep -qx 'check:hermes-live'; then
  [[ -d "$HERMES_SRC/acp_adapter" ]] || {
    echo "wsl-check: no hermes-agent checkout at $HERMES_SRC (set HERMES_SRC)" >&2
    exit 1
  }
  step "mirroring $HERMES_SRC -> $WORK/hermes-agent"
  mkdir -p "$WORK/hermes-agent"
  mirror "$HERMES_SRC" "$WORK/hermes-agent"
  (cd "$WORK/hermes-agent" && uv sync --extra acp --extra mcp --locked --quiet)
  export HERMES_CWD="$WORK/hermes-agent"
fi

cd "$WORK/repo"
for check in "${CHECKS[@]}"; do
  step "pnpm run $check (linux)"
  pnpm run "$check"
done
step "linux checks passed: ${CHECKS[*]}"
