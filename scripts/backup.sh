#!/usr/bin/env bash
# Consistent backup of a Headscale + Headplane deployment.
#
#   scripts/backup.sh <app-name> [backup-dir]
#
# Run on the Docker host. Both containers are stopped for the duration of the
# copy (typically a few seconds) so the SQLite databases and their WAL files
# are captured in a consistent state, then started again.
#
# Output (default ./backup-<app-name>-<UTC timestamp>/):
#   headscale-data.tar.gz   db.sqlite (+wal/shm), noise_private.key
#   headplane-data.tar.gz   Headplane database (sessions, roles)
#   files.tar.gz            Dokploy mount files (configs incl. cookie secret),
#                           when /etc/dokploy/compose/<app-name>/files exists
#   MANIFEST                images, timestamp and SHA-256 checksums
#
# The backup contains secrets (Noise private key, cookie secret, hashed API
# keys). Store it encrypted and with restricted access.
set -euo pipefail

HELPER_IMAGE=${HELPER_IMAGE:-alpine:3.22.2}
DOKPLOY_COMPOSE_DIR=${DOKPLOY_COMPOSE_DIR:-/etc/dokploy/compose}

if [[ $# -lt 1 ]]; then
	echo "Usage: $0 <app-name> [backup-dir]" >&2
	exit 1
fi

project=$1
dest=${2:-./backup-$project-$(date -u +%Y%m%dT%H%M%SZ)}
services=(headscale headplane)

container_of() {
	docker ps -a --filter "label=com.docker.compose.project=$project" \
		--filter "label=com.docker.compose.service=$1" --format '{{.ID}}'
}

sha256() {
	if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

volume_of() {
	docker volume ls -q --filter "label=com.docker.compose.project=$project" \
		--filter "label=com.docker.compose.volume=$1-data"
}

for svc in "${services[@]}"; do
	if [[ -z "$(volume_of "$svc")" ]]; then
		echo "error: volume $svc-data not found for project '$project'" >&2
		exit 1
	fi
done

mkdir -p "$dest"
dest=$(cd "$dest" && pwd)
umask 077

running=()
for svc in headplane headscale; do
	id=$(container_of "$svc")
	if [[ -n "$id" && "$(docker inspect -f '{{.State.Running}}' "$id")" == "true" ]]; then
		running+=("$id")
	fi
done

restart() {
	# Start Headscale before Headplane.
	for ((i = ${#running[@]} - 1; i >= 0; i--)); do
		docker start "${running[$i]}" >/dev/null
	done
}
trap restart EXIT

if [[ ${#running[@]} -gt 0 ]]; then
	echo "Stopping containers for a consistent copy..."
	docker stop "${running[@]}" >/dev/null
fi

for svc in "${services[@]}"; do
	vol=$(volume_of "$svc")
	echo "Archiving volume $vol"
	docker run --rm -v "$vol:/data:ro" -v "$dest:/backup" "$HELPER_IMAGE" \
		tar -czf "/backup/$svc-data.tar.gz" -C /data .
done

files_dir="$DOKPLOY_COMPOSE_DIR/$project/files"
if [[ -d "$files_dir" ]]; then
	echo "Archiving mount files from $files_dir"
	tar -czf "$dest/files.tar.gz" -C "$files_dir" .
fi

restart
trap - EXIT

{
	echo "project: $project"
	echo "created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	for svc in "${services[@]}"; do
		id=$(container_of "$svc")
		[[ -n "$id" ]] && echo "image.$svc: $(docker inspect -f '{{.Config.Image}}' "$id")"
	done
	echo "sha256:"
	(cd "$dest" && sha256 ./*.tar.gz)
} >"$dest/MANIFEST"

echo "Backup written to $dest"
