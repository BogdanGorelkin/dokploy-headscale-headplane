#!/usr/bin/env node
// Renders the template into the on-disk layout Dokploy uses for a Compose
// service, so the stack can be started locally with plain `docker compose`:
//
//   <out>/code/docker-compose.yml   compose file as Dokploy runs it
//   <out>/code/.env                 APP_NAME, COMPOSE_PROJECT_NAME + template env
//   <out>/files/<filePath>          one file per [[config.mounts]] entry
//   <out>/dokploy.json              resolved domains/variables (for tests)
//
//   node scripts/render.mjs --out .render/x --base-domain example.test
//     [--app-name x] [--server-ip 1.2.3.4]
//     [--ref <git-ref>]                       template as committed at <ref>
//     [--dokploy-routing shared|isolated]     add Dokploy's Traefik labels and
//                                             networks (dokploy-network, or the
//                                             Isolated Deployment network)

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	REPO_ROOT,
	applyVariableOverrides,
	loadBlueprint,
	loadBlueprintAtRef,
	overridesFromArgs,
	parseArgs,
} from "./lib/blueprint.mjs";
import { applyDokployDeploy, dokployEnvFile } from "./lib/dokploy-deploy.mjs";
import { encodeImport, processImport } from "./lib/dokploy.mjs";

const args = parseArgs(process.argv.slice(2));
const out = resolve(REPO_ROOT, args.out ?? ".render");
const appName = args["app-name"] ?? "hshp-local";
const serverIp = args["server-ip"] ?? "127.0.0.1";
const routing = args["dokploy-routing"] ?? "none";
if (!["none", "shared", "isolated"].includes(routing)) {
	throw new Error("--dokploy-routing must be none, shared or isolated");
}

const blueprint = args.ref ? loadBlueprintAtRef(args.ref) : loadBlueprint();
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
const { domains, envs, mounts, variables } = imported.template;

const compose =
	routing === "none"
		? imported.compose
		: applyDokployDeploy(imported.compose, domains, { appName, isolated: routing === "isolated" });

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "code"), { recursive: true });
writeFileSync(join(out, "code", "docker-compose.yml"), compose);
writeFileSync(join(out, "code", ".env"), dokployEnvFile(appName, envs));

for (const mount of mounts) {
	const target = join(out, "files", mount.filePath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, mount.content);
}

writeFileSync(
	join(out, "dokploy.json"),
	`${JSON.stringify({ appName, routing, ref: args.ref ?? null, domains, variables, envs, mounts: mounts.map((m) => m.filePath) }, null, 2)}\n`,
);

console.log(`Rendered ${relative(process.cwd(), out) || "."} for app ${appName}${args.ref ? ` (template at ${args.ref})` : ""}`);
for (const d of domains) {
	console.log(`  ${d.serviceName.padEnd(10)} https://${d.host}${d.path && d.path !== "/" ? d.path : ""} -> :${d.port}`);
}
