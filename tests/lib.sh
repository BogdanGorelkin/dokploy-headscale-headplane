#!/usr/bin/env bash
# Shared helpers for tests/*.sh. Source after setting APP, OUT and NET.

# Constants shared with the sourcing scripts (exported so they are visibly
# used outside this file).
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export ROOT
export RENDER_ROOT="$ROOT/.render"
export CURL_IMAGE=curlimages/curl:8.17.0
export TS_IMAGE=tailscale/tailscale:v1.104.2
export HELPER_IMAGE=alpine:3.22.2
export COMPOSE_FILE="$OUT/code/docker-compose.yml"

pass=0
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { pass=$((pass + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; exit 1; }
check() { local desc=$1; shift; if "$@"; then ok "$desc"; else fail "$desc"; fi; }
done_msg() { printf '\n\033[32mAll %d checks passed.\033[0m\n' "$pass"; }

compose() { docker compose --project-directory "$OUT/code" -f "$COMPOSE_FILE" -p "$APP" "$@"; }
hs() { compose exec -T headscale headscale "$@"; }
has_prefix() { [[ "$1" == "$2"* ]]; }
# Pipeline-safe `grep -q`: reads all input, so under `set -o pipefail` an
# early match can't SIGPIPE the producer and turn a match into a failure
# (or, inside `!`, into a false pass).
contains() { grep "$@" >/dev/null; }

wait_healthy() {
	if ! compose up -d --wait --wait-timeout 180 >/dev/null 2>&1; then
		compose ps -a
		compose logs --no-color --tail 50
		return 1
	fi
}

# Tears the project down; works by project name alone when the rendered
# compose file is missing (e.g. rendering failed).
compose_down() {
	if [[ -f "$COMPOSE_FILE" ]]; then
		compose down -v --remove-orphans >/dev/null 2>&1 || true
	else
		docker compose -p "$APP" down -v --remove-orphans >/dev/null 2>&1 || true
	fi
}

user_id() { hs users list -o json-line | grep -o "\"id\":[0-9]*,\"name\":\"$1\"" | grep -o '[0-9]*' | head -1; }
node_count() { hs nodes list -o json-line | grep -o '"given_name"' | wc -l | tr -d ' '; }

# -- headscale-admin helper: exactly what Dokploy's terminal runs,
# docker exec -it -w / <container> <shell>, with the command typed in.
admin_id() { compose ps -a -q headscale-admin; }
terminal() {
	local shell=$1
	shift
	# Callers judge the transcript, not the exit status (a missing shell is
	# itself an expected outcome for the "bash" tab).
	printf '%s\nexit\n' "$*" | docker exec -i -w / "$(admin_id)" "$shell" 2>&1 || true
}
terminal_api_key() { terminal sh "headscale apikeys create --expiration 1d" | grep -o 'hskey-api-[A-Za-z0-9_-]*' | head -1; }

# -- Tailscale nodes
ts_running() { docker exec "$1" tailscale status --json 2>/dev/null | contains '"BackendState": "Running"'; }
wait_ts() {
	for _ in $(seq 1 45); do ts_running "$1" && return 0; sleep 2; done
	docker logs --tail 20 "$1"
	return 1
}

# -- Dokploy-style Traefik ------------------------------------------------------
# Test CA plus a wildcard certificate for *.<BASE_DOMAIN> in $PKI.
pki_create() {
	mkdir -p "$PKI"
	openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=hshp test CA" \
		-keyout "$PKI/ca.key" -out "$PKI/ca.pem" >/dev/null 2>&1
	openssl req -newkey rsa:2048 -nodes -subj "/CN=*.$BASE_DOMAIN" \
		-keyout "$PKI/tls.key" -out "$PKI/tls.csr" >/dev/null 2>&1
	printf 'subjectAltName=DNS:*.%s\nextendedKeyUsage=serverAuth\n' "$BASE_DOMAIN" >"$PKI/ext.cnf"
	openssl x509 -req -in "$PKI/tls.csr" -CA "$PKI/ca.pem" -CAkey "$PKI/ca.key" -CAcreateserial -days 2 \
		-extfile "$PKI/ext.cnf" -out "$PKI/tls.pem" >/dev/null 2>&1
	chmod 0644 "$PKI"/*.pem "$PKI"/*.key
}

# Starts Traefik (Dokploy's version and configuration) as $TRAEFIK on
# dokploy-network; for isolated mode also connects it to the app network.
# Sets created_network=1 when this call created dokploy-network.
traefik_start() {
	local mode=$1 version
	version=$(sed -n 's/^export const TRAEFIK_VERSION = "\(.*\)";/\1/p' "$ROOT/scripts/lib/dokploy-deploy.mjs")
	local dir=${TRAEFIK_DIR:-$OUT/traefik}
	node "$ROOT/tests/traefik-config.mjs" "$dir"
	if ! docker network inspect dokploy-network >/dev/null 2>&1; then
		docker network create --attachable dokploy-network >/dev/null
		created_network=1
	fi
	if [[ "$mode" == isolated ]]; then
		# What Dokploy does for Isolated Deployments before `compose up`.
		docker network inspect "$APP" >/dev/null 2>&1 || docker network create --attachable "$APP" >/dev/null
	fi
	# The test Traefik gets the Docker socket (read-only); the template never does.
	docker run -d --name "$TRAEFIK" --network dokploy-network \
		-v /var/run/docker.sock:/var/run/docker.sock:ro \
		-v "$dir/traefik.yml:/etc/traefik/traefik.yml:ro" \
		-v "$dir/dynamic:/etc/dokploy/traefik/dynamic:ro" \
		-v "$PKI:/pki:ro" "traefik:v$version" >/dev/null
	if [[ "$mode" == isolated ]]; then
		docker network connect "$APP" "$TRAEFIK"
	fi
}

traefik_stop() {
	docker rm -f "$TRAEFIK" >/dev/null 2>&1 || true
	if [[ "${MODE:-shared}" == isolated ]]; then
		docker network rm "$APP" >/dev/null 2>&1 || true
	fi
	if [[ "${created_network:-0}" == 1 ]]; then
		docker network rm dokploy-network >/dev/null 2>&1 || true
	fi
}

traefik_ip() { docker inspect -f '{{(index .NetworkSettings.Networks "dokploy-network").IPAddress}}' "$TRAEFIK"; }

# A Tailscale client that reaches https://$HS_HOST through Traefik and trusts
# the test CA, like a real device on the internet.
ts_start() {
	local name=$1 hostname=$2 authkey=$3
	docker run -d --name "$name" --network dokploy-network --add-host "$HS_HOST:$(traefik_ip)" \
		-v "$PKI/ca.pem:/ca.pem:ro" -e SSL_CERT_FILE=/ca.pem \
		-e TS_AUTHKEY="$authkey" -e TS_EXTRA_ARGS="--login-server=https://$HS_HOST" \
		-e TS_STATE_DIR=/var/lib/tailscale -e TS_USERSPACE=true -e TS_HOSTNAME="$hostname" "$TS_IMAGE" >/dev/null
}

# Headscale's own view: number of nodes with an active control session.
nodes_online() { hs nodes list -o json-line | grep -o '"online":true' | wc -l | tr -d ' '; }
wait_nodes_online() {
	for _ in $(seq 1 60); do
		[[ "$(nodes_online)" == "$1" ]] && return 0
		sleep 2
	done
	echo "    $(nodes_online) of $1 nodes online"
	return 1
}
