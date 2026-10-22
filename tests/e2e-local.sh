#!/usr/bin/env bash
# End-to-end test of the template with plain Docker (no Dokploy, no Traefik;
# see tests/routing-traefik.sh for the routing layer).
#
# Renders the template the way Dokploy lays it out on disk, then:
#   1. deploys the PREVIOUS template version on the previous image releases,
#      creates an API key over "SSH" (scripts/create-api-key.sh), a user and
#      a pre-auth key through Headplane, and joins two Tailscale nodes;
#   2. re-imports the current template over it (Dokploy replaces compose, env,
#      mounts and domains but keeps volumes) and checks all state survives;
#   3. bootstraps an API key through the headscale-admin helper exactly the
#      way Dokploy's web terminal does, and checks its isolation, logs and
#      idle-timeout behaviour;
#   4. changes every host name through the Environment only, and checks that
#      an invalid value blocks the deploy while the old configuration runs on;
#   5. restarts, recreates, backs up, wipes (fresh install + helper
#      bootstrap) and restores.
#
# Requirements: docker (compose v2), node >= 20, git history containing
# PREV_TEMPLATE_REF, internet access. KEEP=1 keeps the stack running.
set -euo pipefail

APP=${APP:-hshp-e2e}
BASE_DOMAIN=example.test
OUT="$(cd "$(dirname "$0")/.." && pwd)/.render/$APP"
NET="${APP}_default"
# shellcheck source=tests/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

# The template version running on the first live deployment (Dokploy file
# mounts, no config renderer), on the image releases preceding the pins.
PREV_TEMPLATE_REF=${PREV_TEMPLATE_REF:-5bca341}
FROM_HEADSCALE=${FROM_HEADSCALE:-0.29.4}
FROM_HEADPLANE=${FROM_HEADPLANE:-0.7.1}
BACKUP_DIR="$RENDER_ROOT/$APP-backup"
HS_HOST="headscale.$BASE_DOMAIN"
HP_HOST="headplane.$BASE_DOMAIN"
ts_names=("$APP-ts-node1" "$APP-ts-node2")
# Clients reach Headscale over HTTPS through a Dokploy-style Traefik. Its
# certificates and config live outside $OUT, which every (re-)import replaces.
TRAEFIK="$APP-traefik"
PKI="$RENDER_ROOT/$APP-pki"
TRAEFIK_DIR="$RENDER_ROOT/$APP-traefik"
created_network=0

cleanup() {
	if [[ "${KEEP:-0}" == "1" ]]; then
		echo "KEEP=1: leaving stack '$APP' running"
		return 0
	fi
	docker rm -f "${ts_names[@]}" >/dev/null 2>&1 || true
	compose_down
	traefik_stop
	rm -rf "${BACKUP_DIR:?}" "${PKI:?}" "${TRAEFIK_DIR:?}"
}
trap cleanup EXIT

# Headplane is reached directly on the Compose network with the headers
# Traefik would add for the public host name.
curl_net() { docker run --rm --network "$NET" "$CURL_IMAGE" -sS "$@"; }
hp_curl() {
	curl_net -H "Host: $HP_HOST" -H "X-Forwarded-Proto: https" -H "X-Forwarded-Host: $HP_HOST" \
		-H "Origin: https://$HP_HOST" "$@"
}
http_code() { curl_net -o /dev/null -w '%{http_code}' "$@"; }
hp_code() { hp_curl -o /dev/null -w '%{http_code}' "$@"; }
hp_login() {
	hp_curl -D - -o /dev/null -X POST "http://headplane:3000/admin/login" --data-urlencode "api_key=$1" |
		sed -n 's/^set-cookie: \([^;]*\).*/\1/ip' | tr -d '\r'
}
hp_post() { hp_curl -X POST -H "Cookie: $1" --data "$3" "http://headplane:3000$2"; }
session_valid() { test "$(hp_code -H "Cookie: $1" http://headplane:3000/admin/machines)" = 200; }
session_rejected() { test "$(hp_code -H "Cookie: $1" http://headplane:3000/admin/machines)" = 302; }
check_pages() {
	local page
	for page in "$@"; do
		check "authenticated GET /admin/$page returns 200" \
			test "$(hp_code -H "Cookie: $COOKIE" "http://headplane:3000/admin/$page")" = 200
	done
}

# Allow-all policy written through Headplane's ACL editor.
POLICY='{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}'
urlencode() { node -e 'process.stdout.write(encodeURIComponent(require("fs").readFileSync(0, "utf8")))'; }
policy_saved() { hs policy get 2>/dev/null | contains '"accept"'; }

