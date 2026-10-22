#!/usr/bin/env node
// Renders the template into the on-disk layout Dokploy uses for a Compose
// service, so the stack can be started locally with plain `docker compose`:
//
//   <out>/code/docker-compose.yml   compose file (Dokploy's "raw" source)
//   <out>/code/.env                 APP_NAME, COMPOSE_PROJECT_NAME + template env
//   <out>/files/<filePath>          one file per [[config.mounts]] entry
//   <out>/dokploy.json              resolved domains/variables (for tests)
//
// Dokploy adds Traefik labels and the dokploy-network at deploy time; this
// renderer intentionally does not, so local runs have no reverse proxy.
//
//   node scripts/render.mjs --out .render --base-domain example.test

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	REPO_ROOT,
	applyVariableOverrides,
	loadBlueprint,
	overridesFromArgs,
	parseArgs,
} from "./lib/blueprint.mjs";
import { encodeImport, processImport } from "./lib/dokploy.mjs";

const args = parseArgs(process.argv.slice(2));
const out = resolve(REPO_ROOT, args.out ?? ".render");
const appName = args["app-name"] ?? "hshp-local";
const serverIp = args["server-ip"] ?? "127.0.0.1";

const blueprint = loadBlueprint();
const overrides = overridesFromArgs(args);
const config = Object.keys(overrides).length
	? applyVariableOverrides(blueprint.config, overrides)
	: blueprint.config;

// Go through the real import path (encode -> decode -> process) rather than
// processing the TOML directly, so the artifact format is exercised too.
const imported = processImport(encodeImport({ compose: blueprint.compose, config }), {
	appName,
	serverIp,
});

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "code"), { recursive: true });
writeFileSync(join(out, "code", "docker-compose.yml"), imported.compose);

// Same leading lines as Dokploy's getCreateEnvFileCommand.
const env = [`APP_NAME=${appName}`, `COMPOSE_PROJECT_NAME=${appName}`, ...imported.template.envs];
writeFileSync(join(out, "code", ".env"), `${env.join("\n")}\n`);

for (const mount of imported.template.mounts) {
	const target = join(out, "files", mount.filePath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, mount.content);
}

writeFileSync(
	join(out, "dokploy.json"),
	`${JSON.stringify(
		{
			appName,
			domains: imported.template.domains,
			variables: imported.template.variables,
			envs: imported.template.envs,
			mounts: imported.template.mounts.map((m) => m.filePath),
		},
		null,
		2,
	)}\n`,
);

console.log(`Rendered ${relative(process.cwd(), out) || "."} for app ${appName}`);
for (const d of imported.template.domains) {
	console.log(`  ${d.serviceName.padEnd(10)} https://${d.host} -> :${d.port}`);
}
