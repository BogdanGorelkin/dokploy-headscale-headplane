# Testing

| | Automated (no Dokploy) | Manual (live Dokploy) |
| --- | --- | --- |
| Where | Laptop or GitHub Actions | A real Dokploy instance |
| Proves | The template is valid; Dokploy's processor and deploy-time labelling produce a working stack; routing behind Dokploy's Traefik version in both network modes; Headplane management; real Tailscale clients over HTTPS; upgrades, Environment changes, fresh installs, backup/restore and migration | Dokploy's UI (catalog, import, terminal), Let's Encrypt, real DNS, real devices on the internet |

## Automated tests

```bash
npm ci
npm run validate                    # static checks
npm run test:negative               # 29 broken variants must be rejected
npm run build:catalog -- --check    # meta.json in sync
npm run check:catalog               # install from this checkout served as a catalog
npm run build:import && node scripts/validate.mjs --import dist/import-base64.txt
git clone --depth 1 https://github.com/Dokploy/templates /tmp/dokploy-templates
scripts/check-upstream.sh /tmp/dokploy-templates
for v in v0.10.0 v0.11.0; do docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:$v -x scripts/*.sh tests/*.sh; done
npm run test:routing                # Docker; 62 checks × shared/isolated, ~2 min each
npm run test:e2e                    # Docker + full git history; 95 checks, ~3 min
```

**`tests/routing-traefik.sh [shared|isolated]`** runs Traefik 3.6.25 configured like Dokploy
(entrypoints, `redirect-to-https@file`, Docker provider), with a test CA and the labels and
networks Dokploy adds at deploy time (`scripts/lib/dokploy-deploy.mjs`). It checks:

- `/` and `/admin` redirects (GET 302, HEAD 307, HTTP and HTTPS, query strings), following them
  without loops
- 404 for paths outside `/admin/` and for probes under it; 405 for methods the UI never sends;
  Headplane writes **no** log line for any of them
- assets, health, login, cookie attributes, every page, users, pre-auth keys, the ACL editor's
  `PATCH`
- Headscale's health, public API and control endpoint, and a Tailscale client registering
  through Traefik over HTTPS

**`tests/e2e-local.sh`** (also behind a Dokploy-style Traefik, with clients over HTTPS):

1. deploys template `5bca341` (the live version) on Headscale 0.29.4 / Headplane 0.7.1; SSH
   fallback key; Headplane user and pre-auth key; two nodes, both **online** in Headscale
2. re-imports the current template (new cookie secret, so old sessions are rejected) with all
   state preserved
3. bootstraps a key in `headscale-admin` exactly as Dokploy's terminal does; checks the key is
   in no log, the helper has no database access, is read-only, isolated and on a tmpfs socket,
   and survives restarts; idle timeout and Start
4. changes all hosts through the Environment only; an invalid value fails the deploy with a
   clear error; a mount template edit is applied by Deploy + Restart
5. restart, recreate, backup, a fresh install bootstrapped via the helper, restore, and a
   migration from a **Headscale-only** backup, with clients back online without re-registration

Not covered automatically: Dokploy's UI, Let's Encrypt, public DNS, Cloudflare, real devices.

---

## Manual test 1: upgrade the live `gorelkin.vip` deployment in place

The live deployment runs template `5bca341` (configuration in `/etc/...` mounts, no
`headscale-config`). This validates the upgrade path and the new routing on real Dokploy.

| | Value |
| --- | --- |
| Headscale | `https://headscale.gorelkin.vip` |
| Headplane | `https://headplane.gorelkin.vip/admin/` |
| MagicDNS | `*.vpn.gorelkin.vip` |

1. **Backup** (SSH): `./scripts/backup.sh <app> /root/hs-pre-upgrade`. Note
   `headscale nodes list` (admin shell).
2. **Build the import:**

   ```bash
   npm ci
   npm run build:import -- --base-domain gorelkin.vip --out dist/import-gorelkin.vip.txt
   node scripts/validate.mjs --import dist/import-gorelkin.vip.txt --expect-base-domain gorelkin.vip
   ```

3. **Advanced → Import** → paste. The preview shows:
   - [ ] Domains `headscale.gorelkin.vip` → `headscale:8080`; `headplane.gorelkin.vip` path `/admin/` → `headplane:3000`
   - [ ] Environment: `HEADSCALE_HOST`, `HEADPLANE_HOST`, `MAGICDNS_DOMAIN` with these hosts, and a new 32-character `HEADPLANE_COOKIE_SECRET`
   - [ ] Mounts `/templates/headscale.yaml`, `/templates/headplane.yaml`
