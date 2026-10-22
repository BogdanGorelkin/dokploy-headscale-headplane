#!/usr/bin/env node
// Static validation of the blueprint. No Docker or network access required.
//
//   node scripts/validate.mjs [--import <base64-file> [--expect-base-domain <domain>]]
//                             [--dir <blueprint-dir>]
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
const ADMIN_SERVICE = "headscale-admin";
const CONFIG_SERVICE = "headscale-config";
const RENDER_KEYS = ["HEADSCALE_HOST", "HEADPLANE_HOST", "MAGICDNS_DOMAIN", "HEADPLANE_COOKIE_SECRET"];
const HEADSCALE_TEMPLATE = "/templates/headscale.yaml";
const HEADPLANE_TEMPLATE = "/templates/headplane.yaml";
const SOCKET_VOLUME = "headscale-socket";
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

// One-shot services: restart "no" and no healthcheck by design.
const ONE_SHOT = new Set([CONFIG_SERVICE]);

for (const [name, svc] of Object.entries(services)) {
	const where = `docker-compose.yml: service "${name}"`;
	if (name !== name.toLowerCase() || name.includes("_")) error(`${where}: use lowercase, hyphenated names`);
	if (svc.ports) error(`${where}: "ports" is not allowed (Dokploy routes through Traefik; use "expose")`);
	if (svc.container_name) error(`${where}: "container_name" is not allowed`);
	if (svc.networks) error(`${where}: explicit "networks" are not allowed`);
	if (svc.privileged) error(`${where}: "privileged" is not allowed`);
	if (svc.network_mode) error(`${where}: "network_mode" is not allowed`);
	if (svc.configs) error(`${where}: Compose "configs" can't be used with read_only services; use mounts`);
	// The admin helper stops itself after its idle timeout and is started on
	// demand from Dokploy's Containers tab; the config renderer runs once.
	const allowedRestart = ONE_SHOT.has(name) || name === ADMIN_SERVICE ? ["no"] : ["unless-stopped", "always"];
	if (!allowedRestart.includes(String(svc.restart))) {
		error(`${where}: restart must be ${allowedRestart.join(" or ")}`);
	}
	if (!svc.healthcheck && !ONE_SHOT.has(name)) error(`${where}: healthcheck missing`);
	if (svc.read_only !== true) error(`${where}: read_only: true is required`);
	if (!(svc.cap_drop ?? []).includes("ALL")) error(`${where}: cap_drop: [ALL] is required`);
	if (!(svc.security_opt ?? []).includes("no-new-privileges:true")) error(`${where}: no-new-privileges is required`);
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

// Compose interpolation: ${VAR}, ${VAR:?msg}, ...; "$$" is a literal dollar.
const templateEnv = (() => {
	const raw = template?.config?.env ?? [];
	const list = Array.isArray(raw) ? raw : Object.entries(raw).map(([k, v]) => `${k}=${v}`);
	return Object.fromEntries(list.map((e) => [String(e).split("=")[0], String(e).slice(String(e).indexOf("=") + 1)]));
})();
const composeRefs = [...blueprint.compose.replace(/\$\$/g, "").matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
for (const ref of new Set(composeRefs)) {
	if (ref !== "APP_NAME" && !(ref in templateEnv)) {
		error(`docker-compose.yml: \${${ref}} is not provided by the template env (or Dokploy's APP_NAME)`);
	}
}
for (const key of RENDER_KEYS) {
	if (!(key in templateEnv)) error(`template.toml: env must define ${key}`);
}

// Config renderer: validates the Environment and renders the mount templates.
const renderer = services[CONFIG_SERVICE];
if (!renderer) {
	error(`docker-compose.yml: service "${CONFIG_SERVICE}" (config renderer) is missing`);
} else {
	const where = `docker-compose.yml: service "${CONFIG_SERVICE}"`;
	const script = [].concat(renderer.command ?? []).join("\n");
	if (renderer.expose || renderer.ports) error(`${where}: must not expose ports`);
	if ((renderer.volumes ?? []).some((v) => String(v).startsWith("headscale-data:") || String(v).startsWith("headplane-data:"))) {
		error(`${where}: must not mount data volumes`);
	}
	for (const key of RENDER_KEYS) {
		if (!script.includes(`{{${key}}}`)) error(`${where}: does not substitute {{${key}}}`);
		if (!script.includes(`check ${key} `)) error(`${where}: does not validate ${key} before rendering`);
	}
	for (const dependant of ["headscale", "headplane"]) {
		const dep = services[dependant]?.depends_on?.[CONFIG_SERVICE];
		if (dep?.condition !== "service_completed_successfully" || dep?.restart !== true) {
			error(`docker-compose.yml: ${dependant} must depend on ${CONFIG_SERVICE} (service_completed_successfully, restart: true)`);
		}
	}
}

// Traefik labels on headplane: own, app-prefixed names; no hardcoded host;
// never reference Dokploy's generated router names (<app>-<number>-...).
const hpLabels = [].concat(services.headplane?.labels ?? []).map(String);
const traefikLabels = hpLabels.filter((l) => l.startsWith("traefik."));
if (traefikLabels.length === 0) error("docker-compose.yml: headplane needs the root-redirect / filter Traefik labels");
for (const label of traefikLabels) {
	const name = label.match(/^traefik\.http\.(?:routers|middlewares)\.([^.]+)\./)?.[1] ?? "";
	if (!name.startsWith("${APP_NAME}-headplane-")) error(`docker-compose.yml: Traefik label "${label}" must be named \${APP_NAME}-headplane-*`);
	if (/\$\{APP_NAME\}-\d/.test(label)) error(`docker-compose.yml: "${label}" references a Dokploy-generated router`);
	if (/Host\(`(?!\$\{HEADPLANE_HOST\})/.test(label)) error(`docker-compose.yml: "${label}" must use Host(\`\${HEADPLANE_HOST}\`)`);
}
if (!hpLabels.some((l) => /headplane-methods\.rule=.*!Method\(`PATCH`\)/.test(l))) {
	error("docker-compose.yml: the method filter must allow PATCH (Headplane's ACL editor saves with PATCH)");
}

// Admin helper: shares only Headscale's socket, never its database.
const admin = services[ADMIN_SERVICE];
if (!admin) {
	error(`docker-compose.yml: service "${ADMIN_SERVICE}" (Dokploy terminal bootstrap helper) is missing`);
} else {
	const where = `docker-compose.yml: service "${ADMIN_SERVICE}"`;
	const mounts = (admin.volumes ?? []).map((v) => (typeof v === "string" ? v : `${v.source}:${v.target}`));
	if (imageTags[ADMIN_SERVICE] !== `${imageTags.headscale}-debug`) {
		error(`${where}: image must be the Headscale debug image of the same version (${imageTags.headscale}-debug)`);
	}
	if (renderer && imageTags[CONFIG_SERVICE] !== `${imageTags.headscale}-debug`) {
		error(`docker-compose.yml: service "${CONFIG_SERVICE}": image must be ${imageTags.headscale}-debug`);
	}
	if (admin.expose || admin.ports) error(`${where}: must not expose or publish ports`);
	if (mounts.some((m) => m.startsWith("headscale-data:") || m.includes("/var/lib/headscale"))) {
		error(`${where}: must not mount Headscale's data volume (the CLI must go through the server)`);
	}
	if (!mounts.includes(`${SOCKET_VOLUME}:/var/run/headscale`)) error(`${where}: must mount ${SOCKET_VOLUME}:/var/run/headscale`);
	if (admin.depends_on?.headscale?.condition !== "service_healthy") error(`${where}: must depend on a healthy headscale`);
	if (admin.init !== true) error(`${where}: init: true is required so stop/start from Dokploy is immediate`);
	const ttl = Number(Array.isArray(admin.command) ? admin.command[0] : admin.command);
	if (!(String(admin.entrypoint) === "sleep" && ttl > 0 && ttl <= 4 * 3600)) {
		error(`${where}: must idle with a bounded sleep (<= 4h) and print nothing`);
	}
}
const socketVolume = compose?.volumes?.[SOCKET_VOLUME];
if (socketVolume?.driver_opts?.type !== "tmpfs") error(`docker-compose.yml: volume ${SOCKET_VOLUME} must be tmpfs-backed`);
for (const [name, svc] of Object.entries(services)) {
	const usesSocket = (svc.volumes ?? []).some((v) => String(typeof v === "string" ? v : v.source).startsWith(`${SOCKET_VOLUME}:`) || v?.source === SOCKET_VOLUME);
	if (usesSocket && !["headscale", ADMIN_SERVICE].includes(name)) {
		error(`docker-compose.yml: service "${name}" must not mount the Headscale admin socket`);
	}
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
	if (d.serviceName === "headplane" && d.path !== "/admin/") {
		error(`${where}: the headplane domain must route only path "/admin/" (other paths are answered by Traefik)`);
	}
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
	const covering = [...bindSources].find((b) => normalized === b || normalized.startsWith(`${b}/`));
	if (!covering) warn(`${where}: ${m.filePath} is not bind-mounted by any service`);
}
for (const bind of bindSources) {
	const covered = (config.mounts ?? []).some((m) => {
		const f = String(m.filePath).startsWith("/") ? m.filePath : `/${m.filePath}`;
		return f === bind || f.startsWith(`${bind}/`);
	});
	if (!covered) error(`docker-compose.yml: ../files${bind} has no [[config.mounts]] entry (Docker would create a directory)`);
}
const env = Array.isArray(config.env) ? config.env : Object.entries(config.env ?? {}).map(([k, v]) => `${k}=${v}`);
for (const [i, e] of env.entries()) checkRefs(String(e), `config.env[${i}]`);
for (const key of Object.keys(variables)) {
	if (!usedVariables.has(key)) warn(`[variables].${key} is never used`);
}
if (variables.base_domain !== "${domain}") {
	error('[variables].base_domain must stay "${domain}" in the repository; use build-import --base-domain');
}

// -- Render through Dokploy's import path + the config renderer, validate ---
// Same substitution and checks as the headscale-config service.
const DNS_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
function renderConfigTemplate(content, envValues, label) {
	const unknown = [...content.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]).filter((k) => !RENDER_KEYS.includes(k));
	for (const k of new Set(unknown)) error(`${label}: template uses {{${k}}}, which headscale-config doesn't fill in`);
	const rendered = content.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => envValues[key] ?? match);
	for (const left of new Set([...rendered.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))) {
		error(`${label}: {{${left}}} has no value in the template env`);
	}
	return rendered;
}

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

	const envValues = Object.fromEntries(t.envs.map((e) => [e.split("=")[0], e.slice(e.indexOf("=") + 1)]));
	const expect = (cond, msg) => cond || error(`${label}: ${msg}`);
	for (const key of ["HEADSCALE_HOST", "HEADPLANE_HOST", "MAGICDNS_DOMAIN"]) {
		expect(DNS_NAME.test(envValues[key] ?? ""), `env ${key}="${envValues[key]}" would be rejected by headscale-config`);
	}
	expect(/^[A-Za-z0-9]{32}$/.test(envValues.HEADPLANE_COOKIE_SECRET ?? ""), "env HEADPLANE_COOKIE_SECRET must be 32 letters or digits");

	const hosts = Object.fromEntries(t.domains.map((d) => [d.serviceName, d.host]));
	expect(hosts.headscale === envValues.HEADSCALE_HOST, "the headscale domain must equal env HEADSCALE_HOST");
	expect(hosts.headplane === envValues.HEADPLANE_HOST, "the headplane domain must equal env HEADPLANE_HOST");
	const mount = (path) => t.mounts.find((m) => m.filePath === path)?.content;

	let hsConfig;
	let hpConfig;
	try {
		hsConfig = YAML.parse(renderConfigTemplate(mount(HEADSCALE_TEMPLATE) ?? "", envValues, label));
	} catch (e) {
		error(`${label}: rendered headscale config is invalid YAML (${e.message})`);
	}
	try {
		hpConfig = YAML.parse(renderConfigTemplate(mount(HEADPLANE_TEMPLATE) ?? "", envValues, label));
	} catch (e) {
		error(`${label}: rendered headplane config is invalid YAML (${e.message})`);
	}
	if (!hsConfig || !hpConfig) {
		error(`${label}: both ${HEADSCALE_TEMPLATE} and ${HEADPLANE_TEMPLATE} mounts are required`);
		return;
	}

	expect(hsConfig.server_url === `https://${hosts.headscale}`, "headscale server_url must be https://<headscale domain>");
	expect(hsConfig.listen_addr === "0.0.0.0:8080", "headscale listen_addr must be 0.0.0.0:8080 (matches the domain port)");
	expect(String(hsConfig.metrics_listen_addr).startsWith("127.0.0.1:"), "headscale metrics must stay on loopback");
	expect(String(hsConfig.grpc_listen_addr).startsWith("127.0.0.1:"), "headscale gRPC must stay on loopback");
	expect(hsConfig.grpc_allow_insecure === false, "grpc_allow_insecure must be false");
	expect(!(hsConfig.trusted_proxies ?? []).some((c) => c === "0.0.0.0/0" || c === "::/0"), "trusted_proxies must not trust everything");
	expect(String(hsConfig.noise?.private_key_path).startsWith("/var/lib/headscale/"), "noise key must live on the data volume");
	expect(String(hsConfig.database?.sqlite?.path).startsWith("/var/lib/headscale/"), "database must live on the data volume");
	expect(hsConfig.policy?.mode === "database", "policy.mode must be database (ACL editing via Headplane)");
	const baseDomain = hsConfig.dns?.base_domain;
	expect(typeof baseDomain === "string", "headscale dns.base_domain must be a plain DNS name");
	const dnsProblem = typeof baseDomain === "string" ? checkMagicDnsDomain(hosts.headscale, baseDomain) : null;
	expect(!dnsProblem, dnsProblem);

	const secret = hpConfig.server?.cookie_secret;
	expect(typeof secret === "string" && secret.length === 32, "headplane cookie_secret must be a 32 character string");
	expect(hpConfig.server?.cookie_secure === true, "headplane cookie_secure must be true");
	expect(hpConfig.server?.base_url === `https://${hosts.headplane}`, "headplane base_url must be https://<headplane domain>");
	expect(hpConfig.headscale?.url === "http://headscale:8080", "headplane must reach headscale on the internal network");
	expect(hpConfig.headscale?.public_url === hsConfig.server_url, "headplane public_url must equal headscale server_url");
	expect(hpConfig.headscale?.config_path === "/etc/headscale/config.yaml", "headplane config_path must match the rendered file");
	expect(!hpConfig.integration?.docker?.enabled, "Docker integration must stay disabled (no socket)");

	// A second import must yield a different secret (generated, not committed).
	const again = processImport(encodeImport({ compose: blueprint.compose, config: configSource }), SAMPLE);
	const secretAgain = again.template.envs.find((e) => e.startsWith("HEADPLANE_COOKIE_SECRET="));
	expect(secretAgain !== `HEADPLANE_COOKIE_SECRET=${envValues.HEADPLANE_COOKIE_SECRET}`, "cookie secret must be generated per import");
	return hosts;
}

if (template && compose) {
	renderAndCheck("default (${domain})", blueprint.config);
	const custom = applyVariableOverrides(blueprint.config, {
		base_domain: "example.com",
		headscale_host: "hs.example.com",
	});
	const hosts = renderAndCheck("custom domain", custom);
	if (hosts && hosts.headscale !== "hs.example.com") error("custom domain: host override not applied");
	if (hosts && hosts.headplane !== "headplane.example.com") error("custom domain: derived host not applied");
}

// -- Secrets / hardcoded values in tracked text files -----------------------
const SECRET_PATTERNS = [
	[/hskey-(api|auth)-[A-Za-z0-9_-]{8,}/, "Headscale API/pre-auth key"],
	[/tskey-[a-z]+-[A-Za-z0-9]{8,}/, "Tailscale key"],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "PEM private key"],
	[/privkey:[0-9a-f]{64}/, "Headscale Noise/DERP private key"],
	[/cookie_secret:\s*"?[A-Za-z0-9]{32}"?\s*$/m, "literal Headplane cookie secret"],
	[/HEADPLANE_COOKIE_SECRET\s*=\s*"?[A-Za-z0-9]{32}"?\s*$/m, "literal Headplane cookie secret"],
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
		const expected = args["expect-base-domain"];
		if (expected) {
			const hosts = Object.fromEntries(result.template.domains.map((d) => [d.serviceName, d.host]));
			const want = { headscale: `headscale.${expected}`, headplane: `headplane.${expected}`, magicdns: `vpn.${expected}` };
			const got = { ...hosts, magicdns: result.template.variables.magicdns_domain };
			for (const [key, value] of Object.entries(want)) {
				if (got[key] !== value) error(`${args.import}: ${key} host is "${got[key]}", expected "${value}"`);
			}
		}
		console.log(`import artifact ${errors.length ? "FAILED" : "OK"}: ${relative(process.cwd(), args.import)}`);
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
