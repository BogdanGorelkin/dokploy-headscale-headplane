#!/usr/bin/env node
// Static validation of the blueprint. No Docker or network access required.
//
//   node scripts/validate.mjs [--import <base64-file>] [--dir <blueprint-dir>]
//
// Checks Dokploy/templates conventions, Compose <-> template consistency,
// variable resolution through Dokploy's own processing logic, the generated
// Headscale/Headplane configs, accidental secrets and the Base64 import
// round-trip. Exit code 1 on any error.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import YAML from "yaml";
import {
	BLUEPRINT_DIR,
	BLUEPRINT_ID,
	REPO_ROOT,
	applyVariableOverrides,
	checkMagicDnsDomain,
	loadBlueprint,
	parseArgs,
} from "./lib/blueprint.mjs";
import { encodeImport, parseTemplate, processImport } from "./lib/dokploy.mjs";

const errors = [];
const warnings = [];
const error = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const KNOWN_HELPERS = /^(domain|base64(:\d+)?|password(:\d+)?|hash(:\d+)?|uuid|randomPort|timestamp|timestampms|timestamps(:.+)?|timestampms:.+|jwt(:.+)?|username|email)$/;
const SAMPLE = { appName: "validate-headscale-headplane-abc123", serverIp: "203.0.113.10" };

