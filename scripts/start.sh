#!/usr/bin/env bash
# Start the production gateway (serves the web app). Reads .env from the repository root.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f apps/gateway/dist/index.js ] && [ -f apps/web/dist/index.html ] || { echo "Not built yet. Run scripts/setup.sh first." >&2; exit 1; }
exec node --disable-warning=ExperimentalWarning apps/gateway/dist/index.js
