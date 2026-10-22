#!/usr/bin/env bash
# Creates a Headscale API key for signing in to Headplane.
#
# Run on the Docker host of the Dokploy deployment (e.g. over SSH). The
# Headscale image is distroless, so Dokploy's web terminal cannot run this.
#
#   scripts/create-api-key.sh                 # list Headscale deployments
#   scripts/create-api-key.sh <app-name> [expiration]
#
# <app-name> is the Dokploy "App Name" of the Compose service (it is the
# Compose project name). Expiration defaults to 90d. The key is printed once
# to stdout; Headscale only stores its hash.
set -euo pipefail

find_headscale() {
	docker ps --filter "label=com.docker.compose.project=$1" \
		--filter "label=com.docker.compose.service=headscale" --format '{{.ID}}'
}

if [[ $# -lt 1 ]]; then
	echo "Running Headscale deployments (Compose project names):" >&2
	docker ps --filter "label=com.docker.compose.service=headscale" \
		--format '  {{.Label "com.docker.compose.project"}}  ({{.Image}}, {{.Status}})' >&2
	echo "Usage: $0 <app-name> [expiration, default 90d]" >&2
	exit 1
fi

project=$1
expiration=${2:-90d}
container=$(find_headscale "$project")

if [[ -z "$container" ]]; then
	echo "error: no running headscale container for project '$project'" >&2
	exit 1
fi
if [[ $(wc -l <<<"$container") -ne 1 ]]; then
	echo "error: more than one headscale container for project '$project'" >&2
	exit 1
fi

echo "Creating API key (expires in $expiration) for $project..." >&2
docker exec "$container" headscale apikeys create --expiration "$expiration"
echo "Paste it into https://<headplane-host>/admin/login. It is not shown again." >&2
