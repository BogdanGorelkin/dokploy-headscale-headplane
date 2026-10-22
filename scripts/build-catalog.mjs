#!/usr/bin/env node
// Writes the root meta.json that turns this repository into a Dokploy template
// catalog: Dokploy -> Create Service -> Template -> Base URL fetches
// <base>/meta.json and <base>/blueprints/<id>/{template.toml,docker-compose.yml,logo}.
// Same shape as Dokploy/templates' generated meta.json (an array, sorted by id).
//
//   node scripts/build-catalog.mjs           # write meta.json
//   node scripts/build-catalog.mjs --check   # fail if meta.json is out of date

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/blueprint.mjs";

const out = join(REPO_ROOT, "meta.json");
const blueprints = join(REPO_ROOT, "blueprints");
const entries = readdirSync(blueprints)
	.filter((id) => existsSync(join(blueprints, id, "meta.json")))
	.map((id) => JSON.parse(readFileSync(join(blueprints, id, "meta.json"), "utf8")))
	.sort((a, b) => String(a.id).localeCompare(String(b.id)));
const content = `${JSON.stringify(entries, null, 2)}\n`;

if (process.argv.includes("--check")) {
	const current = existsSync(out) ? readFileSync(out, "utf8") : "";
	if (current !== content) {
		console.error("meta.json is out of date: run `node scripts/build-catalog.mjs` and commit it");
		process.exit(1);
	}
	console.log(`meta.json is up to date (${entries.length} template(s))`);
} else {
	writeFileSync(out, content);
	console.log(`Wrote meta.json (${entries.length} template(s))`);
}
