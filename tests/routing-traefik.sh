#!/usr/bin/env bash
# Routing test behind a real Traefik, wired exactly the way Dokploy wires a
# Compose deployment (Traefik version, entrypoints, redirect-to-https@file,
# per-domain router labels, dokploy-network or Isolated Deployment network).
#
#   tests/routing-traefik.sh [shared|isolated]      (default: shared)
#
# Covers: / -> /admin/ redirect (GET, HEAD, HTTP, HTTPS, query strings), no
# redirect loops, unknown paths and methods answered by Traefik without
# reaching Headplane, Headplane assets/navigation/login/session cookies, users
# and pre-auth keys via Headplane, Headscale's public API and control protocol
# (a Tailscale client registers through Traefik over HTTPS).
#
# Requires docker (compose v2), node >= 20, openssl, internet access. The test
# creates `dokploy-network` if it does not exist and removes it afterwards.
set -euo pipefail

MODE=${1:-shared}
[[ "$MODE" == shared || "$MODE" == isolated ]] || { echo "usage: $0 [shared|isolated]" >&2; exit 2; }
APP=hshp-route-$MODE
BASE_DOMAIN=example.test
HS_HOST="headscale.$BASE_DOMAIN"
HP_HOST="headplane.$BASE_DOMAIN"
OUT="$(cd "$(dirname "$0")/.." && pwd)/.render/$APP"
NET=dokploy-network
# shellcheck source=tests/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$ROOT"
TRAEFIK="$APP-traefik"
TS_NODE="$APP-ts-node"
PKI="$OUT/pki"
created_network=0

cleanup() {
	if [[ "${KEEP:-0}" == "1" ]]; then
		echo "KEEP=1: leaving '$APP' running"
		return 0
	fi
	docker rm -f "$TS_NODE" >/dev/null 2>&1 || true
	compose_down
	traefik_stop
}
trap cleanup EXIT

# curl from a client container on dokploy-network; every request for the two
# public host names goes to Traefik, like DNS pointing at the Dokploy server.
curl_t() {
	docker run --rm --network "$NET" -v "$PKI/ca.pem:/ca.pem:ro" "$CURL_IMAGE" -sS --cacert /ca.pem \
		--connect-to "$HS_HOST:80:$TRAEFIK:80" --connect-to "$HS_HOST:443:$TRAEFIK:443" \
		--connect-to "$HP_HOST:80:$TRAEFIK:80" --connect-to "$HP_HOST:443:$TRAEFIK:443" "$@"
}
status() { curl_t -o /dev/null -w '%{http_code}' "$@"; }
location() { curl_t -o /dev/null -w '%{redirect_url}' "$@"; }
is() { [[ "$1" == "$2" ]] || { echo "    got '$1', expected '$2'"; return 1; }; }

policy_saved() { hs policy get 2>/dev/null | contains '"accept"'; }
hp_log_lines() { docker logs "$(compose ps -q headplane)" 2>&1 | wc -l | tr -d ' '; }

hp_login() {
	curl_t -D - -o /dev/null -X POST "https://$HP_HOST/admin/login" -H "Origin: https://$HP_HOST" \
		--data-urlencode "api_key=$1" | tr -d '\r' | sed -n 's/^set-cookie: //ip'
}
hp_post() {
	curl_t -X POST -H "Origin: https://$HP_HOST" -H "Cookie: $1" --data "$3" "https://$HP_HOST$2"
}

cookie_attrs_ok() { grep -q 'Path=/admin' <<<"$1" && grep -q 'Secure' <<<"$1" && grep -q 'SameSite=Lax' <<<"$1"; }
noise_key_served() { curl_t "https://$HS_HOST/key?v=116" | contains publicKey; }
machine_listed() {
	for _ in $(seq 1 15); do
		curl_t -H "Cookie: $COOKIE" "https://$HP_HOST/admin/machines" | contains "$1" && return 0
		sleep 2
	done
	return 1
}
follow_root() { curl_t -L --max-redirs 5 -o /dev/null -w '%{url_effective} %{http_code} %{num_redirects}' "https://$HP_HOST/"; }
follow_root_http() { curl_t -L --max-redirs 5 -o /dev/null -w '%{url_effective} %{http_code} %{num_redirects}' "http://$HP_HOST/"; }

