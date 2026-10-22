# Contributing

Thanks for helping improve this template. Bug reports, test results from real Dokploy instances
and pull requests are all welcome.

## Layout

```
blueprints/headscale-headplane/   the template, identical to its future Dokploy/templates folder
  docker-compose.yml              services, Traefik routing labels, volumes
  template.toml                   variables, Environment, domains, the two config templates
  meta.json, logo.svg
meta.json                         generated catalog index (scripts/build-catalog.mjs); not copied upstream
scripts/
  lib/dokploy.mjs                 port of Dokploy's template processor (Apache-2.0)
  lib/dokploy-deploy.mjs          port of Dokploy's deploy-time labels/networks + Traefik config (Apache-2.0)
  lib/blueprint.mjs               loading, domain overrides, git refs
  build-import.mjs                Base64 import generator (--base-domain etc.)
  build-catalog.mjs               root meta.json (--check in CI)
  check-catalog.mjs               installs from a catalog Base URL like Dokploy does
  render.mjs                      Dokploy's on-disk layout, optionally with deploy-time routing
  validate.mjs                    static validation
  check-upstream.sh               the official Dokploy/templates validators
  create-api-key.sh, backup.sh, restore.sh   host-side operator tools
tests/
  lib.sh                          shared helpers (Traefik, PKI, Tailscale, terminal emulation)
  traefik-config.mjs              Dokploy's Traefik static/dynamic config for tests
  validate-negative.mjs           29 broken variants the validator must reject
  routing-traefik.sh              routing behind real Traefik (shared|isolated)
  e2e-local.sh                    end-to-end lifecycle
docs/TESTING.md, docs/MIGRATION-HABS.md
```

`dist/` and `.render/` are generated and ignored. CI builds the import string and attaches it to
releases.

## Workflow

```bash
npm ci
npm run validate && npm run test:negative && npm run check:catalog
npm run test:routing     # Docker
npm run test:e2e         # Docker, full git history
```

Pull requests run all of it, plus ShellCheck 0.10.0 and 0.11.0 (`-x`), actionlint, the official
Dokploy/templates validators, an image check for amd64 and arm64, and gitleaks on the full history.

### Rules the validator enforces

- Dokploy conventions: no `ports`, `container_name`, `networks`, `privileged` or Docker socket;
  pinned images; `meta.json` `version` equals the Headscale tag
- Every service is read-only, with `cap_drop: [ALL]` and `no-new-privileges`. Long-running
  services have health checks and `restart: unless-stopped`
- Compose `${VAR}` references come only from the template env (or Dokploy's `APP_NAME`). The
  mount templates use only the `{{PLACEHOLDERS}}` that `headscale-config` validates and
  substitutes
- `headscale` and `headplane` depend on `headscale-config` with `restart: true`
- Traefik labels: named `${APP_NAME}-headplane-*`, host from `${HEADPLANE_HOST}`, never a
  Dokploy-generated router name; the method filter must allow PATCH
- `headscale-admin`: same Headscale version (`-debug`), bounded sleep, no ports, no data volume,
  tmpfs socket shared only with `headscale`
- `base_domain` stays `${domain}` in the repository; no secrets in tracked files

Add a negative case to `tests/validate-negative.mjs` for every new rule.

### Writing tests

Use `contains` (from `tests/lib.sh`) instead of `grep -q` in pipelines. Under `set -o
pipefail`, `grep -q` can SIGPIPE the producer, turning a match into a failure, or, inside `!`,
into a false pass. Check that nodes are *online in Headscale* (`wait_nodes_online`), not just
locally *Running*.

## Bumping versions

1. Read the upstream release notes. Headscale moves **one minor version at a time**; check
   Headplane's supported Headscale range.
2. In `docker-compose.yml`, update `headscale`, `headscale-config` and `headscale-admin` together
   (the last two with `-debug`), and `headplane`. Update `version` in both `meta.json` files
   (`npm run build:catalog`).
3. Diff the new upstream example configs against the templates in `template.toml`, and update the
   version references in their header comments and in the README.
4. If Dokploy's Traefik version changed, update `TRAEFIK_VERSION` in
   `scripts/lib/dokploy-deploy.mjs`.
5. In `tests/e2e-local.sh`, point `PREV_TEMPLATE_REF`, `FROM_HEADSCALE` and `FROM_HEADPLANE` at
   the previous release.
6. Run every test, then the live checks in [docs/TESTING.md](docs/TESTING.md).

When Dokploy changes its template processing or deploy-time labelling, update the two ports in
`scripts/lib/` (and the commit references at their top), and `UPSTREAM_REF` in
`.github/workflows/ci.yml`.

## Releasing

1. Update `CHANGELOG.md`; all CI jobs green on the release commit.
2. Tag `vX.Y.Z` and push the tag. `release.yml` validates, builds `import-base64.txt` + SHA-256,
   verifies the catalog at the tag (public repositories), and publishes the GitHub release with
   the catalog Base URL.
3. Install from the catalog at the tag on a test Dokploy (docs/TESTING.md, Manual test 2) before
   announcing.

## Submitting to Dokploy/templates

1. Fork [Dokploy/templates](https://github.com/Dokploy/templates) and branch from `canary`.
2. Copy only `blueprints/headscale-headplane/` (not the root `meta.json`, which their build
   generates).
3. In the fork: `node build-scripts/generate-meta.js --check`, plus
   `scripts/check-upstream.sh <fork>` from this repository.
4. Open the PR. Test their preview's Base64/catalog on a real Dokploy and include the results
   (untested PRs are closed). Point out in the PR description:
   - the first API key is created in `headscale-admin`'s terminal (/bin/sh tab);
   - both domains need Let's Encrypt selected, and Isolated Deployment is recommended;
   - the Traefik labels on `headplane` (root redirect, 404/405 filtering) use their own
     `${APP_NAME}`-prefixed names and Dokploy's default entrypoints `web`/`websecure`.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`).
