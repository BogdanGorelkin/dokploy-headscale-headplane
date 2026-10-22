# HABS: catalog trial and migration runbook

**Scope.** HABS (`dokploy.habs.ai`) currently runs a manually deployed Headscale 0.29.5 at
`https://headscale.habs.ai`, with one registered MacBook owned by user `bogdan`. This runbook:

- **Phase A**: installs this template from Dokploy's Templates catalog on *temporary* subdomains,
  next to the untouched production deployment, to validate the end-user installation.
- **Phase B**: replaces the manual deployment with the template while keeping Headscale's
  state and client identities, with a tested rollback.

Nothing here is automated, and nothing touches the production deployment until Phase B's
maintenance window. Each step lists what to check before moving on.

> **Status:** Phase B is a draft, to be finalised after Phase A has passed and after the
> production deployment has been inspected (step B1). The data path itself (restoring only
> `headscale-data` into a fresh template deployment, with clients reconnecting without
> re-registration) is exercised by the end-to-end test.

---

## Phase A: catalog installation on temporary subdomains

Example names below; any unused names work:

| | Trial value |
| --- | --- |
| Headscale | `headscale-trial.habs.ai` |
| Headplane | `headplane-trial.habs.ai` |
| MagicDNS | `vpn-trial.habs.ai` (no DNS record) |

### A0. Choose how Dokploy reaches the catalog

Dokploy's Templates page has a **Base URL** field. Dokploy's server fetches `<base>/meta.json`
and `<base>/blueprints/<id>/{template.toml,docker-compose.yml,logo.svg}`; the browser only
loads the logo.

| Option | Extra infrastructure | Notes |
| --- | --- | --- |
| **This repository via raw GitHub** (recommended) | None | The repository must be **public**. Pin the Base URL to a tag or commit (`…/dokploy-headscale-headplane/<sha>`) so it can't change under you. Raw GitHub caches for about 5 minutes |
| Official Dokploy/templates PR preview | None for us; their Cloudflare Pages build | Requires opening the upstream PR first. Workflows from a first-time contributor's fork may wait for maintainer approval; their rules ask for tested PRs |
| Own static hosting (GitHub Pages, any web server) | A site to maintain | Only needed if the repository must stay private |

Recommendation: make the repository public when ready, and use raw GitHub pinned to a commit.
Verify the URL before using it in Dokploy:

```bash
node scripts/check-catalog.mjs --base-url https://raw.githubusercontent.com/BogdanGorelkin/dokploy-headscale-headplane/<sha>
# ... catalog OK
```

### A1. Preflight

- [ ] Production is healthy: `curl -fsS https://headscale.habs.ai/health`
- [ ] Note production's Dokploy service and its App Name (needed for B1)
- [ ] Production has a service named `headscale` with a domain, so it's on `dokploy-network`.
  **The trial must use Isolated Deployment** (A3), or its Headplane could reach the production
  Headscale.
- [ ] DNS (DNS only, grey cloud): `headscale-trial.habs.ai` and `headplane-trial.habs.ai` → the
  HABS server IP. Check with `dig +short`.

### A2. Install from the catalog

1. HABS Dokploy → new project `headscale-trial` → **Create Service → Template**.
2. **Base URL** → the pinned raw GitHub URL. The list shows *Headscale + Headplane* with its logo.
3. **Create.** Dokploy creates the service with generated `*.sslip.io` hosts and **does not
   deploy**.

- [ ] Environment shows `HEADSCALE_HOST`, `HEADPLANE_HOST`, `MAGICDNS_DOMAIN`,
  `HEADPLANE_COOKIE_SECRET` (32 hex)
- [ ] Domains: `headscale` :8080 and `headplane` :3000 path `/admin/`, both HTTPS
- [ ] Mounts: `/templates/headscale.yaml`, `/templates/headplane.yaml`

### A3. Configure (before the first deploy)

1. **Advanced → Enable Isolated Deployment.**
2. **Environment:** `HEADSCALE_HOST=headscale-trial.habs.ai`,
   `HEADPLANE_HOST=headplane-trial.habs.ai`, `MAGICDNS_DOMAIN=vpn-trial.habs.ai`.
3. **Domains:** set the same two hosts.
   - Headscale: **Let's Encrypt**. The Cloudflare *Origin* wildcard isn't trusted by Tailscale
     clients.
   - Headplane: **Let's Encrypt** with a DNS-only record, or *None* if the record is proxied by
     Cloudflare and the Origin wildcard is loaded in Traefik.

