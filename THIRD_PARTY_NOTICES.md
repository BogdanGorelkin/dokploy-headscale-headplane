# Third-party notices

This repository is licensed under the MIT License (see [LICENSE](LICENSE)),
except for the files listed below.

## Code derived from Dokploy (Apache License 2.0)

| File | Derived from |
| --- | --- |
| `scripts/lib/dokploy.mjs` | `packages/server/src/templates/{processors,index}.ts` |
| `scripts/lib/dokploy-deploy.mjs` | `packages/server/src/utils/docker/{domain,utils}.ts`, `utils/docker/collision/root-network.ts`, `setup/traefik-setup.ts` |

Copyright 2026-present Dokploy Technology, Inc. Licensed under the Apache
License, Version 2.0 (<https://www.apache.org/licenses/LICENSE-2.0>), as stated
in <https://github.com/Dokploy/dokploy/blob/canary/LICENSE.MD>. Both files carry
an SPDX header and describe their modifications (ported to plain JavaScript and
reduced to what template validation and tests need). They are development
tooling and are not part of the deployed template.

## Software referenced, not redistributed

The template references these container images by tag; no source or binaries
from them are included in this repository.

| Project | License |
| --- | --- |
| [Headscale](https://github.com/juanfont/headscale) | BSD-3-Clause |
| [Headplane](https://github.com/tale/headplane) | MIT |
| [Traefik](https://github.com/traefik/traefik) (tests only) | MIT |
| [Tailscale](https://github.com/tailscale/tailscale) client image (tests only) | BSD-3-Clause |

The blueprint folder (`blueprints/headscale-headplane/`) is intended for
contribution to [Dokploy/templates](https://github.com/Dokploy/templates),
which is MIT licensed.
