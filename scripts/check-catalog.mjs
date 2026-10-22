#!/usr/bin/env node
// Installs the template from a Dokploy template catalog the way Dokploy does,
// without a Dokploy: fetches the catalog exactly like
// packages/server/src/templates/github.ts (meta.json, template.toml,
// docker-compose.yml, logo) and processes it like the compose router's
// deployTemplate mutation, then prints what Dokploy would create.
//
//   node scripts/check-catalog.mjs --base-url https://raw.githubusercontent.com/<owner>/<repo>/<ref>
//   node scripts/check-catalog.mjs --serve-local     # serve this checkout on 127.0.0.1
//     [--project <Dokploy project name>] [--server-ip <ip>]

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import YAML from "yaml";
import { BLUEPRINT_ID, REPO_ROOT, parseArgs } from "./lib/blueprint.mjs";
import { generatePassword, parseTemplate, processTemplate } from "./lib/dokploy.mjs";

const args = parseArgs(process.argv.slice(2), { booleans: ["serve-local"] });
const projectName = args.project ?? "headscale";
const serverIp = args["server-ip"] ?? "203.0.113.10";
const failures = [];
const expect = (cond, msg) => {
	console.log(`  ${cond ? "PASS" : "FAIL"} ${msg}`);
	if (!cond) failures.push(msg);
};

// apps/dokploy/lib/slug.ts (slugify with { lower, trim, strict }).
const slugify = (text) =>
	(text.trim().replace(/[^a-zA-Z0-9\s]/g, "") || "service").toLowerCase().trim().split(/\s+/).join("-");

async function serveLocal() {
	const types = { ".json": "application/json", ".svg": "image/svg+xml", ".toml": "text/plain", ".yml": "text/plain" };
	const server = createServer(async (req, res) => {
		const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
		if (path.includes("..")) return res.writeHead(400).end();
		try {
			const body = await readFile(join(REPO_ROOT, path));
			res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function get(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
	return { response, ok: response.ok, type: response.headers.get("content-type") ?? "" };
}

let local;
let baseUrl = args["base-url"];
if (args["serve-local"]) {
	local = await serveLocal();
	baseUrl = local.baseUrl;
}
if (!baseUrl) {
	console.error("usage: check-catalog.mjs --base-url <url> | --serve-local");
	process.exit(2);
}
baseUrl = baseUrl.replace(/\/+$/, "");
console.log(`Catalog ${baseUrl}`);

try {
	// fetchTemplatesList
	const list = await get(`${baseUrl}/meta.json`);
	expect(list.ok, `GET /meta.json -> ${list.response.status}`);
	const templates = list.ok ? await list.response.json() : [];
	expect(Array.isArray(templates), "meta.json is an array");
	const meta = templates.find((t) => t.id === BLUEPRINT_ID);
	expect(Boolean(meta), `catalog lists "${BLUEPRINT_ID}"`);

	// fetchTemplateFiles + fetchTemplateLogo
	const toml = await get(`${baseUrl}/blueprints/${BLUEPRINT_ID}/template.toml`);
	const compose = await get(`${baseUrl}/blueprints/${BLUEPRINT_ID}/docker-compose.yml`);
	expect(toml.ok && compose.ok, "template.toml and docker-compose.yml are served");
	if (meta?.logo) {
		const logo = await get(`${baseUrl}/blueprints/${BLUEPRINT_ID}/${meta.logo}`);
		expect(logo.ok, `logo ${meta.logo} is served`);
		// The template list renders it with <img>, which needs an image type.
		expect(logo.type.startsWith("image/"), `logo content-type is an image (${logo.type})`);
	}

	// deployTemplate: APP_NAME injection, variables, domains, env, mounts
	const config = parseTemplate(await toml.response.text());
	const dockerCompose = await compose.response.text();
	const project = slugify(`${projectName} ${BLUEPRINT_ID}`);
	const appName = `${project}-${generatePassword(6)}`;
	const generated = processTemplate(
		{ ...config, variables: { APP_NAME: appName, ...config.variables } },
		{ serverIp, projectName: project },
	);
	YAML.parse(dockerCompose);
	const env = Object.fromEntries(generated.envs.map((e) => [e.split("=")[0], e.slice(e.indexOf("=") + 1)]));
	const hosts = Object.fromEntries(generated.domains.map((d) => [d.serviceName, d.host]));
	expect(generated.domains.length === 2, "two domains (headscale, headplane)");
	expect(generated.domains.every((d) => d.https === true), "both domains with HTTPS enabled");
	expect(hosts.headscale?.endsWith(`-${serverIp.replaceAll(".", "-")}.sslip.io`), `generated sslip.io domain embeds ${serverIp}`);
	expect(env.HEADSCALE_HOST === hosts.headscale && env.HEADPLANE_HOST === hosts.headplane, "Environment hosts match the domains");
	expect(/^[0-9a-f]{32}$/.test(env.HEADPLANE_COOKIE_SECRET ?? ""), "cookie secret generated (32 hex characters)");
	expect(generated.mounts.length === 2, "two mount templates");
	expect(!JSON.stringify(generated).includes("${"), "no unresolved ${...} placeholders");

	console.log(`\nDokploy would create (app ${appName}):`);
	for (const d of generated.domains) console.log(`  domain  https://${d.host}${d.path ?? ""} -> ${d.serviceName}:${d.port}`);
	for (const [k, v] of Object.entries(env)) console.log(`  env     ${k}=${k.includes("SECRET") ? "<32 hex characters>" : v}`);
	for (const m of generated.mounts) console.log(`  mount   ${m.filePath}`);
} catch (e) {
	failures.push(e.message);
	console.error(`error: ${e.message}`);
} finally {
	local?.server.close();
}

if (failures.length) {
	console.error(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\ncatalog OK");
