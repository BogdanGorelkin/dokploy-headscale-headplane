# Headscale + Headplane for Dokploy

A [Dokploy](https://dokploy.com) template that deploys a self-hosted
[Tailscale](https://tailscale.com) control server, [Headscale](https://headscale.net),
together with its web administration UI, [Headplane](https://headplane.net), as one
Docker Compose service.

| Component | Version | Image |
| --- | --- | --- |
| Headscale | 0.29.5 | `docker.io/headscale/headscale:0.29.5` |
| Headplane | 0.8.1 | `ghcr.io/tale/headplane:0.8.1` |
| Dokploy | v0.30.x (import format verified against v0.30.8 source) | — |

After a deployment you have:

- `https://headscale.<your-domain>` — the control server your Tailscale clients log in to
- `https://headplane.<your-domain>/admin` — the web UI for users, machines, pre-auth keys and ACLs
- `*.vpn.<your-domain>` — MagicDNS names for your machines (resolved inside the tailnet, no DNS record needed)

> **Status:** Every step a script can test has been verified against real
> containers: deployment, login, managing users and keys through Headplane,
> Tailscale nodes joining, upgrades, restarts, and backup/restore (see
> [Testing](#testing)). A full run on a live Dokploy instance with
> Let's Encrypt is a manual step, documented in [docs/TESTING.md](docs/TESTING.md).

## Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [DNS setup](#dns-setup)
- [HTTPS certificates](#https-certificates)
- [Configuration and environment variables](#configuration-and-environment-variables)
- [First login to Headplane](#first-login-to-headplane)
- [Connecting Tailscale clients](#connecting-tailscale-clients)
- [Reusable pre-authentication keys](#reusable-pre-authentication-keys)
- [Security considerations](#security-considerations)
- [Backup and restore](#backup-and-restore)
- [Upgrading](#upgrading)
- [Troubleshooting](#troubleshooting)
- [Differences from the upstream Docker examples](#differences-from-the-upstream-docker-examples)
- [Testing](#testing)
- [Contributing](#contributing)

## Architecture

```
                         ┌──────────────── Dokploy host ────────────────────────────┐
 Tailscale clients ─443─▶│ Traefik ──▶ headscale:8080 ◀─── HTTP (Compose network) ─┐ │
                         │   │          /var/lib/headscale  (volume headscale-data) │ │
 Browser ───────────443─▶│   └───────▶ headplane:3000 ─────────────────────────────┘ │
                         │              /var/lib/headplane  (volume headplane-data)  │
                         └───────────────────────────────────────────────────────────┘
 Peer-to-peer WireGuard traffic flows directly between clients, or via Tailscale's public DERP relays.
```

- **Two services, one Compose project.** Each has its own named volume and health check,
  and restarts automatically.
- **No published host ports.** Dokploy's Traefik terminates TLS and routes the two domains.
  Headscale's metrics (`:9090`) and gRPC (`:50443`) listen only on the container's loopback.
- **Headplane talks to Headscale over the internal Compose network** (`http://headscale:8080`).
- **Configuration lives in two Dokploy file mounts:** `/etc/headscale/config.yaml` and
  `/etc/headplane/config.yaml`. Dokploy generates both from the template at import time.
  Headplane reads the Headscale config **read-only**, so it can display it but never change it.
- **No Docker socket, no agent, no privileged mode.** Both containers run with a read-only
  root filesystem, `cap_drop: ALL` and `no-new-privileges`.

## Prerequisites

- A Dokploy instance with its Traefik reachable from the internet on **TCP 80 and 443**.
  Port 80 is needed for Let's Encrypt HTTP-01 validation.
- A domain whose DNS you control, or nothing at all if you use the generated `sslip.io` hosts.
- **SSH access to the Docker host** for one command during the first login. The Headscale image is
  distroless, so Dokploy's web terminal can't run its CLI.
- Optional, to build an import for your own domain: Node.js ≥ 20, plus this repository.

## Quick start

### 1. Generate the import string

Dokploy imports templates as a Base64 string and has **no input prompt**. It resolves every
variable on the server as soon as you import. To use your own domain, bake it into the string first:

```bash
git clone <this repository> && cd <repository>
npm ci
npm run build:import -- --base-domain example.com
# -> dist/import-base64.txt
#    Headscale  https://headscale.example.com
#    Headplane  https://headplane.example.com/admin
#    MagicDNS   *.vpn.example.com
```

Each host name can be overridden on its own:

```bash
npm run build:import -- --base-domain example.com \
  --headscale-host headscale-test.example.com \
  --headplane-host headplane-test.example.com \
  --magicdns-domain vpn-test.example.com
```

Without `--base-domain`, the import keeps the template default `${domain}`. Dokploy then generates
`headscale.<app>-<hash>-<server-ip>.sslip.io` (and the same for `headplane.` and `vpn.`).
These names resolve to your server with no DNS setup at all, which is useful for a quick trial.
The same generic string is attached to each [GitHub release](../../releases) and uploaded as a
CI artifact.

The string contains **no secrets**. Dokploy generates Headplane's cookie secret
(`${hash:32}`, 32 hex characters from `crypto.randomBytes`) on the server during the import.

### 2. Create DNS records

See [DNS setup](#dns-setup). Do this before enabling Let's Encrypt.

### 3. Import into Dokploy

1. In a project, create a new **Compose** service (type *Docker Compose*). Use a fresh service:
   importing into an existing one replaces its compose file, mounts and domains.
2. Open the service → **Advanced** → **Import**, paste the string and load the preview.
   It should show:
   - **Domains:** `headscale` → port `8080` and `headplane` → port `3000`
   - **Environment variables:** none. Every setting lives in the mounted config files.
   - **Mounts:** `/etc/headscale/config.yaml` and `/etc/headplane/config.yaml`
   - **Compose:** services `headscale` and `headplane`, volumes `headscale-data` and `headplane-data`
3. Confirm the import.

### 4. Enable HTTPS on both domains

Dokploy creates imported domains with **HTTPS on** but **Certificate Provider: None**. It always
sets that provider on import, whatever the template says. For each of the two domains:
**Domains** → edit → **Certificate Provider: Let's Encrypt** → save.
See [HTTPS certificates](#https-certificates).

### 5. Deploy

Click **Deploy**. Headplane waits until Headscale reports healthy. Both containers should show
*healthy* within about 30 seconds. Then:

```bash
curl -fsS https://headscale.example.com/health      # {"status":"pass"}
```

### 6. Sign in to Headplane

Follow [First login to Headplane](#first-login-to-headplane).

## DNS setup

Dokploy does **not** create DNS records. At your DNS provider, create:

| Name | Type | Value | Notes |
| --- | --- | --- | --- |
| `headscale.example.com` | A (and AAAA if you have IPv6) | server IP | **DNS only.** Must not be proxied (see below) |
| `headplane.example.com` | A (and AAAA) | server IP | Plain DNS recommended |
| `vpn.example.com` | — | — | **No record.** The MagicDNS suffix is resolved inside the tailnet |

**Cloudflare users:** the Headscale record must be *DNS only* (grey cloud). Cloudflare's proxy and
Cloudflare Tunnel can't carry the Tailscale control protocol, a WebSocket upgrade over `POST`
([Headscale docs](https://headscale.net/stable/ref/integration/reverse-proxy/#cloudflare)).
Cloudflare *Origin* certificates are not publicly trusted either, so Tailscale clients reject them.

Check propagation before requesting certificates:

```bash
dig +short headscale.example.com
dig +short headplane.example.com
```

## HTTPS certificates

TLS is terminated by Dokploy's Traefik. With **Certificate Provider: Let's Encrypt**, Traefik
requests certificates with the HTTP-01 challenge. That needs:

- The DNS records above pointing at the Dokploy server
- TCP 80 reachable from the internet, with nothing else answering on it
- A redeploy after changing domain settings (Dokploy reminds you of this for Compose services)

While Let's Encrypt is pending or failing, Traefik serves its self-signed default certificate.
Browsers then warn, Tailscale clients refuse to connect, and Headplane login fails because its
cookie is `Secure`. If Traefik already holds a valid certificate for these hosts (for example a
wildcard certificate added in Dokploy), *Certificate Provider: None* works as well.

Check the certificate:

```bash
curl -vI https://headscale.example.com/health 2>&1 | grep -E "subject:|issuer:|HTTP/"
```

## Configuration and environment variables

The template defines these variables. Dokploy resolves them once, at import time:

| Variable | Default | Used for |
| --- | --- | --- |
| `base_domain` | `${domain}` (generated `sslip.io` host) | Base of all host names. Set with `--base-domain` |
| `headscale_host` | `headscale.${base_domain}` | Headscale domain, `server_url`, Headplane `public_url` |
| `headplane_host` | `headplane.${base_domain}` | Headplane domain and `base_url` |
| `magicdns_domain` | `vpn.${base_domain}` | `dns.base_domain` (MagicDNS suffix). Must not equal, or be a parent of, the Headscale host |
| `headplane_cookie_secret` | `${hash:32}` | Headplane session encryption. Exactly 32 characters |

**No container environment variables are required.** Every setting is written into the two
mounted files. You can change them after import under **Advanced → Mounts**, then redeploy:

- `/etc/headscale/config.yaml`: the full [Headscale 0.29.5 configuration](https://github.com/juanfont/headscale/blob/v0.29.5/config-example.yaml)
- `/etc/headplane/config.yaml`: the [Headplane 0.8.1 configuration](https://github.com/tale/headplane/blob/v0.8.1/config.example.yaml)

Notable defaults:

- `policy.mode: database`. ACLs are stored in Headscale's database and edited in Headplane
  (**Access Control**). Until you save a policy, **all nodes can reach each other**.
- DERP: Tailscale's public relays. The embedded DERP server would need UDP/3478 published on
  the host, which this template doesn't do.
- DNS: MagicDNS on, global resolvers 1.1.1.1/1.0.0.1, `override_local_dns: true`.
- `trusted_proxies`: the RFC 1918 ranges, so Headscale logs real client IPs from Traefik's
  forwarded headers.

Both containers also honour environment overrides: `HEADSCALE_<KEY>` with `.` written as `_`,
for example `HEADSCALE_LOG_LEVEL=debug`, and `HEADPLANE_<SECTION>__<KEY>`, for example
`HEADPLANE_DEBUG=true`. Values set in the files are generally easier to keep track of.

**Changing the domain after import:** update `server_url` and `dns.base_domain` in the Headscale
mount, `base_url` and `public_url` in the Headplane mount, and the two domains, then redeploy.
Changing `server_url` on a running tailnet means every client has to log in again with the new
`--login-server`.

## First login to Headplane

Headplane signs you in with a **Headscale API key**. This template has no automatic bootstrap,
for the reasons below. You create one key, once, on the Docker host:

1. Find the service's **App Name** in Dokploy. It is also the Compose project name, and running
   `./scripts/create-api-key.sh` with no arguments lists every Headscale project on the host.
2. Over SSH on the Docker host:

   ```bash
   # from a checkout of this repository (or copy scripts/create-api-key.sh to the host)
   ./scripts/create-api-key.sh <app-name> 90d

   # equivalent without the script:
   docker exec "$(docker ps -q -f label=com.docker.compose.project=<app-name> \
                               -f label=com.docker.compose.service=headscale)" \
     headscale apikeys create --expiration 90d
   ```

3. Open `https://headplane.example.com/admin` and paste the key.
   (`https://headplane.example.com/` without `/admin` returns 404 by design.)

A session lasts at most 24 hours (`cookie_max_age`) and never longer than the key remains valid.
To rotate keys, run `headscale apikeys list` and `headscale apikeys expire --prefix <prefix>`
through `docker exec` as above.

**Why there is no automatic bootstrap:** an API key is a full-admin credential for Headscale,
and Headscale's API is reachable on its public domain. Doing this without SSH would mean writing
the key to container logs or environment variables, which other Dokploy users and log shippers
can read. The only key-less alternative is Headplane's proxy authentication. It trusts identity
headers from every container on Dokploy's shared network, so it is unsafe on a shared host.
Mounting the Docker socket into Headplane to save this one step would hand it root on the host.

**Optional single sign-on:** Headplane supports OIDC (`oidc:` section, see the
[SSO docs](https://headplane.net/features/sso)). OIDC also needs `headscale.api_key` in the
Headplane config, using a key created as above. Dokploy can additionally put a forward-auth
provider in front of the Headplane domain (domain → **SSO Authentication**).

## Connecting Tailscale clients

Install the official [Tailscale client](https://tailscale.com/download) and point it at your server.

**Linux / macOS (CLI):**

```bash
# with a pre-auth key (no browser step)
sudo tailscale up --login-server https://headscale.example.com --authkey <pre-auth-key>

# or interactively: prints a URL with a registration key
sudo tailscale up --login-server https://headscale.example.com
```

For the interactive flow, register the device in Headplane. Go to **Machines → Add Device →
Register Machine Key**, paste the URL or `hskey-authreq-…` key it printed, and choose the owner.

**Windows, macOS app, iOS, Android:** set a custom control server URL
(`https://headscale.example.com`) in the client's settings or login options, following
[Headscale's client documentation](https://headscale.net/stable/usage/getting-started/).

After joining, `tailscale status` lists your peers, and `ping <hostname>.vpn.example.com` uses MagicDNS.

## Reusable pre-authentication keys

In Headplane: **Users** → create a user. Then **Settings → Manage Auth Keys → Create pre-auth key**
(also reachable from **Machines → Add Device → Generate Pre-auth Key**):

- **User:** the owner of the machines that join with the key
- **Reusable:** on, to enrol several machines with one key (servers, CI runners)
- **Ephemeral:** on for short-lived machines. They are removed after being offline for 30 minutes
- **Expiration:** keep it short and create new keys rather than long-lived ones

Copy the key straight away; it is shown only once. The CLI equivalent is
`headscale preauthkeys create --user <user-id> --reusable --expiration 24h`, run via `docker exec`.
A reusable key enrols any number of machines until it expires, so treat it like a password and
expire it in Headplane once you no longer need it.

## Security considerations

- **Headplane access requires a valid, unexpired Headscale API key.** Unauthenticated requests
  are redirected to the login page. Anyone holding an API key has full control of the tailnet.
- **Headscale's REST API (`/api/v1`) is reachable on the public Headscale domain**, as in every
  standard Headscale deployment. It accepts only API keys. Keep keys short-lived and expire unused ones.
- **Default policy allows all traffic between nodes.** Write an ACL policy in Headplane
  (**Access Control**) before adding devices that should not reach each other.
- **Secrets live in Dokploy.** The cookie secret sits in the Headplane mount, which Dokploy stores
  in its database and writes to `/etc/dokploy/compose/<app>/files/` on the host. Anyone with access
  to the Dokploy project can read it.
- **Shared `dokploy-network`:** Dokploy attaches every service with a domain to one shared network.
  If another stack on the same host also has a service named `headscale` with a domain, the name
  `headscale` can resolve to the wrong container. To isolate the stack, turn on
  **Advanced → Enable Isolated Deployment** before deploying.
- **Container hardening:** read-only root filesystems, `cap_drop: ALL`, `no-new-privileges`, no
  host ports, no Docker socket, metrics and gRPC on loopback only.
- **`trusted_proxies`** trusts the private address ranges because Traefik reaches Headscale from
  Docker networks. A container on those networks could therefore fake the client IP that
  Headscale logs. It cannot affect authentication.
- Headscale's `/health` endpoint is public, which is normal and harmless.

## Backup and restore

What matters:

| Volume | Contents | If lost |
| --- | --- | --- |
| `headscale-data` | `db.sqlite` (+ WAL), `noise_private.key` | All users, nodes and keys are gone. A new Noise key forces every client to re-register |
| `headplane-data` | Headplane database (sessions, roles) | Users sign in again |
| Dokploy mounts | Both config files (including the cookie secret) | Re-import or rewrite them |

`scripts/backup.sh` stops both containers briefly, so SQLite and its WAL are copied in a
consistent state. It then archives both volumes and the Dokploy mount files and starts the
containers again. Run it on the Docker host:

```bash
./scripts/backup.sh <app-name> /root/backups/headscale-$(date +%F)
# headscale-data.tar.gz  headplane-data.tar.gz  files.tar.gz  MANIFEST (images + SHA-256)
```

Restore into a deployment that has been deployed at least once, so its volumes exist:

```bash
./scripts/restore.sh <app-name> /root/backups/headscale-2026-10-22      # asks for confirmation
```

`restore.sh` replaces both volumes and leaves the Dokploy mounts alone. If you changed them,
compare with `files.tar.gz` and re-apply your edits under **Advanced → Mounts**. The backup holds
private keys: store it encrypted. Dokploy's own *Volume Backups* feature can also back up the two
named volumes to S3. If you use it, stop the services during the backup for a consistent SQLite copy.

## Upgrading

1. Read the release notes for [Headscale](https://github.com/juanfont/headscale/releases) and
   [Headplane](https://github.com/tale/headplane/releases). Headscale must be upgraded **one minor
   version at a time** (0.28 → 0.29 → 0.30), always to the latest patch release.
   Check [Headplane's compatibility](https://headplane.net) with the new Headscale version.
2. Back up (`scripts/backup.sh`).
3. In Dokploy, edit the image tags in the service's compose file (**General**), compare your
   config mounts with the new upstream example configs, and **Deploy**.
4. Check that both containers are healthy and that `headscale nodes list` shows your machines.

Re-importing a newer version of this template also works, but it **replaces the mounts and
domains**: your config edits are lost, a new cookie secret is generated (everyone signs in
again), and the certificate providers reset to *None*. Volumes are kept.

This repository pins exact versions. Floating tags such as `latest` or `0.8` are rejected by CI.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Headplane login does nothing or returns to the login page | Headplane is served over HTTP or with an untrusted certificate. The `Secure` cookie is then dropped. Enable HTTPS and Let's Encrypt on the domain and redeploy |
| Browser shows "TRAEFIK DEFAULT CERT" | Let's Encrypt hasn't issued yet: check DNS, port 80 reachability, *Certificate Provider* setting, Traefik logs |
| `tailscale up` hangs or reports TLS errors | Same as above, or the Headscale record is proxied by Cloudflare. Switch it to DNS only |
| Headplane container restarts with "Unable to load configuration" | Invalid Headplane mount. Every key listed in the log message must exist with the right type. `cookie_secret` must be exactly 32 characters |
| Headscale unhealthy and Headplane never starts | `docker logs <headscale container>`. Usually a config error. Validate with `docker run --rm -v <file>:/etc/headscale/config.yaml:ro docker.io/headscale/headscale:0.29.5 configtest` |
| Error `is a directory` for `/etc/.../config.yaml` | The mount file didn't exist at deploy time, so Docker created a directory. Re-create the mount under **Advanced → Mounts** and redeploy |
| `https://headplane…/` shows 404 | Expected. Use `/admin` |
| DNS page in Headplane is read-only | By design: the Headscale config is mounted read-only. Edit the Headscale mount in Dokploy and redeploy |
| Headplane reports the wrong Headscale version or odd data | Possible name collision on `dokploy-network`. Enable *Isolated Deployment* |
| `headscale` CLI unavailable in Dokploy's terminal | The image is distroless. Use `docker exec` over SSH, or the `-debug` image tag temporarily |

Useful commands, run on the host:

```bash
P=<app-name>
docker ps --filter label=com.docker.compose.project=$P
docker logs $(docker ps -q -f label=com.docker.compose.project=$P -f label=com.docker.compose.service=headscale)
docker exec $(docker ps -q -f label=com.docker.compose.project=$P -f label=com.docker.compose.service=headscale) headscale nodes list
```

## Differences from the upstream Docker examples

| Topic | Headscale / Headplane docs | This template | Why |
| --- | --- | --- | --- |
| Ports | `ports: 8080, 9090, 3000` | `expose` only | Traefik routes the traffic. Dokploy templates must not publish ports |
| Images | `<VERSION>` / `headplane:latest` | Exact pinned tags | Reproducible deployments. Headplane 0.8.0 broke actions behind TLS proxies |
| `container_name` | `headscale`, `headplane` | none | Dokploy names containers. Fixed names would collide |
| Headplane ↔ Headscale | Shared writable config, Docker socket, container label | Read-only config, no socket, no label | No root-equivalent access. The UI can't edit the Headscale config |
| DNS and settings editing in Headplane | Available (with socket) | Read-only display | Consequence of the above. Edit the mount in Dokploy |
| ACL editing | Policy file or database | `policy.mode: database` | Full ACL editing in Headplane without file access |
| Health checks | Optional | Both services, with `depends_on: service_healthy` | Ordered start-up and visible health in Dokploy |
| Hardening | `read_only` (Headscale) | `read_only`, `cap_drop: ALL` and `no-new-privileges` on both | Tested to work in the end-to-end test |
| Reverse proxy | Same host, Headplane on `/admin`, CORS middleware | Separate host per service | Dokploy routes one service per domain. Headplane calls the API from its server, so no CORS is needed |
| Embedded DERP | Optional | Disabled | Would need UDP/3478 published on the host |

## Testing

| Layer | Command | Needs | What it covers |
| --- | --- | --- | --- |
| Static | `npm run validate` | Node | YAML/TOML/meta, Dokploy conventions, variable references, unresolved placeholders, generated configs, secrets, import round-trip |
| Static | `node tests/validate-negative.mjs` | Node | 13 deliberately broken templates must be rejected |
| Upstream | `scripts/check-upstream.sh <Dokploy/templates checkout>` | Node | The official Dokploy/templates validators |
| End-to-end | `npm run test:e2e` | Docker | Real containers: deploy, health, login, users/keys via Headplane, 2 Tailscale nodes, upgrade, restart, recreate, backup/restore (52 checks) |
| Live Dokploy | [docs/TESTING.md](docs/TESTING.md) | A Dokploy instance | Import preview, Traefik routing, Let's Encrypt, real clients |

The end-to-end test runs without Dokploy and Traefik. It renders the template through a faithful
port of Dokploy's template processor ([scripts/lib/dokploy.mjs](scripts/lib/dokploy.mjs)) and
sends the headers Traefik would. CI runs every automated layer on each push and pull request.
Tagged releases attach the generic import string.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development
workflow, the version-bump checklist and how this blueprint is submitted to
[Dokploy/templates](https://github.com/Dokploy/templates).