# ---------------------------------------------------------------------------
step "Traefik wired like Dokploy ($MODE network mode)"
compose_down
docker rm -f "$TRAEFIK" "$TS_NODE" >/dev/null 2>&1 || true
node "$ROOT/scripts/render.mjs" --out "$OUT" --app-name "$APP" --base-domain "$BASE_DOMAIN" --dokploy-routing "$MODE"

pki_create
traefik_start "$MODE"
check "stack deployed with Dokploy's labels and networks, all healthy" wait_healthy
sleep 3 # Traefik picks up container labels asynchronously

step "Root redirect"
check "GET https://$HP_HOST/ -> 302" is "$(status "https://$HP_HOST/")" 302
check "  Location is https://$HP_HOST/admin/" is "$(location "https://$HP_HOST/")" "https://$HP_HOST/admin/"
# Traefik's redirect middlewares answer non-GET methods with 307 (method
# preserving); for HEAD that is equivalent to 302.
check "HEAD https://$HP_HOST/ -> 307 /admin/" is "$(status -I "https://$HP_HOST/") $(location -I "https://$HP_HOST/")" "307 https://$HP_HOST/admin/"
check "GET http://$HP_HOST/ -> 302 straight to https://…/admin/" is "$(status "http://$HP_HOST/") $(location "http://$HP_HOST/")" "302 https://$HP_HOST/admin/"
check "query string is kept (GET /?rest_route=… -> /admin/?rest_route=…)" \
	is "$(location "https://$HP_HOST/?rest_route=/wp/v2/users/")" "https://$HP_HOST/admin/?rest_route=/wp/v2/users/"
check "GET /admin (no slash) -> 302 /admin/" is "$(status "https://$HP_HOST/admin") $(location "https://$HP_HOST/admin")" "302 https://$HP_HOST/admin/"
check "following https://…/ ends at /admin/login (200) without a loop" \
	is "$(follow_root)" "https://$HP_HOST/admin/login 200 2"
check "following http://…/ ends at /admin/login (200) without a loop" \
	is "$(follow_root_http)" "https://$HP_HOST/admin/login 200 2"
check "/admin keeps its query string (/admin?x=1 -> /admin/?x=1)" \
	is "$(location "https://$HP_HOST/admin?x=1")" "https://$HP_HOST/admin/?x=1"
check "http://…/admin/login -> 301 https (Dokploy's redirect-to-https)" \
	is "$(status "http://$HP_HOST/admin/login") $(location "http://$HP_HOST/admin/login")" "301 https://$HP_HOST/admin/login"

step "Irrelevant requests are answered by Traefik and never reach Headplane"
before=$(hp_log_lines)
for path in /favicon.ico /xmlrpc.php /.env /debug/default/view /wp-login.php /admin.php /administrator /api/v1/user; do
	check "GET $path -> 404" is "$(status "https://$HP_HOST$path")" 404
done
check "GET http://…/xmlrpc.php -> 404" is "$(status "http://$HP_HOST/xmlrpc.php")" 404
for method in OPTIONS POST PUT DELETE PATCH; do
	check "$method / -> 404" is "$(status -X "$method" "https://$HP_HOST/")" 404
done
for path in /admin/.env /admin/.git/config /admin/wp-login.php /admin/x/shell.php /admin/cgi-bin/test.cgi; do
	check "GET $path -> 404 (probe under /admin/)" is "$(status "https://$HP_HOST$path")" 404
done
for method in OPTIONS PUT DELETE TRACE; do
	check "$method /admin/login -> 405 (method the UI never sends)" is "$(status -X "$method" "https://$HP_HOST/admin/login")" 405
