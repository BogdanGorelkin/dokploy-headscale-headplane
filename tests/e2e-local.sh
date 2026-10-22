#!/usr/bin/env bash
# End-to-end test of the template with plain Docker (no Dokploy, no Traefik).
#
# Renders the template the way Dokploy lays it out on disk, then:
#   deploy (previous release) -> health -> API key -> Headplane login ->
#   create user + reusable pre-auth key through Headplane -> join 2 Tailscale
#   nodes -> upgrade to pinned images -> restart -> recreate -> backup ->
#   wipe -> restore -> verify state and connectivity.
#
# Requirements: docker (with compose v2), node >= 20, internet access (images,
# Tailscale DERP map). Usage: tests/e2e-local.sh   (KEEP=1 keeps the stack up)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP=${APP:-hshp-e2e}
BASE_DOMAIN=example.test
RENDER_ROOT="$ROOT/.render"
OUT="$RENDER_ROOT/$APP"
NET="${APP}_default"
CURL_IMAGE=curlimages/curl:8.17.0
TS_IMAGE=tailscale/tailscale:v1.104.2
# "Updating container images" is tested by first deploying these releases.
FROM_HEADSCALE=${FROM_HEADSCALE:-0.29.4}
FROM_HEADPLANE=${FROM_HEADPLANE:-0.7.1}
HP_HOST="headplane.$BASE_DOMAIN"
BACKUP_DIR="$RENDER_ROOT/$APP-backup"

