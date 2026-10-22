# Testing

There are two kinds of tests, and they prove different things.

| | Automated (no Dokploy) | Manual (live Dokploy) |
| --- | --- | --- |
| Where | Laptop or GitHub Actions | A real Dokploy instance |
| Proves | The template is well-formed, Dokploy's processor resolves it, both containers work together, Headplane manages users/keys, Tailscale nodes join, state survives upgrade/restart/backup/restore | Dokploy's import UI accepts it, Traefik routes both domains, Let's Encrypt issues certificates, real clients connect over the internet |
| Commands | `npm run validate`, `node tests/validate-negative.mjs`, `scripts/check-upstream.sh`, `npm run test:e2e` | This document |

## Automated tests

```bash
npm ci
npm run validate                    # static checks
node tests/validate-negative.mjs    # validator rejects 13 broken variants
npm run build:import && node scripts/validate.mjs --import dist/import-base64.txt
git clone --depth 1 https://github.com/Dokploy/templates /tmp/dokploy-templates
scripts/check-upstream.sh /tmp/dokploy-templates
npm run test:e2e                    # needs Docker and internet access, ~3 minutes
```

`tests/e2e-local.sh` deploys the stack on the previous release (Headscale 0.29.4, Headplane 0.7.1),
then upgrades to the pinned images. Along the way it checks health, authentication, user and
pre-auth key management through Headplane's own endpoints, two Tailscale nodes joining and
pinging each other, MagicDNS, ACL editing, restart, recreate, and backup → wipe → restore.
Run with `KEEP=1` to leave the stack running for inspection.

It does **not** cover Traefik, TLS, Let's Encrypt, Dokploy's UI, or clients outside the Docker
network. The manual test below covers those.

---

## Manual test on a live Dokploy instance

Written for the first test environment, but works for any instance after replacing the names:

| | Value |
| --- | --- |
| Dokploy | `https://dokploy.gorelkin.vip` |
| Headscale | `https://headscale-test.gorelkin.vip` |
| Headplane | `https://headplane-test.gorelkin.vip/admin` |
| MagicDNS | `*.vpn-test.gorelkin.vip` |

Record each result in the table at the end. Nothing here touches other services on the instance.

### 0. Preconditions