4. **Domains:** set **Let's Encrypt** on both again (import resets them to *None*).
5. **Advanced → Isolated Deployment:** leave as before (enabling it is a separate change; see Manual test 2).
6. **Deploy.**

- [ ] **Containers:** `headscale-config` exited (0); `headscale`, `headplane`, `headscale-admin` healthy
- [ ] `headscale nodes list` unchanged; your devices are online without re-login
- [ ] Old Headplane session is gone (new cookie secret). Sign in again with a key from the admin shell
- [ ] Routing (from any machine):

  ```bash
  H=headplane.gorelkin.vip
  curl -sI https://$H/ | grep -iE '^HTTP|^location'          # 302, location: https://$H/admin/
  curl -sI http://$H/ | grep -iE '^HTTP|^location'           # 302, location: https://$H/admin/
  curl -sL -o /dev/null -w '%{url_effective} %{http_code}\n' https://$H/   # .../admin/login 200
  for p in /favicon.ico /xmlrpc.php /.env '/?rest_route=/wp/v2/users/' /debug/default/view /admin/.env; do
    printf '%-32s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://$H$p"; done
  # 404 for everything except /?rest_route=… (302 to /admin/?rest_route=…)
  curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS https://$H/admin/login   # 405
  ```

- [ ] **Containers → headplane → View Logs:** no React Router stack traces from these requests
- [ ] In Headplane: create a user and a pre-auth key; save the ACL policy (Access Control)

**Rollback if needed:** Advanced → Import the old string (or the commit `5bca341`
`import-gorelkin.vip.txt`), Let's Encrypt again, Deploy. If data looks wrong,
`./scripts/restore.sh <app> /root/hs-pre-upgrade`.

## Manual test 2: install from the Templates catalog

The end-user installation. For HABS this is [MIGRATION-HABS.md, Phase A](MIGRATION-HABS.md#phase-a-catalog-installation-on-temporary-subdomains),
on temporary subdomains next to production.

1. Make the catalog reachable (public repository; pin to a commit):
   `node scripts/check-catalog.mjs --base-url https://raw.githubusercontent.com/<owner>/<repo>/<sha>` → `catalog OK`
2. **Create Service → Template → Base URL** → pick *Headscale + Headplane* → **Create**.
   - [ ] The service exists, not deployed, with `*.sslip.io` hosts in Environment and Domains
3. **Advanced → Enable Isolated Deployment.** Environment and Domains → your hosts;
   **Let's Encrypt** on both.
4. **Deploy**, then work through the checks of Manual test 1 (containers, routing).
5. **Containers → headscale-admin → Terminal → /bin/sh** →
   `headscale apikeys create --expiration 90d` → sign in to Headplane.
   - [ ] No SSH used at any point
6. Register a disposable node:

   ```bash
   docker run -d --name ts-1 -e TS_AUTHKEY=<pre-auth key> \
     -e TS_EXTRA_ARGS=--login-server=https://<HEADSCALE_HOST> \
     -e TS_USERSPACE=true -e TS_HOSTNAME=ts-1 -e TS_STATE_DIR=/var/lib/tailscale \
     tailscale/tailscale:v1.104.2
   ```

   - [ ] The node is online in Headplane; `docker exec ts-1 tailscale status --json | grep MagicDNSSuffix` shows `MAGICDNS_DOMAIN`
7. Change `MAGICDNS_DOMAIN` in the Environment → **Deploy** → the node gets the new suffix
   within a minute; Headplane's DNS page shows it.
8. Optional: set `HEADSCALE_HOST` to `Not.Valid` → Deploy fails with `HEADSCALE_HOST is invalid`
   in `headscale-config`'s logs; restore the value → Deploy → healthy.
9. Clean up: delete the service with volumes, the DNS records, and `docker rm -f ts-1`.

## Results

| Check | Manual test 1 | Manual test 2 / HABS A |
| --- | --- | --- |
| Dokploy version | | |
| Import / catalog preview | | |
| Deploy healthy | | |
| Routing and filtering | | |
| No stack traces in Headplane logs | | |
| Bootstrap in Dokploy UI | | |
| Login, users, keys, ACL | | |
| Existing devices kept (test 1) / new node (test 2) | | |
| Environment change applied | | |
