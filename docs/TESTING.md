# Testing

There are two kinds of tests, and they prove different things.

| | Automated (no Dokploy) | Manual (live Dokploy) |
| --- | --- | --- |
| Where | Laptop or GitHub Actions | A real Dokploy instance |
| Proves | The template is well-formed, Dokploy's processor resolves it, all containers work together, the admin helper creates keys without logging them or touching the database, Headplane manages users/keys, Tailscale nodes join, state survives upgrade/restart/fresh install/restore | Dokploy's import UI accepts it, Traefik routes both domains, Let's Encrypt issues certificates, **Dokploy's web terminal reaches the admin helper**, real clients connect over the internet |
| Commands | below | This document, from [Manual test](#manual-test-on-a-live-dokploy-instance) on |

## Automated tests

```bash
npm ci
npm run validate                    # static checks
node tests/validate-negative.mjs    # validator rejects 20 broken variants
npm run build:import && node scripts/validate.mjs --import dist/import-base64.txt
git clone --depth 1 https://github.com/Dokploy/templates /tmp/dokploy-templates
scripts/check-upstream.sh /tmp/dokploy-templates
for v in v0.10.0 v0.11.0; do docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:$v scripts/*.sh tests/*.sh; done
npm run test:e2e                    # Docker + internet + full git history, ~2 minutes
```

`tests/e2e-local.sh` (74 checks):

1. Deploys the **previous template version** (`d437210`, no admin helper) on the previous image
   releases. It creates a key through the SSH fallback, a user and a pre-auth key through
   Headplane, and two Tailscale nodes.
2. Upgrades in place to the current template and pinned images. All state must survive.
3. Bootstraps a key in `headscale-admin` with the same `docker exec -w / <container> sh` that
   Dokploy's terminal runs. It checks that the key works in Headplane and appears in no
   container log, and that the helper has no database mount, no ports, a read-only filesystem,
   only the project network and a tmpfs socket. It also checks that the helper survives a
   Headscale restart, exits cleanly after its idle timeout, and works again after **Start**.
4. Restarts and recreates the stack, backs it up, removes every container, network and volume,
   bootstraps the **fresh install** through the helper, then restores.

Run with `KEEP=1` to leave the stack running for inspection. The test does **not** cover
Traefik, TLS, Let's Encrypt, Dokploy's UI, or clients outside the Docker network.

**GitHub Actions** runs all of the above on every push and pull request, and uploads the generic
import string. If the repository variable `IMPORT_BASE_DOMAIN` is set, CI also builds
`import-<domain>.txt` and verifies it contains exactly `headscale.<domain>`,
`headplane.<domain>` and `vpn.<domain>`.

---

## Manual test on a live Dokploy instance

A **clean installation** on the following names. Replace them for any other instance.

| | Value |
| --- | --- |
| Dokploy | `https://dokploy.gorelkin.vip` |
| Headscale | `https://headscale.gorelkin.vip` |
| Headplane | `https://headplane.gorelkin.vip/admin` |
| MagicDNS | `*.vpn.gorelkin.vip` |

Target flow: **import → configure domains → deploy → bootstrap the admin key in Dokploy's UI →
log in to Headplane.** Nothing from an earlier test installation is needed or reused.

### 0. Remove the earlier test installation

1. Dokploy → the old `headscale-test` service → **Delete**, including its volumes.
2. Delete the DNS records `headscale-test.gorelkin.vip` and `headplane-test.gorelkin.vip`.
3. Stop and remove any Tailscale test nodes registered against `headscale-test.gorelkin.vip`
   (`docker rm -f ts-test-1 ts-test-2`, or `tailscale logout`).
4. Optional, on the host: `docker volume ls | grep -i headscale` shows nothing from the old app.

### 1. Preconditions

- [ ] Note the Dokploy version (shown in the Dokploy UI)
- [ ] Check whether another Headscale runs on the deployment host. Dokploy UI → **Docker**, or
  over SSH: `docker ps --filter label=com.docker.compose.service=headscale`. If one does, enable
  *Isolated Deployment* in step 4.
- [ ] Server public IPv4 (and IPv6)

### 2. Build the import string

```bash
npm ci
npm run build:import -- --base-domain gorelkin.vip --out dist/import-gorelkin.vip.txt
node scripts/validate.mjs --import dist/import-gorelkin.vip.txt --expect-base-domain gorelkin.vip
```

Expected: `import artifact OK`, domains `headscale.gorelkin.vip:8080` and
`headplane.gorelkin.vip:3000`, both `https=true`, and `validation passed (3 services, 2 domains,
2 mounts…)`. Alternatively, set the repository variable `IMPORT_BASE_DOMAIN=gorelkin.vip` and
download the same file from the CI run's `dokploy-import-base64` artifact.

### 3. DNS

DNS only (Cloudflare: grey cloud):

| Name | Type | Value |
| --- | --- | --- |
| `headscale.gorelkin.vip` | A (+ AAAA) | server IP |
| `headplane.gorelkin.vip` | A (+ AAAA) | server IP |

Do **not** create `vpn.gorelkin.vip`.

```bash
dig +short headscale.gorelkin.vip   # -> server IP, not a Cloudflare IP
dig +short headplane.gorelkin.vip
```

### 4. Import

1. Dokploy → new project (e.g. `headscale`) → **Create Service → Compose**, name `headscale`.
2. **Advanced → Enable Isolated Deployment**: required if step 1 found another Headscale,
   recommended anyway.
3. **Advanced → Import** → paste `dist/import-gorelkin.vip.txt`. Check the preview:
   - [ ] Domains: `headscale.gorelkin.vip` → `headscale:8080`, `headplane.gorelkin.vip` → `headplane:3000`
   - [ ] Environment variables: none
   - [ ] Mounts: `/etc/headscale/config.yaml`, `/etc/headplane/config.yaml`
   - [ ] Headscale mount: `server_url: https://headscale.gorelkin.vip`, `base_domain: vpn.gorelkin.vip`
   - [ ] Headplane mount: a 32-character `cookie_secret` (not a `${...}` placeholder)
   - [ ] Compose: `headscale`, `headplane`, `headscale-admin`; volume `headscale-socket` with `type: tmpfs`
4. Import. **Domains** shows both with HTTPS enabled and *Certificate Provider: None*.

### 5. Configure domains

For each domain: edit → **Certificate Provider: Let's Encrypt** → save.

### 6. Deploy

**Deploy** and watch the log until `Docker Compose Deployed`. Then **Containers**:

- [ ] `headscale`, `headplane`, `headscale-admin` all *running*. Health shows *healthy* after
  ≤ 30 s (container status column)
- [ ] No published ports. Optional check on the host:
  `docker ps --filter label=com.docker.compose.project=<app> --format '{{.Names}} {{.Ports}}'`
  shows no `0.0.0.0:…->`

### 7. Routing and TLS

From any machine:

```bash
curl -fsS https://headscale.gorelkin.vip/health                     # {"status":"pass"}
curl -sI http://headscale.gorelkin.vip/health | head -1             # 301/308 to https
curl -vsI https://headscale.gorelkin.vip/health 2>&1 | grep issuer  # Let's Encrypt
curl -sI https://headplane.gorelkin.vip/admin/login | head -1       # 200
curl -sI https://headplane.gorelkin.vip/admin/machines | grep -i -E '^HTTP|^location'  # 302 -> /admin/login
for p in 8080 3000 9090 50443; do nc -z -w 3 headscale.gorelkin.vip $p && echo "OPEN $p (unexpected)" || echo "closed $p"; done
```

### 8. Bootstrap the first API key in the Dokploy UI (no SSH)

This step decides whether first-time setup really works without SSH. Record exactly what you see.

1. Service → **Containers** → `headscale-admin` → **⋯ → Terminal**.
2. Select the **/bin/sh** tab (the *Bash* tab is expected to fail with `executable file not found`).
3. Run `headscale apikeys create --expiration 90d` and copy the `hskey-api-…` value.

- [ ] The terminal opens at `/ #` (busybox shell)
- [ ] `headscale apikeys create --expiration 90d` prints one key
- [ ] `headscale apikeys list` shows it, masked (`hskey-api-<prefix>-***`)
- [ ] **⋯ → View Logs** for `headscale-admin`, `headscale` and `headplane`: the key appears in none of them
- [ ] `ls /var/lib/headscale` in the helper → `No such file or directory` (no database access)

### 9. First login

- [ ] `https://headplane.gorelkin.vip/admin` → paste the key → Machines page opens
- [ ] Log out, then try a wrong key: an error is shown and you are not signed in
- [ ] **DNS** page shows `vpn.gorelkin.vip`, read-only

### 10. Admin helper lifecycle

- [ ] **⋯ → Stop** on `headscale-admin` → *exited*. Opening a terminal now fails (no standing shell)
- [ ] **⋯ → Start** → *running*, and the terminal works again
- [ ] Optional: after one hour without action it shows *exited* (exit code 0)

### 11. Users, pre-auth keys and nodes

- [ ] **Users** → create `test-user`
- [ ] **Settings → Manage Auth Keys → Create pre-auth key**: `test-user`, reusable, 1 day

Disposable nodes, so your laptop's own Tailscale login isn't affected. On any machine with
Docker, run this twice (`ts-1`, `ts-2`):

```bash
docker run -d --name ts-1 \
  -e TS_AUTHKEY=<pre-auth key> \
  -e TS_EXTRA_ARGS=--login-server=https://headscale.gorelkin.vip \
  -e TS_USERSPACE=true -e TS_HOSTNAME=ts-1 -e TS_STATE_DIR=/var/lib/tailscale \
  tailscale/tailscale:v1.104.2
```

- [ ] Both online under **Machines**, owned by `test-user`
- [ ] `docker exec ts-1 tailscale ping ts-2` succeeds
- [ ] `docker exec ts-1 tailscale status --json | grep MagicDNSSuffix` → `vpn.gorelkin.vip`
- [ ] **Access Control**: save a policy (e.g. allow all). In the helper terminal, `headscale policy get` shows it

### 12. Restart and persistence

Baseline in the helper terminal: `headscale nodes list`, `headscale users list`.

- [ ] Dokploy **Restart** (or **Stop** then **Deploy**): all healthy, same nodes and users,
  still signed in to Headplane, test nodes reconnect without new keys
- [ ] Optional: reboot the host. Services come back (`headscale-admin` comes back only on the next deploy or Start)

### 13. Backup and restore (needs SSH)

Backups are taken on the host, because they stop containers and archive volumes:

```bash
./scripts/backup.sh <app> /root/hs-backup && cat /root/hs-backup/MANIFEST
```

- [ ] Three archives plus `MANIFEST`, and all containers healthy again

Restore drill (**only before real devices depend on the instance**), on the host:

```bash
docker stop $(docker ps -q -f label=com.docker.compose.project=<app> -f label=com.docker.compose.service=headplane) \
            $(docker ps -q -f label=com.docker.compose.project=<app> -f label=com.docker.compose.service=headscale)
VOL=$(docker volume ls -q -f label=com.docker.compose.project=<app> -f label=com.docker.compose.volume=headscale-data)
docker run --rm -v "$VOL:/data" alpine:3.22.2 sh -c 'find /data -mindepth 1 -delete'
./scripts/restore.sh <app> /root/hs-backup        # confirms, restores, starts both
```

- [ ] Same nodes and users after the restore; test nodes reconnect without new keys
- [ ] Delete `/root/hs-backup` afterwards, or move it somewhere encrypted. It contains private keys.

### 14. Clean up test nodes

`docker rm -f ts-1 ts-2`, then delete the two machines in Headplane. Keep the installation.

### Results

| Step | Result | Notes |
| --- | --- | --- |
| 1 Preconditions | | Dokploy version: |
| 4 Import preview | | |
| 6 Deploy healthy | | |
| 7 Routing / TLS | | |
| 8 Bootstrap in Dokploy UI | | Terminal opened? Key in any logs? |
| 9 First login | | |
| 10 Helper lifecycle | | |
| 11 Users / keys / nodes | | |
| 12 Restart / persistence | | |
| 13 Backup / restore | | |