### A4. Deploy and bootstrap without SSH

- [ ] **Deploy** succeeds. In **Containers**, `headscale-config` exited (0), and the other three
  are healthy.
- [ ] `curl -fsS https://headscale-trial.habs.ai/health` → `{"status":"pass"}`; the issuer is Let's Encrypt
- [ ] `curl -sI https://headplane-trial.habs.ai/` → `302`, `location: https://headplane-trial.habs.ai/admin/`
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://headplane-trial.habs.ai/xmlrpc.php` → `404`
- [ ] **Containers → headscale-admin → Terminal → /bin/sh**:
  `headscale apikeys create --expiration 1d` prints a key. No SSH used.
- [ ] Sign in at `https://headplane-trial.habs.ai/admin/`; Users and Machines pages work
- [ ] Production unaffected: `curl -fsS https://headscale.habs.ai/health`, and the MacBook is still connected to production

### A5. Exercise and remove the trial

- [ ] Create a user and a pre-auth key in Headplane, and register a disposable node (a Docker
  container, see [TESTING.md §11](TESTING.md)). **Don't** move the MacBook.
- [ ] Change `MAGICDNS_DOMAIN` in the Environment → Deploy → the node gets the new suffix
- [ ] Afterwards: delete the trial service *with volumes*, and remove the two trial DNS records

**Exit criterion for Phase B:** A2–A5 pass, the results are recorded, and any template fixes
are released.

---

## Phase B: replace the production deployment (draft)

### Principles

- **Identity = `server_url` + Noise private key + database.** The new deployment must use
  `server_url: https://headscale.habs.ai` and the existing `noise_private.key` and `db.sqlite`.
  It must never start with `headscale.habs.ai` on a fresh key or database while clients are
  pointed at it.
