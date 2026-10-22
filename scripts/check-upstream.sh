#!/usr/bin/env bash
# Runs the official Dokploy/templates validators against this blueprint, the
# same checks its CI applies to a pull request (validate-docker-compose.ts,
# validate-template.ts, generate-meta.js --check).
#
#   scripts/check-upstream.sh <path-to-Dokploy/templates-checkout>
#
# The checkout is modified only by copying blueprints/headscale-headplane in.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UPSTREAM=${1:?usage: $0 <path-to-Dokploy/templates-checkout>}
ID=headscale-headplane

UPSTREAM=$(cd "$UPSTREAM" && pwd)
[[ -f "$UPSTREAM/build-scripts/validate-template.ts" ]] || {
	echo "error: $UPSTREAM is not a Dokploy/templates checkout" >&2
	exit 1
}

mkdir -p "$UPSTREAM/blueprints/$ID"
cp "$ROOT/blueprints/$ID/"* "$UPSTREAM/blueprints/$ID/"

cd "$UPSTREAM/build-scripts"
[[ -d node_modules ]] || npm ci --no-audit --no-fund >/dev/null

echo "== validate-docker-compose.ts"
npx --no-install tsx validate-docker-compose.ts --file "../blueprints/$ID/docker-compose.yml" --verbose
echo "== validate-template.ts"
npx --no-install tsx validate-template.ts --dir "../blueprints/$ID" --verbose
echo "== generate-meta.js --check"
cd "$UPSTREAM"
node build-scripts/generate-meta.js --check