function placeholders(text) {
	return [...String(text).matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
}

// -- Load and parse ---------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const blueprintDir = args.dir ?? BLUEPRINT_DIR;
const blueprint = loadBlueprint(blueprintDir);
let compose;
let template;
try {
	const doc = YAML.parseDocument(blueprint.compose, { uniqueKeys: true });
	if (doc.errors.length) throw doc.errors[0];
	compose = doc.toJS();
} catch (e) {
	error(`docker-compose.yml: invalid YAML (${e.message})`);
}
try {
	template = parseTemplate(blueprint.config);
} catch (e) {
	error(`template.toml: invalid TOML (${e.message}) at line ${e.line}`);
}
if (!blueprint.meta) error("meta.json: missing");

// -- meta.json (same rules as Dokploy/templates build-scripts/generate-meta.js)
const meta = blueprint.meta ?? {};
for (const field of ["id", "name", "version", "description", "links", "logo", "tags"]) {
	if (meta[field] === undefined || meta[field] === null || meta[field] === "") {
		error(`meta.json: missing required field "${field}"`);
	}
}
for (const link of ["github", "website", "docs"]) {
	if (!meta.links || !(link in meta.links)) error(`meta.json: links.${link} is required`);
}
if (meta.id !== BLUEPRINT_ID && args.dir === undefined) error(`meta.json: id must be "${BLUEPRINT_ID}" (folder name)`);
if (!Array.isArray(meta.tags) || meta.tags.length === 0) error("meta.json: tags must be a non-empty array");
if (Array.isArray(meta.tags) && meta.tags.some((t) => t !== String(t).toLowerCase())) {
	error("meta.json: tags must be lowercase");
}
if (meta.logo && !existsSync(join(blueprintDir, meta.logo))) {
	error(`meta.json: logo file "${meta.logo}" not found`);
}

// -- docker-compose.yml (Dokploy/templates validate-docker-compose.ts rules + ours)
const services = compose?.services ?? {};
const serviceNames = Object.keys(services);
if (serviceNames.length === 0) error("docker-compose.yml: no services");
const declaredVolumes = Object.keys(compose?.volumes ?? {});
const bindSources = new Set();
const imageTags = {};

for (const [name, svc] of Object.entries(services)) {
	const where = `docker-compose.yml: service "${name}"`;
	if (name !== name.toLowerCase() || name.includes("_")) error(`${where}: use lowercase, hyphenated names`);
	if (svc.ports) error(`${where}: "ports" is not allowed (Dokploy routes through Traefik; use "expose")`);
	if (svc.container_name) error(`${where}: "container_name" is not allowed`);
	if (svc.networks) error(`${where}: explicit "networks" are not allowed`);
	if (svc.privileged) error(`${where}: "privileged" is not allowed`);
	if (svc.network_mode) error(`${where}: "network_mode" is not allowed`);
	if (!["unless-stopped", "always"].includes(svc.restart)) error(`${where}: restart must be unless-stopped or always`);
	if (!svc.healthcheck) error(`${where}: healthcheck missing`);
	if (!svc.image) error(`${where}: image missing`);

	const image = String(svc.image ?? "");
	const tag = image.includes("@") ? null : image.split("/").pop().split(":")[1];
	if (!tag && !image.includes("@sha256:")) error(`${where}: image "${image}" must be pinned to a tag or digest`);
	if (tag === "latest" || /^(stable|main|master|edge|nightly)$/.test(tag ?? "")) {
		error(`${where}: image "${image}" uses a floating tag`);
	}
	imageTags[name] = tag;

	for (const vol of svc.volumes ?? []) {
		const spec = typeof vol === "string" ? vol : `${vol.source}:${vol.target}`;
		const [source] = spec.split(":");
		if (source.includes("docker.sock")) error(`${where}: Docker socket must not be mounted`);
		if (source.startsWith("/")) error(`${where}: absolute host path "${source}" (use ../files/...)`);
		if (source.startsWith("../files/")) {
			bindSources.add(source.slice("../files".length));
		} else if (source.startsWith(".")) {
			error(`${where}: bind mount "${source}" must live under ../files/`);
		} else if (!declaredVolumes.includes(source)) {
			error(`${where}: volume "${source}" is not declared under top-level volumes`);
		}
	}
	for (const dep of Object.keys(svc.depends_on ?? {})) {
		if (!serviceNames.includes(dep)) error(`${where}: depends_on unknown service "${dep}"`);
	}
}
for (const ref of placeholders(blueprint.compose)) {
	error(`docker-compose.yml: \${${ref}} interpolation is not provided by the template env`);
}
if (meta.version && imageTags.headscale !== meta.version) {
	error(`meta.json: version "${meta.version}" must match the headscale image tag "${imageTags.headscale}"`);
}

// -- template.toml structure and references -------------------------------
const variables = template?.variables ?? {};
const config = template?.config ?? {};
const usedVariables = new Set();

function checkRefs(text, where) {
	for (const ref of placeholders(text)) {
		if (KNOWN_HELPERS.test(ref) || ref === "APP_NAME") continue;
		if (!(ref in variables)) error(`${where}: \${${ref}} is not defined in [variables]`);
		usedVariables.add(ref);
	}
}

for (const [key, value] of Object.entries(variables)) {
	if (typeof value !== "string") error(`[variables].${key}: must be a string`);
	checkRefs(value, `[variables].${key}`);
}
if (!template?.config) error("template.toml: missing [config]");
if (!Array.isArray(config.domains) || config.domains.length === 0) error("template.toml: no [[config.domains]]");
for (const [i, d] of (config.domains ?? []).entries()) {
	const where = `config.domains[${i}]`;
	if (!serviceNames.includes(d.serviceName)) error(`${where}: serviceName "${d.serviceName}" not in compose`);
	const exposed = (services[d.serviceName]?.expose ?? []).map(String);
	if (!exposed.includes(String(d.port))) error(`${where}: port ${d.port} is not exposed by "${d.serviceName}"`);
	if (!String(d.host ?? "").includes("${")) error(`${where}: host must be derived from a variable, not hardcoded`);
	if (d.https !== true) error(`${where}: https = true is required (Headplane uses Secure cookies)`);
	checkRefs(d.host, `${where}.host`);
}
for (const [i, m] of (config.mounts ?? []).entries()) {
	const where = `config.mounts[${i}]`;
	if (typeof m.filePath !== "string" || typeof m.content !== "string") {
		error(`${where}: filePath and content must be strings`);
		continue;
	}
	checkRefs(m.filePath, `${where}.filePath`);
	checkRefs(m.content, `${where}.content`);
	const normalized = m.filePath.startsWith("/") ? m.filePath : `/${m.filePath}`;
	if (!bindSources.has(normalized)) warn(`${where}: ${m.filePath} is not bind-mounted by any service`);
	bindSources.delete(normalized);
}
for (const missing of bindSources) {
	error(`docker-compose.yml: ../files${missing} has no [[config.mounts]] entry (Docker would create a directory)`);
}
const env = Array.isArray(config.env) ? config.env : Object.entries(config.env ?? {}).map(([k, v]) => `${k}=${v}`);
for (const [i, e] of env.entries()) checkRefs(String(e), `config.env[${i}]`);
for (const key of Object.keys(variables)) {
	if (!usedVariables.has(key)) warn(`[variables].${key} is never used`);
}
if (variables.base_domain !== "${domain}") {
	error('[variables].base_domain must stay "${domain}" in the repository; use build-import --base-domain');
}

// -- Render through Dokploy's import path and validate the result ----------
function renderAndCheck(label, configSource) {
	let result;
	try {
		result = processImport(encodeImport({ compose: blueprint.compose, config: configSource }), SAMPLE);
	} catch (e) {
		error(`${label}: Dokploy import processing failed (${e.message})`);
		return;
	}
	const { template: t } = result;
	const leftovers = [
		...t.domains.map((d) => d.host),
		...t.envs,
		...t.mounts.flatMap((m) => [m.filePath, m.content]),
	].flatMap(placeholders);
	for (const p of new Set(leftovers)) error(`${label}: unresolved placeholder \${${p}} after processing`);

	const hosts = Object.fromEntries(t.domains.map((d) => [d.serviceName, d.host]));
	const mount = (path) => t.mounts.find((m) => m.filePath === path)?.content;

	let hsConfig;
	let hpConfig;
	try {
		hsConfig = YAML.parse(mount("/etc/headscale/config.yaml") ?? "");
	} catch (e) {
		error(`${label}: headscale config.yaml is invalid YAML (${e.message})`);
	}
	try {
		hpConfig = YAML.parse(mount("/etc/headplane/config.yaml") ?? "");
	} catch (e) {
		error(`${label}: headplane config.yaml is invalid YAML (${e.message})`);
	}
	if (!hsConfig || !hpConfig) {
		error(`${label}: both /etc/headscale/config.yaml and /etc/headplane/config.yaml mounts are required`);
		return;
	}

	const expect = (cond, msg) => cond || error(`${label}: ${msg}`);
	expect(hsConfig.server_url === `https://${hosts.headscale}`, "headscale server_url must be https://<headscale domain>");
	expect(hsConfig.listen_addr === "0.0.0.0:8080", "headscale listen_addr must be 0.0.0.0:8080 (matches the domain port)");
	expect(String(hsConfig.metrics_listen_addr).startsWith("127.0.0.1:"), "headscale metrics must stay on loopback");
	expect(String(hsConfig.grpc_listen_addr).startsWith("127.0.0.1:"), "headscale gRPC must stay on loopback");
	expect(hsConfig.grpc_allow_insecure === false, "grpc_allow_insecure must be false");
	expect(!(hsConfig.trusted_proxies ?? []).some((c) => c === "0.0.0.0/0" || c === "::/0"), "trusted_proxies must not trust everything");
	expect(String(hsConfig.noise?.private_key_path).startsWith("/var/lib/headscale/"), "noise key must live on the data volume");
	expect(String(hsConfig.database?.sqlite?.path).startsWith("/var/lib/headscale/"), "database must live on the data volume");
	expect(hsConfig.policy?.mode === "database", "policy.mode must be database (ACL editing via Headplane)");
	const dnsProblem = checkMagicDnsDomain(hosts.headscale, hsConfig.dns?.base_domain ?? "");
	expect(!dnsProblem, dnsProblem);

	const secret = hpConfig.server?.cookie_secret;
	expect(typeof secret === "string" && secret.length === 32, "headplane cookie_secret must be a 32 character string");
	expect(hpConfig.server?.cookie_secure === true, "headplane cookie_secure must be true");
	expect(hpConfig.server?.base_url === `https://${hosts.headplane}`, "headplane base_url must be https://<headplane domain>");
	expect(hpConfig.headscale?.url === "http://headscale:8080", "headplane must reach headscale on the internal network");
	expect(hpConfig.headscale?.public_url === hsConfig.server_url, "headplane public_url must equal headscale server_url");
	expect(hpConfig.headscale?.config_path === "/etc/headscale/config.yaml", "headplane config_path must match the mount");
	expect(!hpConfig.integration?.docker?.enabled, "Docker integration must stay disabled (no socket)");

	// A second import must yield a different secret (generated, not committed).
	const again = processImport(encodeImport({ compose: blueprint.compose, config: configSource }), SAMPLE);
	const secretAgain = YAML.parse(again.template.mounts.find((m) => m.filePath === "/etc/headplane/config.yaml").content).server.cookie_secret;
	expect(secretAgain !== secret, "cookie_secret must be generated per import");
	return hosts;
}

if (template && compose) {
	renderAndCheck("default (${domain})", blueprint.config);
	const custom = applyVariableOverrides(blueprint.config, {
		base_domain: "example.com",
		headscale_host: "headscale-test.example.com",
	});
	const hosts = renderAndCheck("custom domain", custom);
	if (hosts && hosts.headscale !== "headscale-test.example.com") error("custom domain: host override not applied");
	if (hosts && hosts.headplane !== "headplane.example.com") error("custom domain: derived host not applied");
}

// -- Secrets / hardcoded values in tracked text files -----------------------
const SECRET_PATTERNS = [
	[/hskey-(api|auth)-[A-Za-z0-9_-]{8,}/, "Headscale API/pre-auth key"],
	[/tskey-[a-z]+-[A-Za-z0-9]{8,}/, "Tailscale key"],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "PEM private key"],
	[/privkey:[0-9a-f]{64}/, "Headscale Noise/DERP private key"],
	[/cookie_secret:\s*"?[A-Za-z0-9]{32}"?\s*$/m, "literal Headplane cookie secret"],
	[/gh[pousr]_[A-Za-z0-9]{36,}/, "GitHub token"],
];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".render"]);
function walk(dir) {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		if (SKIP_DIRS.has(name)) return [];
		return statSync(full).isDirectory() ? walk(full) : [full];
	});
}
for (const file of walk(REPO_ROOT)) {
	if (!/\.(ya?ml|toml|json|md|mjs|js|sh|txt|env)$|^\.env/.test(file)) continue;
	if (file.endsWith("package-lock.json") || file.endsWith("validate.mjs")) continue;
	const text = readFileSync(file, "utf8");
	for (const [re, what] of SECRET_PATTERNS) {
		if (re.test(text)) error(`${relative(REPO_ROOT, file)}: looks like a committed ${what}`);
	}
}

