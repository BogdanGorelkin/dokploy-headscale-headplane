#!/usr/bin/env node
// Writes the Traefik static and dynamic configuration Dokploy uses (see
// scripts/lib/dokploy-deploy.mjs) into <dir>, with a test default certificate.
//   node tests/traefik-config.mjs <dir>

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { traefikDynamicMiddlewares, traefikStaticConfig } from "../scripts/lib/dokploy-deploy.mjs";

const [dir] = process.argv.slice(2);
if (!dir) throw new Error("usage: traefik-config.mjs <dir>");
mkdirSync(join(dir, "dynamic"), { recursive: true });
writeFileSync(join(dir, "traefik.yml"), YAML.stringify(traefikStaticConfig()));
writeFileSync(join(dir, "dynamic", "middlewares.yml"), YAML.stringify(traefikDynamicMiddlewares()));
writeFileSync(
	join(dir, "dynamic", "tls.yml"),
	YAML.stringify({
		tls: { stores: { default: { defaultCertificate: { certFile: "/pki/tls.pem", keyFile: "/pki/tls.key" } } } },
	}),
);
