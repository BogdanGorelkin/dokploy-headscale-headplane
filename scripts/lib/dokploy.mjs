// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present Dokploy Technology, Inc. (original code)
// Modifications for this repository: ported to plain JavaScript, faker-based
// username/email generation replaced by a simple random name.
//
// Faithful port of Dokploy's template processing, so that local validation,
// rendering and the Base64 import behave exactly like a real Dokploy server.
//
// Sources (Dokploy/dokploy, canary @ e0c8d80, matching release v0.30.8):
//   packages/server/src/templates/processors.ts  processValue, processVariables,
//                                                processDomains, processEnvVars,
//                                                processMounts, processTemplate
//   packages/server/src/templates/index.ts       generate* helpers
//   apps/dokploy/server/api/routers/compose.ts   import: decode Base64 -> JSON ->
//                                                TOML parse, APP_NAME injection
// Import string format (Dokploy/templates app/src/components/TemplateDialog.tsx):
//   base64(utf8(JSON.stringify({ compose, config }, null, 2)))
//
// Only deterministic test fixtures differ: callers may pass a `random` source
// so rendered output is reproducible in tests.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import toml from "toml";

export const DOKPLOY_REFERENCE = "Dokploy/dokploy@e0c8d80 (v0.30.8)";

export function generateRandomDomain({ serverIp, projectName }) {
	const hash = randomBytes(3).toString("hex");
	const effectiveIp = serverIp || "127.0.0.1";
	const slugIp = effectiveIp.replaceAll(".", "-").replaceAll(":", "-");
	const maxProjectNameLength = 40;
	const truncatedProjectName =
		projectName.length > maxProjectNameLength
			? projectName.substring(0, maxProjectNameLength)
			: projectName;
	return `${truncatedProjectName}-${hash}-${slugIp}.sslip.io`;
}

export function generateHash(length = 8) {
	return randomBytes(Math.ceil(length / 2))
		.toString("hex")
		.substring(0, length);
}

// Dokploy uses Math.random() here (not a CSPRNG); templates should prefer
// ${hash:N} or ${base64:N} for secrets.
export function generatePassword(quantity = 16) {
	const characters =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let password = "";
	for (let i = 0; i < quantity; i++) {
		password += characters.charAt(
			Math.floor(Math.random() * characters.length),
		);
	}
	return password.toLowerCase();
}

export function generateBase64(bytes = 32) {
	return randomBytes(bytes).toString("base64");
}

function safeBase64(str) {
	return str.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function objToJWTBase64(obj) {
	return safeBase64(
		Buffer.from(JSON.stringify(obj), "utf8").toString("base64"),
	);
}

export function generateJwt(options = {}) {
	let { length, secret, payload = {} } = options;
	if (length) {
		return randomBytes(length).toString("hex");
	}
	const encodedHeader = objToJWTBase64({ alg: "HS256", typ: "JWT" });
	if (!payload.iss) payload.iss = "dokploy";
	if (!payload.iat) payload.iat = Math.floor(Date.now() / 1000);
	if (!payload.exp) {
		payload.exp = Math.floor(new Date("2030-01-01T00:00:00Z").getTime() / 1000);
	}
	const encodedPayload = objToJWTBase64({
		iat: Math.floor(Date.now() / 1000),
		exp: Math.floor(new Date("2030-01-01T00:00:00Z").getTime() / 1000),
		...payload,
	});
	if (!secret) secret = randomBytes(32).toString("hex");
	const signature = safeBase64(
		createHmac("SHA256", secret)
			.update(`${encodedHeader}.${encodedPayload}`)
			.digest("base64"),
	);
	return `${encodedHeader}.${encodedPayload}.${signature}`;
}

// Fake usernames/emails: Dokploy uses @faker-js/faker; the exact values do not
// matter for validation, only that the placeholder is resolved.
function fakeUsername() {
	return `user${randomBytes(3).toString("hex")}`;
}

export function processValue(value, variables, schema) {
	let processedValue = value?.replace(/\${([^}]+)}/g, (match, varName) => {
		if (varName === "domain") return generateRandomDomain(schema);
		if (varName === "base64") return generateBase64(32);
		if (varName.startsWith("base64:")) {
			const length = Number.parseInt(varName.split(":")[1], 10) || 32;
			return generateBase64(length);
		}
		if (varName.startsWith("password:")) {
			const length = Number.parseInt(varName.split(":")[1], 10) || 16;
			return generatePassword(length);
		}
		if (varName === "password") return generatePassword(16);
		if (varName.startsWith("hash:")) {
			const length = Number.parseInt(varName.split(":")[1], 10) || 8;
			return generateHash(length);
		}
		if (varName === "hash") return generateHash();
		if (varName === "uuid") return randomUUID();
		if (varName === "timestamp" || varName === "timestampms") {
			return Date.now().toString();
		}
		if (varName === "timestamps") {
			return Math.round(Date.now() / 1000).toString();
		}
		if (varName.startsWith("timestampms:")) {
			return new Date(varName.slice(12)).getTime().toString();
		}
		if (varName.startsWith("timestamps:")) {
			return Math.round(new Date(varName.slice(11)).getTime() / 1000).toString();
		}
		if (varName === "randomPort") {
			return Math.floor(Math.random() * 65535).toString();
		}
		if (varName === "jwt") return generateJwt();
		if (varName.startsWith("jwt:")) {
			const params = varName.split(":").slice(1);
			if (params.length === 1 && params[0] && params[0].match(/^\d{1,3}$/)) {
				return generateJwt({ length: Number.parseInt(params[0], 10) });
			}
			let [secret, payload] = params;
			if (typeof payload === "string" && variables[payload]) {
				payload = variables[payload];
			}
			if (
				typeof payload === "string" &&
				payload.trimStart().startsWith("{") &&
				payload.trimEnd().endsWith("}")
			) {
				try {
					payload = JSON.parse(payload);
				} catch {
					payload = undefined;
				}
			}
			if (typeof payload !== "object") payload = undefined;
			return generateJwt({
				secret: secret ? variables[secret] || secret : undefined,
				payload,
			});
		}
		if (varName === "username") return fakeUsername();
		if (varName === "email") return `${fakeUsername()}@example.com`;
		return varName in variables ? (variables[varName] ?? match) : match;
	});

	processedValue = processedValue.replace(/\${([^}]+)}/g, (match, varName) => {
		return varName in variables ? (variables[varName] ?? match) : match;
	});

	return processedValue;
}