// -- Optional: verify a generated import artifact ---------------------------
if (args.import) {
	const base64 = readFileSync(args.import, "utf8").trim();
	try {
		const decoded = JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
		if (Object.keys(decoded).sort().join(",") !== "compose,config") {
			error(`${args.import}: JSON must contain exactly "compose" and "config"`);
		}
		if (decoded.compose !== blueprint.compose) error(`${args.import}: compose differs from the blueprint`);
		parseTemplate(decoded.config);
		const result = processImport(base64, SAMPLE);
		if (result.template.domains.length !== config.domains.length) error(`${args.import}: domain count mismatch`);
		if (result.template.mounts.length !== config.mounts.length) error(`${args.import}: mount count mismatch`);
		console.log(`import artifact OK: ${relative(process.cwd(), args.import)}`);
		for (const d of result.template.domains) console.log(`  domain  ${d.serviceName} -> ${d.host}:${d.port} https=${d.https}`);
		for (const m of result.template.mounts) console.log(`  mount   ${m.filePath} (${m.content.length} bytes)`);
		console.log(`  env     ${result.template.envs.length} variable(s)`);
	} catch (e) {
		error(`${args.import}: cannot decode/parse import artifact (${e.message})`);
	}
}

for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`error: ${e}`);
if (errors.length) {
	console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
	process.exit(1);
}
console.log(`validation passed (${serviceNames.length} services, ${config.domains.length} domains, ${config.mounts.length} mounts, ${warnings.length} warning(s))`);
