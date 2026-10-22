import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTemplate } from "./dokploy.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const BLUEPRINT_ID = "headscale-headplane";
export const BLUEPRINT_DIR = join(REPO_ROOT, "blueprints", BLUEPRINT_ID);

export function loadBlueprint(dir = BLUEPRINT_DIR) {
	const read = (name) => readFileSync(join(dir, name), "utf8");
	const metaPath = join(dir, "meta.json");
	return {
		dir,
		compose: read("docker-compose.yml"),
		config: read("template.toml"),
		meta: existsSync(metaPath) ? JSON.parse(read("meta.json")) : null,
	};
}

// The blueprint as committed at a git ref (for upgrade tests).
export function loadBlueprintAtRef(ref) {
	const show = (name) =>
		execFileSync("git", ["-C", REPO_ROOT, "show", `${ref}:blueprints/${BLUEPRINT_ID}/${name}`], {
			encoding: "utf8",
		});
	return { dir: null, compose: show("docker-compose.yml"), config: show("template.toml"), meta: JSON.parse(show("meta.json")) };
}

// CLI flag -> template variable. Values are written verbatim into the TOML
// [variables] table, so only strict DNS names are accepted.
export const DOMAIN_OVERRIDES = {
	"base-domain": "base_domain",
	"headscale-host": "headscale_host",
	"headplane-host": "headplane_host",
	"magicdns-domain": "magicdns_domain",
};

const HOSTNAME_RE =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function assertHostname(value, flag) {
	if (!HOSTNAME_RE.test(value)) {
		throw new Error(
			`--${flag}: "${value}" is not a valid lowercase DNS name (e.g. example.com)`,
		);
	}
}

// Rewrites `key = "..."` lines inside the [variables] table, preserving the
// rest of the file byte-for-byte.
export function applyVariableOverrides(config, overrides) {
	const lines = config.split("\n");
	const start = lines.findIndex((l) => l.trim() === "[variables]");
	if (start === -1) throw new Error("template.toml has no [variables] table");
	let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
	if (end === -1) end = lines.length;

	for (const [key, value] of Object.entries(overrides)) {
		const re = new RegExp(`^(\\s*${key}\\s*=\\s*)"[^"]*"(.*)$`);
		const index = lines.findIndex((l, i) => i > start && i < end && re.test(l));
		if (index === -1) throw new Error(`[variables].${key} not found in template.toml`);
		lines[index] = lines[index].replace(re, `$1"${value}"$2`);
	}

	const result = lines.join("\n");
	const parsed = parseTemplate(result);
	for (const [key, value] of Object.entries(overrides)) {
		if (parsed.variables[key] !== value) {
			throw new Error(`Failed to override [variables].${key}`);
		}
	}
	return result;
}

// When only --base-domain is given, the derived host names follow from the
// template's own `headscale.${base_domain}` style defaults.
export function overridesFromArgs(args) {
	const overrides = {};
	for (const [flag, variable] of Object.entries(DOMAIN_OVERRIDES)) {
		if (args[flag] === undefined) continue;
		const value = String(args[flag]).toLowerCase();
		assertHostname(value, flag);
		overrides[variable] = value;
	}
	return overrides;
}

export function parseArgs(argv, { booleans = [] } = {}) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			args._.push(arg);
			continue;
		}
		const [flag, inline] = arg.slice(2).split(/=(.*)/s, 2);
		if (booleans.includes(flag)) {
			args[flag] = true;
		} else if (inline !== undefined) {
			args[flag] = inline;
		} else if (i + 1 < argv.length) {
			args[flag] = argv[++i];
		} else {
			throw new Error(`--${flag} requires a value`);
		}
	}
	return args;
}

// Mirrors Headscale 0.29.5 isSafeServerURL (hscontrol/types/config.go).
export function checkMagicDnsDomain(serverHost, baseDomain) {
	if (serverHost === baseDomain) {
		return "dns.base_domain must differ from the server_url host";
	}
	const s = serverHost.split(".");
	const b = baseDomain.split(".");
	if (s.length <= b.length) return null;
	for (let i = 0; i < b.length; i++) {
		if (s[s.length - i - 1] !== b[b.length - i - 1]) return null;
	}
	return "dns.base_domain must not be a parent domain of the server_url host";
}