- [ ] SSH access to the Docker host that Dokploy deploys to (`ssh <host>`)
- [ ] Note the Dokploy version (shown in the Dokploy UI)
- [ ] Check whether another Headscale already runs on that host:

  ```bash
  docker ps --filter label=com.docker.compose.service=headscale \
    --format '{{.Label "com.docker.compose.project"}} {{.Image}}'
  ```

  If anything is listed, step 3 **must** enable *Isolated Deployment* (see
  [Security considerations](../README.md#security-considerations)).
- [ ] Note the server's public IPv4 (and IPv6, if any): `curl -4 ifconfig.me`

### 1. Build the import string

```bash
npm ci
npm run build:import -- \
  --base-domain gorelkin.vip \
  --headscale-host headscale-test.gorelkin.vip \
  --headplane-host headplane-test.gorelkin.vip \
  --magicdns-domain vpn-test.gorelkin.vip \
  --out dist/import-gorelkin-test.txt
node scripts/validate.mjs --import dist/import-gorelkin-test.txt
```

Expected: `validation passed`, and the import summary lists both `headscale-test.gorelkin.vip`
and `headplane-test.gorelkin.vip` with `https=true`.

### 2. DNS

Create these records (DNS only; on Cloudflare, use the grey cloud):

| Name | Type | Value |
| --- | --- | --- |
| `headscale-test.gorelkin.vip` | A (+ AAAA) | server IP |
| `headplane-test.gorelkin.vip` | A (+ AAAA) | server IP |

Do **not** create `vpn-test.gorelkin.vip`.

```bash
dig +short headscale-test.gorelkin.vip   # -> server IP, not a Cloudflare IP
dig +short headplane-test.gorelkin.vip
```

### 3. Import

1. Dokploy → new project `headscale-test` → **Create Service → Compose**, name `headscale-test`.
2. **Advanced → Enable Isolated Deployment**: enable it if step 0 found another Headscale.
   Recommended in any case.
3. **Advanced → Import** → paste `dist/import-gorelkin-test.txt`. Check the preview:
   - [ ] Domains: `headscale-test.gorelkin.vip` → `headscale:8080`, `headplane-test.gorelkin.vip` → `headplane:3000`
   - [ ] Environment variables: none
   - [ ] Mounts: `/etc/headscale/config.yaml`, `/etc/headplane/config.yaml`
   - [ ] The Headscale mount contains `server_url: https://headscale-test.gorelkin.vip` and `base_domain: vpn-test.gorelkin.vip`
   - [ ] The Headplane mount contains a 32-character `cookie_secret` (not a `${...}` placeholder)
4. Import. Then check **Domains**: both show HTTPS enabled and *Certificate Provider: None*.

### 4. HTTPS

For each domain: edit → **Certificate Provider: Let's Encrypt** → save.

### 5. Deploy

**Deploy**, and watch the deployment log until `Docker Compose Deployed`.

On the host:

```bash
APP=<App Name of the service>
docker ps --filter label=com.docker.compose.project=$APP --format '{{.Names}}  {{.Status}}  {{.Ports}}'
```

- [ ] Both containers `Up … (healthy)` within ~60 s
- [ ] The Ports column shows only `8080/tcp` and `3000/tcp`, with no `0.0.0.0:…->`
- [ ] `ls /etc/dokploy/compose/$APP/files/etc/headscale/ /etc/dokploy/compose/$APP/files/etc/headplane/` shows both `config.yaml` files

### 6. Routing and TLS

```bash
curl -fsS https://headscale-test.gorelkin.vip/health                    # {"status":"pass"}
curl -sI http://headscale-test.gorelkin.vip/health | head -1            # 301/308 redirect to https
curl -vsI https://headscale-test.gorelkin.vip/health 2>&1 | grep issuer # Let's Encrypt
curl -sI https://headplane-test.gorelkin.vip/admin/login | head -1      # HTTP/2 200
curl -sI https://headplane-test.gorelkin.vip/admin/machines | grep -i -E '^HTTP|^location'  # 302 -> /admin/login
for p in 8080 3000 9090 50443; do nc -z -w 3 dokploy.gorelkin.vip $p && echo "OPEN $p (unexpected)" || echo "closed $p"; done
```

Let's Encrypt can take a minute or two after the deploy. If the issuer is `TRAEFIK DEFAULT CERT`,
check DNS and port 80 (see [Troubleshooting](../README.md#troubleshooting)).

### 7. First login

```bash
./scripts/create-api-key.sh            # lists projects; confirm $APP
./scripts/create-api-key.sh $APP 7d
```

- [ ] `https://headplane-test.gorelkin.vip/admin` → paste key → Machines page opens
- [ ] Log out, then try a wrong key: an error is shown and you are not signed in
- [ ] **DNS** page shows `vpn-test.gorelkin.vip`, read-only

### 8. Users and pre-auth keys

- [ ] **Users** → create `test-user`
- [ ] **Settings → Manage Auth Keys → Create pre-auth key**: user `test-user`, reusable, 1 day.
  Copy the key.

### 9. Register Tailscale nodes

Use disposable nodes so an existing Tailscale login on your laptop is not affected. Any machine
with Docker works; run the command twice with different names to get two nodes:

```bash
docker run -d --name ts-test-1 \
  -e TS_AUTHKEY=<pre-auth key> \
  -e TS_EXTRA_ARGS=--login-server=https://headscale-test.gorelkin.vip \
  -e TS_USERSPACE=true -e TS_HOSTNAME=ts-test-1 -e TS_STATE_DIR=/var/lib/tailscale \
  tailscale/tailscale:v1.104.2
docker exec ts-test-1 tailscale status
```

- [ ] Both nodes appear online under **Machines**, owned by `test-user`
- [ ] `docker exec ts-test-1 tailscale ping ts-test-2` succeeds
- [ ] `docker exec ts-test-1 tailscale status --json | grep MagicDNSSuffix` → `vpn-test.gorelkin.vip`
- [ ] Optional, interactive flow: on a phone or laptop profile, use the custom server
  `https://headscale-test.gorelkin.vip`, then register the shown key via **Machines → Add Device →
  Register Machine Key**
- [ ] **Access Control**: save a policy (for example allow all); `headscale policy get` shows it

### 10. Restart and persistence

Record a baseline first:

```bash
HS=$(docker ps -q -f label=com.docker.compose.project=$APP -f label=com.docker.compose.service=headscale)
docker exec $HS headscale nodes list
docker run --rm -v ${APP}_headscale-data:/d:ro alpine:3.22.2 sha256sum /d/noise_private.key
```

(With *Isolated Deployment*, check the actual volume name with `docker volume ls | grep $APP`.)

- [ ] Dokploy **Restart**: both healthy again, same nodes, same Noise key hash, still signed in to Headplane
- [ ] Dokploy **Stop**, then **Deploy**: same checks
- [ ] Reboot the host (optional): containers come back by themselves (`restart: unless-stopped`)
- [ ] Nodes reconnect without re-authentication (`tailscale status` on the test nodes)

### 11. Updating container images

Optional: the end-to-end test already covers this upgrade path. To repeat it live, change the
images in the compose editor (**General**) to `headscale:0.29.4` / `headplane:0.7.1` *before the
first deploy in step 5*, and work through steps 6–10. Headplane 0.7.1 shows an error on
**Access Control** until a policy exists; that is fixed in 0.8.1. Then:

1. Run `./scripts/backup.sh $APP /root/hs-backup-pre-upgrade`.
2. Change the images back to `headscale:0.29.5` / `headplane:0.8.1` and **Deploy**.

- [ ] Both healthy; nodes, users and Noise key unchanged; Headplane login still works

### 12. Backup and restore

```bash
./scripts/backup.sh $APP /root/hs-backup-test
cat /root/hs-backup-test/MANIFEST
```

- [ ] `headscale-data.tar.gz`, `headplane-data.tar.gz`, `files.tar.gz`, `MANIFEST` present; containers healthy again

Simulate data loss (**test instance only**), then restore:

```bash
docker stop $(docker ps -q -f label=com.docker.compose.project=$APP)
docker run --rm -v ${APP}_headscale-data:/data alpine:3.22.2 sh -c 'find /data -mindepth 1 -delete'
docker start $(docker ps -aq -f label=com.docker.compose.project=$APP -f label=com.docker.compose.service=headscale)
docker exec $HS headscale nodes list     # empty: data is gone
./scripts/restore.sh $APP /root/hs-backup-test
```

- [ ] After the restore: same nodes, same Noise key hash, test nodes reconnect without new keys

### 13. Clean up

1. `docker rm -f ts-test-1 ts-test-2` on the machines running test nodes.
2. Dokploy → delete the `headscale-test` service, including its volumes.
3. Remove the two DNS records.
4. Delete `/root/hs-backup-test`. It contains private keys.

### Results

| Step | Result | Notes |
| --- | --- | --- |
| 0 Preconditions | | Dokploy version: |
| 3 Import preview | | |
| 5 Deploy healthy | | |
| 6 Routing / TLS | | |
| 7 Login | | |
| 8 Users / keys | | |
| 9 Nodes | | |
| 10 Restart / persistence | | |
| 11 Image update | | |
| 12 Backup / restore | | |
