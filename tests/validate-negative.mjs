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
	["floating image tag", edit("docker-compose.yml", /headplane:[\w.-]+/, "headplane:latest"), "floating tag"],
	["published host port", edit("docker-compose.yml", 'expose:\n      - "3000"', 'ports:\n      - "3000:3000"'), '"ports" is not allowed'],
	["docker socket", edit("docker-compose.yml", "- headplane-data:/var/lib/headplane", "- /var/run/docker.sock:/var/run/docker.sock"), "Docker socket"],
	["undefined variable", edit("template.toml", 'host = "${headplane_host}"', 'host = "${headplane_hots}"'), "not defined in [variables]"],
	["unknown domain service", edit("template.toml", 'serviceName = "headplane"', 'serviceName = "headplain"'), "not in compose"],
	["domain without https", edit("template.toml", 'port = 3000\nhost = "${headplane_host}"\nhttps = true', 'port = 3000\nhost = "${headplane_host}"'), "https = true"],
	["missing mount", edit("template.toml", 'filePath = "/etc/headplane/config.yaml"', 'filePath = "/etc/headplane/other.yaml"'), "has no [[config.mounts]] entry"],
	["hardcoded base domain", edit("template.toml", 'base_domain = "${domain}"', 'base_domain = "example.com"'), "must stay"],
	["committed cookie secret", edit("template.toml", '"${headplane_cookie_secret}"', '"0123456789abcdef0123456789abcdef"'), "generated per import"],
	["short cookie secret", edit("template.toml", '"${hash:32}"', '"${hash:16}"'), "32 character"],
	["meta version mismatch", edit("meta.json", /"version": "[^"]+"/, '"version": "0.0.1"'), "must match the headscale image tag"],
	["MagicDNS parent of server", edit("template.toml", 'magicdns_domain = "vpn.${base_domain}"', 'magicdns_domain = "${base_domain}"'), "parent domain"],
	["invalid TOML", edit("template.toml", "[variables]", "[variables"), "invalid TOML"],
	["admin helper reads the database", edit("docker-compose.yml", "      - headscale-socket:/var/run/headscale\n      - ../files/etc/headscale/config.yaml:/etc/headscale/config.yaml:ro\n    # \"healthy\"", "      - headscale-socket:/var/run/headscale\n      - headscale-data:/var/lib/headscale\n      - ../files/etc/headscale/config.yaml:/etc/headscale/config.yaml:ro\n    # \"healthy\""), "must not mount Headscale's data volume"],
	["admin helper exposes a port", edit("docker-compose.yml", '    command: ["3600"]', '    command: ["3600"]\n    expose:\n      - "8080"'), "must not expose"],
	["admin helper version drift", edit("docker-compose.yml", /headscale:[\d.]+-debug/, "headscale:0.29.4-debug"), "same version"],
	["admin helper runs forever", edit("docker-compose.yml", 'restart: "no"', "restart: unless-stopped"), 'restart must be no'],
	["socket persisted on disk", edit("docker-compose.yml", "      type: tmpfs\n", ""), "must be tmpfs-backed"],
	["Headplane gets the admin socket", edit("docker-compose.yml", "      - headplane-data:/var/lib/headplane", "      - headplane-data:/var/lib/headplane\n      - headscale-socket:/var/run/headscale"), "must not mount the Headscale admin socket"],
	["container not read-only", edit("docker-compose.yml", "    read_only: true\n    security_opt:\n      - no-new-privileges:true\n    cap_drop:\n      - ALL\n    tmpfs:\n      - /tmp\n    depends_on:\n      headscale:", "    security_opt:\n      - no-new-privileges:true\n    cap_drop:\n      - ALL\n    tmpfs:\n      - /tmp\n    depends_on:\n      headscale:"), "read_only: true is required"],
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
