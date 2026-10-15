#!/usr/bin/env bash
# One-time setup on macOS / Linux: installs dependencies and builds the app.
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  echo "Node.js 22.13 or newer is required (found $(node -v 2>/dev/null || echo none)). Install the current LTS from https://nodejs.org" >&2
  exit 1
fi
command -v pnpm >/dev/null || corepack enable
pnpm install --frozen-lockfile
pnpm build
[ -f .env ] || { cp .env.example .env; echo "Created .env — edit PCH_HOST before using from other devices."; }
echo "Setup complete. Start with: scripts/start.sh"
