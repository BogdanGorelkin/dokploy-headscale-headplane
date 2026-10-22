# Changelog

All notable changes to this template. Versions follow the template, not the
Headscale/Headplane images (listed per release).

## [Unreleased] — prepared as 1.0.0

Images: Headscale 0.29.5, Headplane 0.8.1, Headscale 0.29.5-debug (helper and renderer).

### Added
- Installation from Dokploy's Templates catalog: root `meta.json`, Base URL
  `https://raw.githubusercontent.com/<owner>/<repo>/<ref>`; `scripts/check-catalog.mjs`
  replays Dokploy's catalog fetch and deployment.
- Environment-driven configuration: `HEADSCALE_HOST`, `HEADPLANE_HOST`,
  `MAGICDNS_DOMAIN`, `HEADPLANE_COOKIE_SECRET`. The `headscale-config` one-shot
  service validates them and renders the two mount templates on every deploy;
  changes restart the affected services.
- Headplane routing in Traefik: `/` and `/admin` → `/admin/`, 404 for paths
  outside `/admin/` and for probes under it, 405 for methods the UI never sends.
- `headscale-admin` helper: create API keys from Dokploy's web terminal without SSH.
- Routing integration test behind Traefik 3.6.25 wired like Dokploy (shared and
  isolated networks), with a real Tailscale client over HTTPS.
- MIT license, third-party notices, migration runbook (`docs/MIGRATION-HABS.md`).

### Changed
- The Headplane domain routes `/admin/` only.
- Config mounts moved from `/etc/headscale/config.yaml` and
  `/etc/headplane/config.yaml` to `/templates/*.yaml` (templates with
  `{{PLACEHOLDERS}}`). Upgrade existing deployments by re-importing.
- `restore.sh` accepts backups without `headplane-data` (Headscale-only migrations).

### Fixed
- Tests now require clients to be *online in Headscale* (previously only the
  client's local state was checked) and connect over HTTPS like real devices.
- Pipeline-safe `grep` in tests (a `grep -q` under `pipefail` could turn matches
  into failures, or absence checks into false passes).

## 5bca341 — first live deployment
- Base64 import, `headscale-admin` bootstrap helper, production-domain import.

## d437210 — initial tested template