export function processVariables(template, schema) {
	const variables = {};
	for (const [key, value] of Object.entries(template.variables ?? {})) {
		if (typeof value !== "string") continue;
		if (value === "${domain}") {
			variables[key] = generateRandomDomain(schema);
		} else if (value.startsWith("${base64:")) {
			const match = value.match(/\${base64:(\d+)}/);
			variables[key] = generateBase64(match?.[1] ? Number.parseInt(match[1], 10) : 32);
		} else if (value.startsWith("${password:")) {
			const match = value.match(/\${password:(\d+)}/);
			variables[key] = generatePassword(match?.[1] ? Number.parseInt(match[1], 10) : 16);
		} else if (value === "${hash}") {
			variables[key] = generateHash();
		} else if (value.startsWith("${hash:")) {
			const match = value.match(/\${hash:(\d+)}/);
			variables[key] = generateHash(match?.[1] ? Number.parseInt(match[1], 10) : 8);
		} else {
			variables[key] = value;
		}
	}
	for (const [key, value] of Object.entries(variables)) {
		variables[key] = processValue(value, variables, schema);
	}
	return variables;
}

export function processDomains(template, variables, schema) {
	const domains = template?.config?.domains;
	if (!domains || domains.length === 0 || domains.every((d) => !d.serviceName)) {
		return [];
	}
	return domains.map((domain) => ({
		...domain,
		host: domain.host
			? processValue(domain.host, variables, schema)
			: generateRandomDomain(schema),
	}));
}

export function processEnvVars(template, variables, schema) {
	const env = template?.config?.env;
	if (!env || Object.keys(env).length === 0) return [];
	if (Array.isArray(env)) {
		return env.map((entry) => {
			if (typeof entry === "string") return processValue(entry, variables, schema);
			if (typeof entry === "object" && entry !== null) {
				const keys = Object.keys(entry);
				if (keys.length > 0) return `${keys[0]}=${entry[keys[0]]}`;
			}
			return String(entry);
		});
	}
	return Object.entries(env).map(([key, value]) =>
		typeof value === "string"
			? `${key}=${processValue(value, variables, schema)}`
			: `${key}=${value}`,
	);
}

export function processMounts(template, variables, schema) {
	const mounts = template?.config?.mounts;
	if (!mounts || mounts.length === 0 || mounts.every((m) => !m.filePath && !m.content)) {
		return [];
	}
	return mounts.map((mount) => ({
		filePath: processValue(mount.filePath, variables, schema),
		content: processValue(mount.content, variables, schema),
	}));
}

export function processTemplate(template, schema) {
	const variables = processVariables(template, schema);
	return {
		variables,
		domains: processDomains(template, variables, schema),
		envs: processEnvVars(template, variables, schema),
		mounts: processMounts(template, variables, schema),
	};
}

// What Dokploy's compose router does with an import string (`import` and
// `previewTemplate` mutations): decode, parse, inject APP_NAME, process.
export function processImport(base64, { appName, serverIp }) {
	const decoded = Buffer.from(base64, "base64").toString("utf-8");
	const templateData = JSON.parse(decoded);
	const config = toml.parse(templateData.config);
	if (!templateData.compose || !config) {
		throw new Error("Invalid template format. Must contain compose and config fields");
	}
	const configModified = {
		...config,
		variables: { APP_NAME: appName, ...config.variables },
	};
	return {
		compose: templateData.compose,
		config: templateData.config,
		template: processTemplate(configModified, { serverIp, projectName: appName }),
	};
}

export function encodeImport({ compose, config }) {
	const json = JSON.stringify({ compose, config }, null, 2);
	return Buffer.from(json, "utf-8").toString("base64");
}

export function parseTemplate(source) {
	return toml.parse(source);
}