noise_hash() { docker run --rm -v "${APP}_headscale-data:/d:ro" "$HELPER_IMAGE" sha256sum /d/noise_private.key | cut -c1-64; }
state_snapshot() { echo "users=$(hs users list -o json-line | grep -o '"name":"[^"]*"' | sort | tr '\n' ' ') nodes=$(node_count) noise=$(noise_hash)"; }
ts_ping() { docker exec "${ts_names[0]}" tailscale ping -c 5 --until-direct=false e2e-node2 >/dev/null 2>&1; }
magicdns_suffix_is() {
	for _ in $(seq 1 20); do
		docker exec "${ts_names[0]}" tailscale status --json | contains "\"MagicDNSSuffix\": \"$1\"" && return 0
		sleep 2
	done
	return 1
}

no_dokploy_placeholders() { ! grep -R -F "\${" "$OUT/files"; }
metrics_unreachable() { ! curl_net -m 3 http://headscale:9090/metrics >/dev/null 2>&1; }
no_published_ports() { ! docker ps -a --filter "label=com.docker.compose.project=$APP" --format '{{.Ports}}' | contains -- '->'; }
running_pinned_images() {
	local images
	images=$(docker ps --filter "label=com.docker.compose.project=$APP" --format '{{.Image}}')
	grep -q "${HS_IMAGE#docker.io/}\$" <<<"$images" && grep -q "${HP_IMAGE}\$" <<<"$images"
}
server_lists_key() { hs apikeys list | contains -F "${1:0:22}"; }

# -- rendered configuration ---------------------------------------------------
env_value() { sed -n "s/^$1=\"\(.*\)\"$/\1/p" "$OUT/code/.env"; }
set_env() { sed -i.bak "s|^$1=.*|$1=\"$2\"|" "$OUT/code/.env" && rm -f "$OUT/code/.env.bak"; }
rendered() { docker run --rm -v "${APP}_$1:/c:ro" "$HELPER_IMAGE" cat /c/config.yaml; }
config_state() { docker inspect "$(compose ps -a -q headscale-config)" --format '{{.State.Status}} {{.State.ExitCode}}'; }
config_rendered_for() {
	local hs_cfg hp_cfg
	hs_cfg=$(rendered headscale-config)
	hp_cfg=$(rendered headplane-config)
	grep -qx "server_url: https://$1" <<<"$hs_cfg" &&
		grep -qx "  base_domain: $3" <<<"$hs_cfg" &&
		grep -qx "  base_url: https://$2" <<<"$hp_cfg" &&
		grep -qx "  public_url: https://$1" <<<"$hp_cfg" &&
		grep -qx "  cookie_secret: \"$(env_value HEADPLANE_COOKIE_SECRET)\"" <<<"$hp_cfg" &&
		! grep -q '{{' <<<"$hs_cfg$hp_cfg"
}
absent_from_logs() {
	local id
	for id in $(docker ps -a -q --filter "label=com.docker.compose.project=$APP"); do
		if docker logs "$id" 2>&1 | contains -F "$1"; then
			echo "    found in logs of $(docker inspect -f '{{.Name}}' "$id")"
			return 1
		fi
	done
}
deploy_rejected_with() {
	if compose up -d --wait --wait-timeout 60 >/dev/null 2>&1; then
		return 1
	fi
	docker logs "$(compose ps -a -q headscale-config)" 2>&1 | contains -F "$1"
}
template_edit_rendered() { rendered headscale-config | contains -x '  level: debug'; }
headscale_debug_logging() {
	wait_healthy && docker logs --since 60s "$(compose ps -q headscale)" 2>&1 | contains ' DBG '
}
headscale_stopped() { [[ "$(docker inspect "$(compose ps -a -q headscale)" --format '{{.State.Running}}')" == false ]]; }

# -- headscale-admin helper -----------------------------------------------------
admin_has_no_data_access() {
	! docker inspect "$(admin_id)" --format '{{range .Mounts}}{{.Destination}} {{end}}' | contains '/var/lib/headscale' &&
		terminal sh "ls /var/lib/headscale" | contains 'No such file'
}
admin_rootfs_readonly() { terminal sh "touch /probe" | contains 'Read-only file system'; }
admin_only_project_network() {
	test "$(docker inspect "$(admin_id)" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')" = "$NET "
}
socket_on_tmpfs() { terminal sh "grep ' /var/run/headscale ' /proc/mounts" | contains '^tmpfs '; }
headplane_has_no_socket() {
	! docker inspect "$(compose ps -q headplane)" --format '{{range .Mounts}}{{.Destination}} {{end}}' | contains '/var/run/headscale'
}
bash_tab_unavailable() { terminal bash "true" | contains 'executable file not found'; }
admin_state() { docker inspect "$(admin_id)" --format '{{.State.Status}} {{.State.ExitCode}}'; }
wait_admin_exited() {
	for _ in $(seq 1 30); do
		[[ "$(admin_state)" == "exited 0" ]] && return 0
		sleep 1
	done
	return 1
}
admin_logs_empty() { test -z "$(docker logs "$(admin_id)" 2>&1)"; }
exited_admin_has_no_shell() { ! docker exec "$(admin_id)" true >/dev/null 2>&1; }
admin_start_works() {
	docker start "$(admin_id)" >/dev/null
	[[ "$(admin_state)" == "running 0" ]] && has_prefix "$(terminal_api_key)" hskey-api-
}

# ---------------------------------------------------------------------------
HS_IMAGE=$(grep -o 'docker.io/headscale/headscale:[0-9.]*' "$ROOT/blueprints/headscale-headplane/docker-compose.yml" | head -1)
HP_IMAGE=$(grep -o 'ghcr.io/tale/headplane:[^ ]*' "$ROOT/blueprints/headscale-headplane/docker-compose.yml")

step "Existing deployment: template $PREV_TEMPLATE_REF on headscale $FROM_HEADSCALE / headplane $FROM_HEADPLANE"
compose_down
docker rm -f "${ts_names[@]}" "$TRAEFIK" >/dev/null 2>&1 || true
node "$ROOT/scripts/render.mjs" --out "$OUT" --app-name "$APP" --base-domain "$BASE_DOMAIN" \
	--ref "$PREV_TEMPLATE_REF" --dokploy-routing shared
pki_create
traefik_start shared
sed -e "s|${HS_IMAGE}|${HS_IMAGE%:*}:$FROM_HEADSCALE|g" -e "s|${HP_IMAGE}|${HP_IMAGE%:*}:$FROM_HEADPLANE|" \
	"$COMPOSE_FILE" >"$COMPOSE_FILE.tmp"
mv "$COMPOSE_FILE.tmp" "$COMPOSE_FILE"
check "both services start and become healthy" wait_healthy

step "Endpoints and authentication"
check "headscale /health returns 200" test "$(http_code http://headscale:8080/health)" = 200
check "headplane /admin/login returns 200" test "$(http_code http://headplane:3000/admin/login)" = 200
check "unauthenticated /admin/machines redirects (302)" test "$(http_code http://headplane:3000/admin/machines)" = 302
check "metrics port 9090 is not reachable from the network" metrics_unreachable
check "no host ports are published" no_published_ports
API_KEY=$(bash "$ROOT/scripts/create-api-key.sh" "$APP" 1d 2>/dev/null)
check "SSH fallback scripts/create-api-key.sh returns an API key" has_prefix "$API_KEY" hskey-api-
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
	ts_start "${ts_names[$((i - 1))]}" "e2e-node$i" "$AUTH_KEY"
done
check "node 1 is up" wait_ts "${ts_names[0]}"
check "node 2 is up" wait_ts "${ts_names[1]}"
check "Headscale lists 2 nodes, both online (via https://$HS_HOST)" wait_nodes_online 2
check "Headscale lists exactly 2 nodes" test "$(node_count)" = 2
check "MagicDNS suffix is vpn.$BASE_DOMAIN" magicdns_suffix_is "vpn.$BASE_DOMAIN"
check "node 1 can tailscale-ping node 2" ts_ping
BEFORE=$(state_snapshot)
echo "  state: $BEFORE"

step "Re-import the current template (compose, env, mounts and domains replaced; volumes kept)"
node "$ROOT/scripts/render.mjs" --out "$OUT" --app-name "$APP" --base-domain "$BASE_DOMAIN" --dokploy-routing shared
check "rendered compose, .env and mount templates exist" \
	test -f "$COMPOSE_FILE" -a -f "$OUT/code/.env" \
	-a -f "$OUT/files/templates/headscale.yaml" -a -f "$OUT/files/templates/headplane.yaml"
check "no unresolved Dokploy \${...} placeholders in mount templates" no_dokploy_placeholders
check "docker compose config is valid" compose config --quiet
check "stack recreated on ${HS_IMAGE##*/} / ${HP_IMAGE##*/}, all healthy" wait_healthy
check "headscale-config rendered the configuration and exited 0" test "$(config_state)" = "exited 0"
check "rendered configs carry the Environment values, no placeholders left" \
	config_rendered_for "headscale.$BASE_DOMAIN" "headplane.$BASE_DOMAIN" "vpn.$BASE_DOMAIN"
check "headscale configtest accepts the rendered config" \
	docker run --rm -v "${APP}_headscale-config:/etc/headscale:ro" "$HS_IMAGE" configtest
check "running images are the pinned ones" running_pinned_images
check "users, nodes and Noise key preserved across the re-import" test "$(state_snapshot)" = "$BEFORE"
check "old session rejected (re-import generated a new cookie secret)" session_rejected "$COOKIE"
COOKIE=$(hp_login "$API_KEY")
check "signing in again with the existing API key works" session_valid "$COOKIE"
check "cookie secret appears in no container log" absent_from_logs "$(env_value HEADPLANE_COOKIE_SECRET)"
check "both nodes back online after the re-import" wait_nodes_online 2
check_pages machines users acls dns settings settings/auth-keys
hp_post "$COOKIE" /admin/acls "policy=$(printf '%s' "$POLICY" | urlencode)" >/dev/null
check "Headplane saved an ACL policy to the Headscale database" policy_saved
check "nodes still connected under the saved policy" ts_ping

step "Bootstrap through the headscale-admin helper (Dokploy Terminal, /bin/sh tab)"
check "Dokploy's 'Bash' tab is unavailable (no bash in the image)" bash_tab_unavailable
ADMIN_KEY=$(terminal_api_key)
check "'headscale apikeys create' in the helper's sh returns an API key" has_prefix "$ADMIN_KEY" hskey-api-
check "the key was created by the server (listed by the production container)" server_lists_key "$ADMIN_KEY"
ADMIN_COOKIE=$(hp_login "$ADMIN_KEY")
check "Headplane login works with the helper-created key" session_valid "$ADMIN_COOKIE"
check "the key appears in no container's logs" absent_from_logs "$ADMIN_KEY"
check "helper does not mount Headscale's data volume" admin_has_no_data_access
check "helper root filesystem is read-only" admin_rootfs_readonly
check "helper is attached only to the project network" admin_only_project_network
check "admin socket lives on tmpfs" socket_on_tmpfs
check "Headplane cannot reach the admin socket" headplane_has_no_socket
check "still no host ports published (helper included)" no_published_ports
compose restart headscale >/dev/null 2>&1
wait_healthy
check "helper reconnects after Headscale restarts (stale socket replaced)" has_prefix "$(terminal_api_key)" hskey-api-

step "Helper idle timeout and Start from Dokploy's Containers tab"
cat >"$OUT/code/short-ttl.yml" <<'EOF'
services:
  headscale-admin:
    command: ["5"]
EOF
docker compose --project-directory "$OUT/code" -f "$COMPOSE_FILE" -f "$OUT/code/short-ttl.yml" -p "$APP" \
	up -d headscale-admin >/dev/null 2>&1
check "helper exits cleanly (code 0) when its idle timeout ends" wait_admin_exited
check "an exited helper offers no shell (no standing admin access)" exited_admin_has_no_shell
check "helper wrote nothing to its logs" admin_logs_empty
check "Start (Containers tab) brings it back and a key can be created" admin_start_works
rm -f "$OUT/code/short-ttl.yml"
check "redeploy restores the normal helper" wait_healthy

step "Change the host names through the Environment only, then redeploy"
set_env HEADSCALE_HOST "hs.example.org"
set_env HEADPLANE_HOST "admin.example.org"
set_env MAGICDNS_DOMAIN "tailnet.example.org"
HP_HOST=admin.example.org
check "redeploy healthy" wait_healthy
check "both configs re-rendered with the new hosts" config_rendered_for hs.example.org admin.example.org tailnet.example.org
check "Headplane works under the new host" session_valid "$(hp_login "$API_KEY")"
check "both nodes back online after the restart" wait_nodes_online 2
check "clients receive the new MagicDNS suffix tailnet.example.org" magicdns_suffix_is tailnet.example.org
set_env HEADSCALE_HOST "Not A Host"
check "invalid HEADSCALE_HOST blocks the deploy with a clear error" deploy_rejected_with "HEADSCALE_HOST is invalid"
# Compose recreates the dependants before the renderer runs, so an invalid
# value stops the control plane until it is fixed (documented in the README).
check "  Headscale stays stopped until the value is fixed" headscale_stopped
set_env HEADSCALE_HOST "headscale.$BASE_DOMAIN"
set_env HEADPLANE_HOST "headplane.$BASE_DOMAIN"
set_env MAGICDNS_DOMAIN "vpn.$BASE_DOMAIN"
HP_HOST="headplane.$BASE_DOMAIN"
check "restoring the original values redeploys healthy" wait_healthy
check "configs rendered for the original hosts again" \
	config_rendered_for "headscale.$BASE_DOMAIN" "headplane.$BASE_DOMAIN" "vpn.$BASE_DOMAIN"

step "Edit a mount template (Advanced -> Mounts), Deploy, then Restart"
sed -i.bak 's/^  level: info$/  level: debug/' "$OUT/files/templates/headscale.yaml" && rm -f "$OUT/files/templates/headscale.yaml.bak"
wait_healthy
check "Deploy re-renders the edited template" template_edit_rendered
compose restart headscale >/dev/null 2>&1
check "Restart applies it (healthy, debug logging active)" headscale_debug_logging

step "Restart all containers"
compose restart >/dev/null 2>&1
check "healthy after restart" wait_healthy
check "state preserved across restart" test "$(state_snapshot)" = "$BEFORE"
check "existing Headplane session still valid after restart" session_valid "$COOKIE"
check "both nodes back online after restart" wait_nodes_online 2

step "Recreate containers (down without -v, then up)"
compose down >/dev/null 2>&1
check "healthy after recreate" wait_healthy
check "state preserved across recreate" test "$(state_snapshot)" = "$BEFORE"
check "both nodes back online after recreate" wait_nodes_online 2
check "node 1 can still ping node 2" ts_ping

step "Backup"
DOKPLOY_COMPOSE_DIR="$RENDER_ROOT" bash "$ROOT/scripts/backup.sh" "$APP" "$BACKUP_DIR" >/dev/null
check "backup archives and manifest written" \
	test -s "$BACKUP_DIR/headscale-data.tar.gz" -a -s "$BACKUP_DIR/headplane-data.tar.gz" \
	-a -s "$BACKUP_DIR/files.tar.gz" -a -s "$BACKUP_DIR/MANIFEST"
check "containers running again after backup" wait_healthy

step "Fresh installation (all containers, networks and volumes removed)"
compose down -v --remove-orphans >/dev/null 2>&1
check "no project volumes remain" test -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$APP")"
check "fresh deployment becomes healthy" wait_healthy
check "fresh deployment is empty (0 nodes)" test "$(node_count)" = 0
FRESH_KEY=$(terminal_api_key)
check "first API key bootstrapped through the helper" has_prefix "$FRESH_KEY" hskey-api-
check "first Headplane login on the fresh install" session_valid "$(hp_login "$FRESH_KEY")"

step "Restore"
bash "$ROOT/scripts/restore.sh" "$APP" "$BACKUP_DIR" --yes >/dev/null
check "healthy after restore" wait_healthy
check "users, nodes and Noise key restored" test "$(state_snapshot)" = "$BEFORE"
check "Headplane session restored" session_valid "$COOKIE"
check "both nodes back online after restore (same identities)" wait_nodes_online 2
check "node 1 can ping node 2 after restore" ts_ping

step "Migration from a Headscale-only installation (docs/MIGRATION-HABS.md)"
MIGRATION_DIR="$RENDER_ROOT/$APP-migration"
rm -rf "$MIGRATION_DIR" && mkdir -p "$MIGRATION_DIR"
cp "$BACKUP_DIR/headscale-data.tar.gz" "$MIGRATION_DIR/"
compose down -v --remove-orphans >/dev/null 2>&1
check "fresh target deployment becomes healthy" wait_healthy
bash "$ROOT/scripts/restore.sh" "$APP" "$MIGRATION_DIR" --yes >/dev/null 2>&1
rm -rf "$MIGRATION_DIR"
check "healthy after restoring only headscale-data" wait_healthy
check "users, nodes and Noise key carried over" test "$(state_snapshot)" = "$BEFORE"
check "both clients online again without re-registration" wait_nodes_online 2
check "an API key from the old database signs in to the new Headplane" session_valid "$(hp_login "$API_KEY")"

done_msg
