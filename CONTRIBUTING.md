# Contributing

Thanks for helping improve this template. Bug reports, test results from real Dokploy instances
and pull requests are all welcome.

## Layout

```
blueprints/headscale-headplane/   the template itself, identical to its future Dokploy/templates folder
  docker-compose.yml
  template.toml                   variables, domains and the two config mounts
  meta.json
  logo.svg
scripts/
  lib/dokploy.mjs                 port of Dokploy's template processor (keep in sync with upstream)
  build-import.mjs                Base64 import generator (--base-domain etc.)
  render.mjs                      renders the Dokploy on-disk layout for local docker compose
  validate.mjs                    static validation
  check-upstream.sh               runs the official Dokploy/templates validators
  create-api-key.sh, backup.sh, restore.sh   host-side operator tools (SSH fallback, backups)
tests/
  validate-negative.mjs           the validator must reject broken templates
  e2e-local.sh                    end-to-end test with Docker
docs/TESTING.md                   manual test procedure on a live Dokploy
```

Generated files (`dist/`, `.render/`) are not committed. CI builds the import string and
attaches it to releases.

## Development workflow

```bash
npm ci
npm run validate
node tests/validate-negative.mjs
npm run test:e2e          # Docker required
```

Every pull request runs: static validation, negative tests, shellcheck, actionlint, the official
Dokploy/templates validators, an image tag check for amd64 and arm64, a gitleaks scan of the full
history, and the end-to-end test.

Rules the validator enforces (from Dokploy/templates, plus this project's own):

- No `ports`, `container_name`, `networks`, `privileged` or Docker socket mounts
- Every service is read-only, with `cap_drop: [ALL]`, `no-new-privileges` and a health check
- `headscale-admin` stays a time-limited, port-less shell. It shares only the tmpfs socket
  volume, never Headscale's data volume, and no other service may mount that socket
- Images pinned to an exact tag. `meta.json` `version` equals the Headscale image tag
- Every `${...}` resolves through Dokploy's processor. Every `../files/...` bind mount has a `[[config.mounts]]` entry
- `base_domain` stays `${domain}` in the repository; custom domains are applied by `build-import`
- No secrets in tracked files

## Bumping versions

1. Read the upstream release notes. Headscale must move **one minor version at a time**.
   Check Headplane's supported Headscale range.
2. Update the image tags in `blueprints/headscale-headplane/docker-compose.yml`. `headscale-admin`
   must use the same Headscale version with the `-debug` suffix; the validator enforces this.
   Then update `version` in `meta.json`.
3. Diff the new upstream example configs against the mounts in `template.toml`:
   - `https://github.com/juanfont/headscale/blob/v<version>/config-example.yaml`
   - `https://github.com/tale/headplane/blob/v<version>/config.example.yaml`

   Update the version references in the mount header comments and in the README tables.
4. In `tests/e2e-local.sh`, set `FROM_HEADSCALE` / `FROM_HEADPLANE` to the previously pinned
   versions. Point `PREV_TEMPLATE_REF` at the last released commit of the template.
5. Run all tests, then repeat the manual Dokploy test ([docs/TESTING.md](docs/TESTING.md)) for
   anything touching routing, TLS or authentication.

When Dokploy changes its template processing (`packages/server/src/templates/processors.ts`,
the compose router's `import` mutation), update `scripts/lib/dokploy.mjs` and the commit
reference at its top. Bump `UPSTREAM_REF` in `.github/workflows/ci.yml` to re-check the official validators.

## Submitting to Dokploy/templates

The `blueprints/headscale-headplane/` folder is designed to be copied as-is:

1. Fork [Dokploy/templates](https://github.com/Dokploy/templates) and branch from `canary`.
2. Copy `blueprints/headscale-headplane/` into the fork's `blueprints/`.
3. In the fork: `node build-scripts/generate-meta.js --check`, plus
   `scripts/check-upstream.sh <fork>` from this repository.
4. Open the PR. Their preview deployment produces a Base64 import. Test it on a real Dokploy
   ([docs/TESTING.md](docs/TESTING.md)) and include the results: untested PRs are closed.
5. Point out in the PR description that the first API key is created in the `headscale-admin`
   container's terminal (/bin/sh tab), and that both domains need Let's Encrypt selected after
   deployment.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`).
