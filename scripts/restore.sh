#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh into an existing deployment.
#
#   scripts/restore.sh <app-name> <backup-dir> [--yes]
#
# The target deployment must have been deployed at least once (so its volumes
# exist). The current contents of both volumes are REPLACED. Mount files
# (files.tar.gz) are not restored automatically: compare them with the
# deployment's Advanced -> Mounts in Dokploy and copy any changes there, since
# Dokploy rewrites mount files from its database when they are edited.
set -euo pipefail

HELPER_IMAGE=${HELPER_IMAGE:-alpine:3.22.2}

if [[ $# -lt 2 ]]; then
	echo "Usage: $0 <app-name> <backup-dir> [--yes]" >&2
	exit 1
fi

project=$1
src=$(cd "$2" && pwd)
confirm=${3:-}
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
	[[ -f "$src/$svc-data.tar.gz" ]] || { echo "error: $src/$svc-data.tar.gz missing" >&2; exit 1; }
	[[ -n "$(volume_of "$svc")" ]] || {
		echo "error: volume $svc-data not found for '$project'; deploy it once first" >&2
		exit 1
	}
done

if [[ -f "$src/MANIFEST" ]]; then
	(cd "$src" && grep -E '^[0-9a-f]{64} ' MANIFEST | sha256 -c -) >/dev/null ||
		{ echo "error: checksum mismatch in $src" >&2; exit 1; }
fi

if [[ "$confirm" != "--yes" ]]; then
	read -r -p "Replace all Headscale and Headplane data of '$project'? [y/N] " answer
	[[ "$answer" == "y" || "$answer" == "Y" ]] || exit 1
fi

ids=()
for svc in headplane headscale; do
	id=$(container_of "$svc")
	[[ -n "$id" ]] && ids+=("$id")
done
[[ ${#ids[@]} -gt 0 ]] && docker stop "${ids[@]}" >/dev/null

for svc in "${services[@]}"; do
	vol=$(volume_of "$svc")
	echo "Restoring $vol"
	docker run --rm -v "$vol:/data" -v "$src:/backup:ro" "$HELPER_IMAGE" \
		sh -c "find /data -mindepth 1 -delete && tar -xzf /backup/$svc-data.tar.gz -C /data"
done

for ((i = ${#ids[@]} - 1; i >= 0; i--)); do
	docker start "${ids[$i]}" >/dev/null
done
echo "Restore complete. Check: docker ps --filter label=com.docker.compose.project=$project"