pass=0
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { pass=$((pass + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; exit 1; }
check() { local desc=$1; shift; if "$@"; then ok "$desc"; else fail "$desc"; fi; }

compose() { docker compose --project-directory "$OUT/code" -f "$OUT/code/docker-compose.yml" -p "$APP" "$@"; }
hs() { compose exec -T headscale headscale "$@"; }
curl_net() { docker run --rm --network "$NET" "$CURL_IMAGE" -sS "$@"; }
hp_headers=(-H "Host: $HP_HOST" -H "X-Forwarded-Proto: https" -H "X-Forwarded-Host: $HP_HOST" -H "Origin: https://$HP_HOST")
ts_names=("$APP-ts-node1" "$APP-ts-node2")

cleanup() {
	if [[ "${KEEP:-0}" == "1" ]]; then
		echo "KEEP=1: leaving stack '$APP' running"
		return
	fi
	docker rm -f "${ts_names[@]}" >/dev/null 2>&1 || true
	[[ -f "$OUT/code/docker-compose.yml" ]] && compose down -v --remove-orphans >/dev/null 2>&1 || true
	rm -rf "$BACKUP_DIR"
}
trap cleanup EXIT

wait_healthy() {
	compose up -d --wait --wait-timeout 180 >/dev/null 2>&1 || {
		compose ps
		compose logs --no-color --tail 50
		return 1
	}
}

http_code() { curl_net -o /dev/null -w '%{http_code}' "$@"; }

hp_login() {
	curl_net -D - -o /dev/null -X POST "http://headplane:3000/admin/login" "${hp_headers[@]}" \
		--data-urlencode "api_key=$1" | sed -n 's/^set-cookie: \([^;]*\).*/\1/ip' | tr -d '\r'
}

hp_post() {
	local cookie=$1 path=$2 data=$3
	curl_net -X POST "${hp_headers[@]}" -H "Cookie: $cookie" --data "$data" "http://headplane:3000$path"
}

user_id() { hs users list -o json-line | grep -o "\"id\":[0-9]*,\"name\":\"$1\"" | grep -o '[0-9]*' | head -1; }
node_count() { hs nodes list -o json-line | grep -o '"given_name"' | wc -l | tr -d ' '; }
noise_hash() { docker run --rm -v "${APP}_headscale-data:/d:ro" alpine:3.22.2 sha256sum /d/noise_private.key | cut -c1-64; }

ts_running() {
	docker exec "$1" tailscale status --json 2>/dev/null | grep -q '"BackendState": "Running"'
}

wait_ts() {
	local i
	for i in $(seq 1 45); do ts_running "$1" && return 0; sleep 2; done
	docker logs --tail 20 "$1"
	return 1
}

ts_ping() { docker exec "${ts_names[0]}" tailscale ping -c 5 --until-direct=false e2e-node2 >/dev/null 2>&1; }

no_published_ports() { ! docker ps --filter "label=com.docker.compose.project=$APP" --format '{{.Ports}}' | grep -q -- '->'; }
has_prefix() { [[ "$1" == "$2"* ]]; }
running_pinned_images() {
	local images
	images=$(docker ps --filter "label=com.docker.compose.project=$APP" --format '{{.Image}}')
	grep -q "${HS_IMAGE#docker.io/}\$" <<<"$images" && grep -q "${HP_IMAGE}\$" <<<"$images"
}

# shellcheck disable=SC2016 # a literal "${" is what we search for
no_placeholders() { ! grep -R -F '${' "$OUT/files"; }
metrics_unreachable() { ! curl_net -m 3 http://headscale:9090/metrics >/dev/null 2>&1; }
magicdns_suffix_ok() {
	docker exec "${ts_names[0]}" tailscale status --json | grep -q "\"MagicDNSSuffix\": \"vpn.$BASE_DOMAIN\""
}

check_pages() {
	local page
	for page in "$@"; do
		check "authenticated GET /admin/$page returns 200" \
			test "$(http_code "${hp_headers[@]}" -H "Cookie: $COOKIE" "http://headplane:3000/admin/$page")" = 200
	done
}

# Allow-all policy written through Headplane's ACL editor.
POLICY='{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}'
jq_free_urlencode() { node -e 'process.stdout.write(encodeURIComponent(require("fs").readFileSync(0, "utf8")))'; }
policy_saved() { hs policy get 2>/dev/null | grep -q '"accept"'; }

state_snapshot() { echo "users=$(hs users list -o json-line | grep -o '"name":"[^"]*"' | sort | tr '\n' ' ') nodes=$(node_count) noise=$(noise_hash)"; }

# ---------------------------------------------------------------------------
step "Render template (Dokploy import path) for https://*.$BASE_DOMAIN"
cleanup
node "$ROOT/scripts/render.mjs" --out "$OUT" --app-name "$APP" --base-domain "$BASE_DOMAIN"
check "rendered compose, .env and mount files exist" \
	test -f "$OUT/code/docker-compose.yml" -a -f "$OUT/code/.env" \
	-a -f "$OUT/files/etc/headscale/config.yaml" -a -f "$OUT/files/etc/headplane/config.yaml"
check "no unresolved \${...} placeholders in mount files" \
	no_placeholders
check "docker compose config is valid" compose config --quiet

pinned_compose=$(cat "$OUT/code/docker-compose.yml")
HS_IMAGE=$(grep -o 'docker.io/headscale/headscale:[^ ]*' <<<"$pinned_compose")
HP_IMAGE=$(grep -o 'ghcr.io/tale/headplane:[^ ]*' <<<"$pinned_compose")
sed -e "s|$HS_IMAGE|${HS_IMAGE%:*}:$FROM_HEADSCALE|" \
	-e "s|$HP_IMAGE|${HP_IMAGE%:*}:$FROM_HEADPLANE|" \
	"$OUT/code/docker-compose.yml" >"$OUT/code/docker-compose.yml.tmp"
mv "$OUT/code/docker-compose.yml.tmp" "$OUT/code/docker-compose.yml"

check "headscale configtest accepts generated config" \
	docker run --rm -v "$OUT/files/etc/headscale/config.yaml:/etc/headscale/config.yaml:ro" "$HS_IMAGE" configtest

step "Fresh deployment (previous release: headscale $FROM_HEADSCALE, headplane $FROM_HEADPLANE)"
check "both services start and become healthy" wait_healthy

step "Endpoints and authentication"
check "headscale /health returns 200" test "$(http_code http://headscale:8080/health)" = 200
check "headplane /admin/login returns 200" test "$(http_code http://headplane:3000/admin/login)" = 200
check "unauthenticated /admin/machines redirects (302)" test "$(http_code http://headplane:3000/admin/machines)" = 302
check "metrics port 9090 is not reachable from the network" \
	metrics_unreachable
check "no host ports are published" no_published_ports

API_KEY=$(bash "$ROOT/scripts/create-api-key.sh" "$APP" 1d 2>/dev/null)
check "scripts/create-api-key.sh returns an API key" has_prefix "$API_KEY" hskey-api-
check "a wrong API key does not create a session" test -z "$(hp_login not-a-valid-api-key)"
COOKIE=$(hp_login "$API_KEY")
check "Headplane login with the API key sets a session cookie" test -n "$COOKIE"
# Headplane 0.7.1 answers 500 on /admin/acls while no policy exists yet; the
# ACL page is therefore only checked after upgrading to the pinned release.
check_pages machines users dns settings/auth-keys

step "Manage users and pre-auth keys through Headplane"
hp_post "$COOKIE" /admin/users "action_id=create_user&username=alice&display_name=Alice&email=alice@$BASE_DOMAIN" >/dev/null
ALICE=$(user_id alice)
check "Headplane created Headscale user 'alice'" test -n "$ALICE"
AUTH_KEY=$(hp_post "$COOKIE" /admin/settings/auth-keys \
	"action_id=add_preauthkey&user_id=$ALICE&expiry=1&reusable=on&ephemeral=off" |
	grep -o 'hskey-auth-[A-Za-z0-9_-]*' | awk 'length > 60' | head -1)
check "Headplane generated a reusable pre-auth key" test -n "$AUTH_KEY"

step "Register Tailscale nodes with the pre-auth key"
for i in 1 2; do
	docker run -d --name "${ts_names[$((i - 1))]}" --network "$NET" \
		-e TS_AUTHKEY="$AUTH_KEY" -e TS_EXTRA_ARGS="--login-server=http://headscale:8080" \
		-e TS_STATE_DIR=/var/lib/tailscale -e TS_USERSPACE=true -e TS_HOSTNAME="e2e-node$i" \
		"$TS_IMAGE" >/dev/null
done
check "node 1 is connected" wait_ts "${ts_names[0]}"
check "node 2 is connected" wait_ts "${ts_names[1]}"
check "Headscale lists 2 nodes" test "$(node_count)" = 2
check "MagicDNS suffix is vpn.$BASE_DOMAIN" \
	magicdns_suffix_ok
check "node 1 can tailscale-ping node 2" ts_ping
BEFORE=$(state_snapshot)
echo "  state: $BEFORE"

step "Update container images to the pinned release"
printf '%s\n' "$pinned_compose" >"$OUT/code/docker-compose.yml"
check "stack recreated on ${HS_IMAGE##*/} / ${HP_IMAGE##*/} and healthy" wait_healthy
check "running images are the pinned ones" running_pinned_images
check "users, nodes and Noise key preserved across the upgrade" test "$(state_snapshot)" = "$BEFORE"
check "existing Headplane session still valid after upgrade" \
	test "$(http_code "${hp_headers[@]}" -H "Cookie: $COOKIE" http://headplane:3000/admin/machines)" = 200
check "nodes reconnect after upgrade" wait_ts "${ts_names[0]}"
check_pages machines users acls dns settings settings/auth-keys
hp_post "$COOKIE" /admin/acls "policy=$(printf '%s' "$POLICY" | jq_free_urlencode)" >/dev/null
check "Headplane saved an ACL policy to the Headscale database" policy_saved
check "nodes still connected under the saved policy" ts_ping

step "Restart both containers"
compose restart >/dev/null 2>&1
check "healthy after restart" wait_healthy
check "state preserved across restart" test "$(state_snapshot)" = "$BEFORE"
check "existing Headplane session still valid after restart" \
	test "$(http_code "${hp_headers[@]}" -H "Cookie: $COOKIE" http://headplane:3000/admin/machines)" = 200

step "Recreate containers (down without -v, then up)"
compose down >/dev/null 2>&1
check "healthy after recreate" wait_healthy
check "state preserved across recreate" test "$(state_snapshot)" = "$BEFORE"
check "nodes reconnect after recreate" wait_ts "${ts_names[0]}"
check "node 1 can still ping node 2" ts_ping

step "Backup, wipe and restore"
DOKPLOY_COMPOSE_DIR="$RENDER_ROOT" bash "$ROOT/scripts/backup.sh" "$APP" "$BACKUP_DIR" >/dev/null
check "backup archives and manifest written" \
	test -s "$BACKUP_DIR/headscale-data.tar.gz" -a -s "$BACKUP_DIR/headplane-data.tar.gz" \
	-a -s "$BACKUP_DIR/files.tar.gz" -a -s "$BACKUP_DIR/MANIFEST"
check "containers running again after backup" wait_healthy
compose down -v >/dev/null 2>&1
wait_healthy
check "wiped deployment starts empty (0 nodes)" test "$(node_count)" = 0
bash "$ROOT/scripts/restore.sh" "$APP" "$BACKUP_DIR" --yes >/dev/null
check "healthy after restore" wait_healthy
check "users, nodes and Noise key restored" test "$(state_snapshot)" = "$BEFORE"
check "Headplane session restored" \
	test "$(http_code "${hp_headers[@]}" -H "Cookie: $COOKIE" http://headplane:3000/admin/machines)" = 200
check "nodes reconnect after restore" wait_ts "${ts_names[1]}"
check "node 1 can ping node 2 after restore" ts_ping

printf '\n\033[32mAll %d checks passed.\033[0m\n' "$pass"