- **Never two writers.** The old and new Headscale never share a database. The old one is
  stopped before its data is copied; the copy is restored into the new one; the old volume is
  never modified (it's the rollback).
- **Never two routes.** At any time exactly one Dokploy service has a domain for
  `headscale.habs.ai`.
- **Rollback = the old service, untouched,** started again with its domain.

### B1. Inspect production (read-only, any time)

Over SSH on the HABS host:

```bash
OLD=<production container name or ID>   # docker ps --filter ancestor=headscale/headscale:0.29.5
docker inspect "$OLD" --format '{{.Config.Image}}'
docker inspect "$OLD" --format '{{range .Mounts}}{{.Type}} {{.Name}}{{.Source}} -> {{.Destination}} rw={{.RW}}{{"\n"}}{{end}}'
docker inspect "$OLD" --format '{{.Config.Cmd}} {{.Config.Entrypoint}}'
```

The image is distroless (no `cat`), so copy the config out instead:

```bash
docker cp "$OLD":/etc/headscale/config.yaml ./habs-config.yaml   # adjust if the -c path differs
grep -nE '^(server_url|listen_addr|prefixes|database|noise|policy|dns|derp|oidc)|base_domain|path:|private_key_path|mode:' habs-config.yaml
```

Record:

| Item | Production value | Template default | Action if different |
| --- | --- | --- | --- |
| Image | 0.29.5? | 0.29.5 | Must match (no version change during the migration) |
| Data mount | volume or bind path → `/var/lib/headscale`? | volume `headscale-data` → `/var/lib/headscale` | Copy from wherever it is |
| `database.sqlite.path` | | `/var/lib/headscale/db.sqlite` | If different, adjust the template or place the file accordingly |
| `noise.private_key_path` | | `/var/lib/headscale/noise_private.key` | Same |
| `prefixes.v4/v6`, `allocation` | | `100.64.0.0/10`, `fd7a:115c:a1e0::/48`, sequential | Copy into the template if different |
| `dns.base_domain` | | `MAGICDNS_DOMAIN` | Set `MAGICDNS_DOMAIN` to the production value (MagicDNS names stay the same) |
| `dns.*` (nameservers, split, extra records) | | template defaults | Copy into the template |
| `policy.mode` (+ `path`) | | `database` | If `file`: after the restore, load it with `headscale policy set -f <file>` in the admin shell |
| `derp.server.enabled` | | `false` | If `true`, also copy `derp_server_private.key`, and decide whether to keep the embedded DERP (it needs UDP/3478 published, which this template doesn't do) |
| `oidc` | | none | Copy into the template if used |
| Domain certificate | Let's Encrypt for `headscale.habs.ai` | Let's Encrypt | Same |

Also note `headscale nodes list` and `headscale users list` (output via `docker exec "$OLD" headscale …`).

### B2. Prepare the new deployment (production keeps running)

1. Install from the catalog (A2) into a new project, for example `headscale`.
2. Configure as in A3, with **Isolated Deployment**, but keep the **generated sslip.io hosts**
   for now. Copy into the Environment and templates every difference found in B1.
   `MAGICDNS_DOMAIN` = production's `dns.base_domain`.
3. **Deploy** once (this creates the volumes), check health, then **Stop** the service.

### B3. Rehearsal (production keeps running)

Take a live copy of production's data to rehearse the restore. A copy taken while it runs may
be inconsistent; that's fine for a rehearsal, never for the cutover.

```bash
mkdir -p /root/habs-rehearsal
docker run --rm --volumes-from "$OLD":ro -v /root/habs-rehearsal:/backup alpine:3.22.2 \
  tar -czf /backup/headscale-data.tar.gz -C /var/lib/headscale .
./scripts/restore.sh <new-app-name> /root/habs-rehearsal       # restores headscale-data only
```

Start the new service (sslip hosts). In the admin shell: `headscale nodes list` shows the
MacBook and `headscale users list` shows `bogdan`. Sign in to its Headplane with a key created
in the admin shell. Then **Stop** it again. The MacBook is still on production and unaffected.

### B4. Cutover (maintenance window, about 15 minutes of control-plane downtime)

Existing tailnet connections keep working while the control plane is down. New logins and key
or ACL changes wait.

1. **Freeze:** announce the window; no Headscale changes from now on.
2. **Stop production:** Dokploy → old service → **Stop**. Confirm with
   `docker ps --filter id=$OLD` (nothing running).
3. **Consistent final copy** (the old volume is only read):

   ```bash
   mkdir -p /root/habs-cutover
   docker run --rm --volumes-from "$OLD":ro -v /root/habs-cutover:/backup alpine:3.22.2 \
     tar -czf /backup/headscale-data.tar.gz -C /var/lib/headscale .
   tar -tzf /root/habs-cutover/headscale-data.tar.gz | grep -E 'db.sqlite|noise_private.key'
   sha256sum /root/habs-cutover/headscale-data.tar.gz > /root/habs-cutover/SHA256
   ```

4. **Release the hostname:** old service → **Domains** → delete (or edit away)
   `headscale.habs.ai`. Note its settings for rollback. Keep the service and its volumes.
5. **Restore into the new service:** `./scripts/restore.sh <new-app-name> /root/habs-cutover`
6. **Point the new service at production names:** Environment
   `HEADSCALE_HOST=headscale.habs.ai`, `HEADPLANE_HOST=headplane.habs.ai`; **Domains** → same hosts
   (Headscale: Let's Encrypt; the existing certificate in Traefik's store is reused).
7. **Deploy.**

### B5. Validate (go / no-go)

- [ ] `curl -fsS https://headscale.habs.ai/health` → pass; the issuer is Let's Encrypt
- [ ] Admin shell: `headscale nodes list` shows the MacBook (`bogdan`); `headscale users list` matches B1
- [ ] On the MacBook: `tailscale status` shows *Running* without a re-login prompt. In Headplane,
  the MacBook is *online* and its *Last seen* advances
- [ ] `tailscale ping` between the MacBook and another node works; MagicDNS names unchanged
- [ ] `https://headplane.habs.ai/admin/` login works; the ACL page shows the expected policy
- [ ] Admin shell: `headscale apikeys list` shows production's keys (they were migrated)

Go → B6. Any failure that can't be fixed within the window → **Rollback**.

### Rollback

1. New service → **Stop**; remove its `headscale.habs.ai` domain (keep its volumes for analysis).
2. Old service → re-add the `headscale.habs.ai` domain exactly as noted in B4.4 → **Deploy/Start**.
3. Check: `curl -fsS https://headscale.habs.ai/health`; the MacBook is online again.

The old volume was never written to, so production returns to its pre-window state. Anything
done on the new instance after the cutover (new nodes, keys) is lost and must be redone.
Rehearse this rollback at the end of B3 by starting the old service again; it never stopped
during B3.

### B6. After a successful cutover

- Keep the old service **stopped** (not deleted) and `/root/habs-cutover` for at least a week.
- Run `./scripts/backup.sh <new-app-name> /root/backups/headscale-$(date +%F)` and store it encrypted.
- Then delete the old service and its volumes, and the cutover archive (it contains private keys).
