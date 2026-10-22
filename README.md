# Headscale + Headplane — Dokploy template prototype

Status: **prototype, not yet deployed or tested against a live Dokploy instance**.

## Included
- Headscale `0.29.5`, separate persistent volume, generated config.
- Headplane (`latest`, should be pinned after compatibility testing), separate volume/config.
- Two Dokploy-managed domains and generated env variables.
- No published container ports and no Docker socket mount.
- `import-base64.txt` for Dokploy Compose → Advanced → Import.

## Before first deployment
1. Create an entirely NEW Dokploy Compose service (do not import over an existing production Headscale; this would create a separate database and tailnet).
2. Set `base_domain` in `template.toml` to your DNS zone before generating/importing Base64. The provided Base64 includes `example.com`; **change this in Dokploy before deploying**. For `habs.ai`, resulting hosts: `headscale.habs.ai`, `headplane.habs.ai`. Do **not** deploy with these names on brainzilla since headscale.habs.ai already exists.
3. Create DNS-only A/AAAA records for both domain names pointing to the deployment server. Dokploy template does not provision public DNS automatically.
4. Configure publicly trusted TLS certs for BOTH hostnames. Dokploy may use Let's Encrypt if configured. If a Cloudflare Origin wildcard takes precedence (as on brainzilla), a separate public certificate is required; template does not bypass this condition.
5. Use HTTPS and secure access to Headplane. An admin API key is highly privileged.
6. In Dokploy Domains verify HTTPS, the service target and service port for both routes.

## First login
- `https://headplane.<domain>/admin` is the UI path.
- Generate a Headscale API key from Docker on the server (adapt container name):

  `sudo docker ps --format '{{.Names}}' | grep headscale`

  `sudo docker exec <HEADSCALE_CONTAINER> headscale apikeys create --expiration 90d`

- Use the key to sign in. Store it securely, rotate it, do not log/share it publicly.
- Create user(s), short-lived preauth key(s), and register devices.

## Limits of v0.1
- Does not automatically configure Cloudflare DNS, DNS-01, a TLS certificate or renewal hooks.
- Does not bootstrap the first Headscale API key or user automatically.
- Headplane integration is intentionally restricted: no writable Headscale config, no docker.sock, no agent; Docker-dependent UI settings may be unavailable.
- When Headplane UI and Headscale run on separate origins, advanced browser operations may require explicit CORS configuration on the Headscale Traefik router. Refer to Headplane reverse proxy documentation and add only allowed origin `https://headplane.<domain>`.
- `headplane:latest` needs an immutable tested version or digest before production release.
- Configuration is a minimal v0.29.5 subset: run `headscale configtest` against the generated file and verify full integration in staging.
- Traefik route/ACME handling is Dokploy-instance specific; do not assume zero-click public TLS.
- Avoid auto-opening unrestricted access to corporate devices; configure Tailnet policy/ACL before adding users.

## To publish in Dokploy templates
- Place `docker-compose.yml`, `template.toml`, `meta.json`, `logo.svg` under `blueprints/headscale-headplane/` in Dokploy/templates.
- Use the generated preview Base64 import for staging verification.
- Update version metadata to represent both component versions.

## Validation plan
1. Import into a fresh test Dokploy instance.
2. Verify generated `.env`, mounts, two domains, and volumes.
3. Test `headscale configtest` and `/health`.
4. Confirm publicly trusted TLS for both origins.
5. Generate a key; log into Headplane; create user/preauth key.
6. Join two Tailscale clients and verify direct/relayed traffic, ACL and MagicDNS.
7. Restart containers and ensure nodes/data persist.
8. Validate certificate renewal and backup/restore.
