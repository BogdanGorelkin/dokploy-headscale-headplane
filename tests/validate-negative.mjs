#!/usr/bin/env node
// Proves that scripts/validate.mjs rejects common template mistakes: each case
// copies the blueprint, applies one breaking change and expects a failure
// mentioning the given text.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLUEPRINT_DIR, REPO_ROOT } from "../scripts/lib/blueprint.mjs";

const edit = (file, from, to) => (dir) => {
	const path = join(dir, file);
	const text = readFileSync(path, "utf8");
	const found = from instanceof RegExp ? from.test(text) : text.includes(from);
	if (!found) throw new Error(`fixture: "${from}" not found in ${file}`);
	writeFileSync(path, text.replace(from, to));
};

const cases = [
	// Dokploy/templates conventions
	["floating image tag", edit("docker-compose.yml", /headplane:[\w.-]+/, "headplane:latest"), "floating tag"],
	["published host port", edit("docker-compose.yml", 'expose:\n      - "3000"', 'ports:\n      - "3000:3000"'), '"ports" is not allowed'],
	["docker socket", edit("docker-compose.yml", "- headplane-data:/var/lib/headplane", "- /var/run/docker.sock:/var/run/docker.sock"), "Docker socket"],
	["container not read-only", edit("docker-compose.yml", "    read_only: true\n", ""), "read_only: true is required"],
	["meta version mismatch", edit("meta.json", /"version": "[^"]+"/, '"version": "0.0.1"'), "must match the headscale image tag"],
	["invalid TOML", edit("template.toml", "[variables]", "[variables"), "invalid TOML"],
	// Variables, domains, Environment
	["undefined variable", edit("template.toml", 'host = "${headplane_host}"', 'host = "${headplane_hots}"'), "not defined in [variables]"],
	["unknown domain service", edit("template.toml", 'serviceName = "headplane"', 'serviceName = "headplain"'), "not in compose"],
	["domain without https", edit("template.toml", 'path = "/admin/"\nhttps = true', 'path = "/admin/"'), "https = true"],
	["headplane domain routes every path", edit("template.toml", 'path = "/admin/"\n', ""), 'must route only path "/admin/"'],
	["hardcoded base domain", edit("template.toml", 'base_domain = "${domain}"', 'base_domain = "example.com"'), "must stay"],
	// Built at runtime so no secret-shaped literal is committed (gitleaks).
	["committed cookie secret", edit("template.toml", "HEADPLANE_COOKIE_SECRET=${headplane_cookie_secret}", `HEADPLANE_COOKIE_SECRET=${"0123456789abcdef".repeat(2)}`), "generated per import"],
	["short cookie secret", edit("template.toml", '"${hash:32}"', '"${hash:16}"'), "32 letters or digits"],
	["MagicDNS parent of server", edit("template.toml", 'magicdns_domain = "vpn.${base_domain}"', 'magicdns_domain = "${base_domain}"'), "parent domain"],
	["env value missing", edit("template.toml", '  "MAGICDNS_DOMAIN=${magicdns_domain}",\n', ""), "env must define MAGICDNS_DOMAIN"],
	["compose uses an undeclared variable", edit("docker-compose.yml", "${APP_NAME}-headplane-root.tls=true", "${APP_NAME}-headplane-root.tls=${ENABLE_TLS}"), "is not provided by the template env"],
	// Config renderer and templates
	["template mount missing", edit("template.toml", 'filePath = "/templates/headplane.yaml"', 'filePath = "/templates/other.yaml"'), "mounts are required"],
	["unknown template placeholder", edit("template.toml", "log:\n  level: info", "log:\n  level: {{LOG_LEVEL}}"), "doesn't fill in"],
	["renderer skips validation", edit("docker-compose.yml", /\n +check MAGICDNS_DOMAIN [^\n]+/, ""), "does not validate MAGICDNS_DOMAIN"],
	["services not restarted on Environment changes", edit("docker-compose.yml", "        restart: true\n", ""), "restart: true"],
	// Traefik routing labels
	["ACL editor's PATCH blocked", edit("docker-compose.yml", " && !Method(`PATCH`)", ""), "must allow PATCH"],
	["hardcoded host in a Traefik label", edit("docker-compose.yml", "Host(`${HEADPLANE_HOST}`)", "Host(`headplane.example.com`)"), "must use Host"],
	["label targets a Dokploy-generated router", edit("docker-compose.yml", "${APP_NAME}-headplane-root.service=noop@internal", "${APP_NAME}-1-websecure.service=noop@internal"), "Dokploy-generated router"],
	// Admin helper
	["admin helper reads the database", edit("docker-compose.yml", "      - headscale-socket:/var/run/headscale\n      - headscale-config:/etc/headscale:ro\n    # \"healthy\"", "      - headscale-socket:/var/run/headscale\n      - headscale-data:/var/lib/headscale\n      - headscale-config:/etc/headscale:ro\n    # \"healthy\""), "must not mount Headscale's data volume"],
	["admin helper exposes a port", edit("docker-compose.yml", '    command: ["3600"]', '    command: ["3600"]\n    expose:\n      - "8080"'), "must not expose"],
	["admin helper version drift", edit("docker-compose.yml", /headscale:[\d.]+-debug(\n {4}entrypoint: \["sleep"\])/, "headscale:0.0.1-debug$1"), "same version"],
	["admin helper runs forever", edit("docker-compose.yml", 'restart: "no"\n    init: true', "restart: unless-stopped\n    init: true"), "restart must be no"],
	["socket persisted on disk", edit("docker-compose.yml", "      type: tmpfs\n", ""), "must be tmpfs-backed"],
	["Headplane gets the admin socket", edit("docker-compose.yml", "      - headplane-data:/var/lib/headplane", "      - headplane-data:/var/lib/headplane\n      - headscale-socket:/var/run/headscale"), "must not mount the Headscale admin socket"],
];

let failed = 0;
for (const [name, mutate, expected] of cases) {
	const tmp = mkdtempSync(join(tmpdir(), "hshp-neg-"));
	const dir = join(tmp, "headscale-headplane");
	cpSync(BLUEPRINT_DIR, dir, { recursive: true });
	try {
		mutate(dir);
		const run = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/validate.mjs"), "--dir", dir], {
			encoding: "utf8",
		});
		const output = `${run.stdout}${run.stderr}`;
		if (run.status !== 0 && output.includes(expected)) {
			console.log(`PASS rejects ${name}`);
		} else {
			failed++;
			console.log(`FAIL ${name}: exit=${run.status}, expected "${expected}"\n${output}`);
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

const baseline = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/validate.mjs")], { encoding: "utf8" });
if (baseline.status !== 0) {
	failed++;
	console.log(`FAIL unmodified blueprint should pass:\n${baseline.stdout}`);
} else {
	console.log("PASS accepts the unmodified blueprint");
}

if (failed) process.exit(1);
console.log(`${cases.length + 1} negative/positive cases passed`);