done
check "Headplane wrote no log lines for any of them" is "$(hp_log_lines)" "$before"

step "Legitimate Headplane routes"
check "GET /admin/login -> 200" is "$(status "https://$HP_HOST/admin/login")" 200
check "GET /admin/favicon.ico (linked by Headplane) -> 200" is "$(status "https://$HP_HOST/admin/favicon.ico")" 200
asset=$(curl_t "https://$HP_HOST/admin/login" | grep -o '/admin/assets/[A-Za-z0-9._-]*\.js' | head -1)
check "a hashed asset from the login page ($asset) -> 200" is "$(status "https://$HP_HOST$asset")" 200
check "GET /admin/healthz -> 200" is "$(status "https://$HP_HOST/admin/healthz")" 200
check "unauthenticated /admin/machines -> 302 /admin/login" \
	is "$(status "https://$HP_HOST/admin/machines") $(location "https://$HP_HOST/admin/machines")" "302 https://$HP_HOST/admin/login"

API_KEY=$(terminal_api_key)
check "API key from the headscale-admin helper" has_prefix "$API_KEY" hskey-api-
set_cookie=$(hp_login "$API_KEY")
COOKIE=${set_cookie%%;*}
check "login through Traefik sets the session cookie" has_prefix "$COOKIE" _hp_auth=
check "  cookie attributes: Path=/admin, Secure, SameSite=Lax" cookie_attrs_ok "$set_cookie"
check "authenticated /admin/ -> Headplane home redirects to /admin/machines" \
	is "$(location -H "Cookie: $COOKIE" "https://$HP_HOST/admin/")" "https://$HP_HOST/admin/machines"
for page in machines users acls dns settings settings/auth-keys; do
	check "authenticated GET /admin/$page -> 200" is "$(status -H "Cookie: $COOKIE" "https://$HP_HOST/admin/$page")" 200
done
patch_policy() {
	curl_t -o /dev/null -w '%{http_code}' -X PATCH -H "Origin: https://$HP_HOST" -H "Cookie: $COOKIE" \
		--data-urlencode 'policy={"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}' "https://$HP_HOST/admin/acls"
}
check "PATCH /admin/acls (how the ACL editor saves) passes through" is "$(patch_policy)" 200
check "  the policy reached Headscale" policy_saved
hp_post "$COOKIE" /admin/users "action_id=create_user&username=bob&display_name=Bob&email=bob@$BASE_DOMAIN" >/dev/null
BOB=$(user_id bob)
check "user 'bob' created through Headplane via Traefik" test -n "$BOB"
AUTH_KEY=$(hp_post "$COOKIE" /admin/settings/auth-keys \
	"action_id=add_preauthkey&user_id=$BOB&expiry=1&reusable=on&ephemeral=off" |
	grep -o 'hskey-auth-[A-Za-z0-9_-]*' | awk 'length > 60' | head -1)
check "pre-auth key created through Headplane via Traefik" test -n "$AUTH_KEY"

step "Headscale through Traefik"
check "https://$HS_HOST/health -> 200" is "$(status "https://$HS_HOST/health")" 200
check "http://$HS_HOST/health -> 301 https" is "$(status "http://$HS_HOST/health")" 301
check "public API /api/v1/user with the API key -> 200" \
	is "$(status -H "Authorization: Bearer $API_KEY" "https://$HS_HOST/api/v1/user")" 200
check "public API without a key -> 401" is "$(status "https://$HS_HOST/api/v1/user")" 401
check "control endpoint /key returns the Noise public key" noise_key_served

ts_start "$TS_NODE" route-node "$AUTH_KEY"
check "Tailscale client registers via https://$HS_HOST through Traefik (control protocol upgrade)" wait_ts "$TS_NODE"
check "  Headscale reports the node online (active control session)" wait_nodes_online 1
check "node shows up in Headplane's machine list" machine_listed route-node

done_msg
