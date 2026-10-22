// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present Dokploy Technology, Inc. (original code)
// Modifications for this repository: ported to plain JavaScript, reduced to
// what a Compose deployment of this template uses, database access removed.
//
// What Dokploy does to a Compose file and its .env at deploy time, so that
// tests can run the stack behind a real Traefik exactly as Dokploy wires it.
//
// Sources (Dokploy/dokploy, canary @ ad22296, matching release v0.30.8):
//   packages/server/src/utils/docker/domain.ts       addDomainToCompose,
//                                                    createDomainLabels,
//                                                    addDokployNetworkToService/Root
//   packages/server/src/utils/docker/collision/root-network.ts
//                                                    isolated deployments
//   packages/server/src/utils/docker/utils.ts        prepareEnvironmentVariablesForFile
//   packages/server/src/utils/builders/compose.ts    .env header (APP_NAME, ...)
//   packages/server/src/setup/traefik-setup.ts       Traefik version and config

import YAML from "yaml";

export const TRAEFIK_VERSION = "3.6.25";

// Static configuration of Dokploy's Traefik (getDefaultTraefikConfig), minus
// ACME: tests use a self-signed default certificate instead.
export function traefikStaticConfig() {
	return {
		providers: {
			docker: { exposedByDefault: false, watch: true, network: "dokploy-network" },
			file: { directory: "/etc/dokploy/traefik/dynamic", watch: true },
		},
		entryPoints: {
			web: { address: ":80" },
			websecure: { address: ":443" },
		},
		log: { level: "INFO" },
		accessLog: {},
	};
}

// Dokploy's middlewares.yml (getDefaultMiddlewares).
export function traefikDynamicMiddlewares() {
	return {
		http: {
			middlewares: {
				"redirect-to-https": { redirectScheme: { scheme: "https", permanent: true } },
			},
		},
	};
}

export function createDomainLabels(appName, domain, entrypoint) {
	const { host, port, https, uniqueConfigKey, certificateType, path, stripPath, internalPath } =
		domain;
	const routerName = `${appName}-${uniqueConfigKey}-${entrypoint}`;
	const labels = [
		`traefik.http.routers.${routerName}.rule=Host(\`${host}\`)${path && path !== "/" ? ` && PathPrefix(\`${path}\`)` : ""}`,
		`traefik.http.routers.${routerName}.entrypoints=${entrypoint}`,
		`traefik.http.services.${routerName}.loadbalancer.server.port=${port}`,
		`traefik.http.routers.${routerName}.service=${routerName}`,
	];
	const middlewares = [];
	const isRedirectRouter = entrypoint === "web" && https;
	if (isRedirectRouter) middlewares.push("redirect-to-https@file");
	if (stripPath && path && path !== "/") {
		const name = `stripprefix-${appName}-${uniqueConfigKey}`;
		if (entrypoint === "web") labels.push(`traefik.http.middlewares.${name}.stripprefix.prefixes=${path}`);
		if (!isRedirectRouter) middlewares.push(name);
	}
	if (internalPath && internalPath !== "/" && internalPath.startsWith("/")) {
		const name = `addprefix-${appName}-${uniqueConfigKey}`;
		if (entrypoint === "web") labels.push(`traefik.http.middlewares.${name}.addprefix.prefix=${internalPath}`);
		if (!isRedirectRouter) middlewares.push(name);
	}
	if (!isRedirectRouter && domain.middlewares?.length) middlewares.push(...domain.middlewares);
	if (middlewares.length > 0) {
		labels.push(`traefik.http.routers.${routerName}.middlewares=${middlewares.join(",")}`);
	}
	if (entrypoint === "websecure") {
		if (certificateType === "letsencrypt") {
			labels.push(`traefik.http.routers.${routerName}.tls.certresolver=letsencrypt`);
		} else if (certificateType === "none" && https) {
			labels.push(`traefik.http.routers.${routerName}.tls=true`);
		}
	}
	return labels;
}

function addNetwork(networks, name, withDefault) {
	const list = networks ?? [];
	if (Array.isArray(list)) {
		if (!list.includes(name)) list.push(name);
		if (withDefault && !list.includes("default")) list.push("default");
		return list;
	}
	if (!(name in list)) list[name] = {};
	if (withDefault && !("default" in list)) list.default = {};
	return list;
}

// Applies Dokploy's domain labels and networks to a raw compose file.
// `domains` are template domains as imported (certificateType "none").
export function applyDokployDeploy(composeText, domains, { appName, isolated = false }) {
	const compose = YAML.parse(composeText);
	const networkName = isolated ? appName : "dokploy-network";

	domains.forEach((template, index) => {
		const domain = {
			certificateType: "none",
			internalPath: "/",
			stripPath: false,
			middlewares: [],
			...template,
			uniqueConfigKey: index + 1,
		};
		const service = compose.services[domain.serviceName];
		if (!service) throw new Error(`domain ${domain.host}: unknown service ${domain.serviceName}`);
		const httpLabels = createDomainLabels(appName, domain, "web");
		if (domain.https) httpLabels.push(...createDomainLabels(appName, domain, "websecure"));
		service.labels ??= [];
		if (!service.labels.includes("traefik.enable=true")) service.labels.unshift("traefik.enable=true");
		service.labels.unshift(...httpLabels);
		const networkLabel = `traefik.docker.network=${networkName}`;
		if (!service.labels.includes(networkLabel)) service.labels.unshift(networkLabel);
		if (!isolated) service.networks = addNetwork(service.networks, "dokploy-network", true);
	});

	compose.networks ??= {};
	if (isolated) {
		// addAppNameToAllServiceNames: every service joins the app network.
		for (const service of Object.values(compose.services)) {
			service.networks = addNetwork(service.networks, appName, false);
		}
		compose.networks[appName] = { name: appName, external: true };
	} else {
		compose.networks["dokploy-network"] = { external: true };
	}
	return YAML.stringify(compose);
}

// The .env Dokploy writes next to the compose file (getCreateEnvFileCommand +
// prepareEnvironmentVariablesForFile, without project/environment variables).
export function dokployEnvFile(appName, envs) {
	const lines = [`APP_NAME=${appName}`, `COMPOSE_PROJECT_NAME=${appName}`, ...envs];
	return `${lines
		.map((pair) => {
			const index = pair.indexOf("=");
			const key = pair.slice(0, index);
			const value = pair
				.slice(index + 1)
				.replace(/\\/g, "\\\\")
				.replace(/"/g, '\\"')
				.replace(/\$(?!\{[A-Za-z_][A-Za-z0-9_]*(?::?[-+?][^{}]*)?\})/g, "\\$");
			return `${key}="${value}"`;
		})
		.join("\n")}\n`;
}
