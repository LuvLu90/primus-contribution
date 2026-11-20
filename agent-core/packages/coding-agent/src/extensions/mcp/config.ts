/**
 * MCP server configuration.
 *
 * Servers are read from two levels, each made of two files of equal rank:
 * - global: `mcp.json` in the agent directory and `~/.agents/mcp.json`;
 * - project (trusted projects only): `<project>/.primus/mcp.json` and `<project>/.agents/mcp.json`
 *   (only the working directory itself, parent directories are not searched).
 * All use the `mcpServers` shape shared by other MCP clients, so existing configurations can be copied
 * over. Project entries replace global entries with the same name.
 *
 * Within a level the two files must not define the same server (names that differ only in `-` and `_`
 * count as the same). The `.primus` / agent directory file is read first and wins; the `.agents` entry
 * is skipped and reported in `errors`. The same holds for two overrides of one server and for differing
 * `autoEnableCodemode` values.
 *
 * An entry without `command`, `url`, or `type` overrides only `enabled`, `exposure`, and `toolExposure`
 * of a server defined below it: a project entry overrides a global server (or one from the project's
 * `.agents/mcp.json`), for example to turn it off in one project:
 * `{ "mcpServers": { "internal-tools": { "enabled": false } } }`. The rest of the entry is kept,
 * including credentials the project could not set itself. The agent directory's `mcp.json` can likewise
 * override a server from `~/.agents/mcp.json`.
 *
 * Primus never writes `.agents/mcp.json` files: `/mcp` saves changes of their servers as overrides in
 * `.primus/mcp.json` (project) or the agent directory's `mcp.json` (global), see `overrideTarget`.
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
 *     "sentry": { "url": "https://mcp.sentry.dev/mcp" }
 *   }
 * }
 * ```
 *
 * HTTP servers without an `Authorization` header use OAuth when they answer 401 (sign in with `/mcp`).
 * `"auth": { "provider": "<provider>" }` sends the token of a `/login` provider instead. Only the global
 * files can use it, so a repository cannot pick where the credential goes.
 *
 * The top-level `autoEnableCodemode` (default true) activates the codemode tool when a server
 * with `codemode` exposure connects. A project value overrides the global one.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isMcpServerOverride, mcpNamespace } from "@earendil-works/pi-mcp";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { type McpExposure, type McpServerConfig, validateMcpServerConfig } from "../../core/mcp-servers.ts";
import { stripBom } from "../../utils/text.ts";

export type {
	McpExposure,
	McpHttpServerConfig,
	McpOAuthConfig,
	McpServerConfig,
	McpStdioServerConfig,
} from "../../core/mcp-servers.ts";
export { getMcpToolExposure } from "../../core/mcp-servers.ts";

/** Directory of the shared, client-neutral agent configuration (`.agents/mcp.json`). */
export const AGENTS_DIR_NAME = ".agents";

export interface McpServerEntry {
	name: string;
	config: McpServerConfig;
	/** Config file that defined the entry, or the path of the extension that registered it. */
	source: string;
	/**
	 * The global or the project level, or `extension` for servers registered with
	 * `pi.registerMcpServer()`. Changes to extension servers are not saved.
	 */
	scope?: "global" | "project" | "extension";
	/**
	 * `mcp.json` with an override of this server's `enabled`, `exposure`, or `toolExposure`: the project
	 * `.primus/mcp.json`, or the agent directory's `mcp.json` for a server from `~/.agents/mcp.json`.
	 */
	override?: string;
	/**
	 * Set when `source` is an `.agents/mcp.json`, which is never written: the file `/mcp` saves this
	 * server's changes to as an override (`.primus/mcp.json` of the project, or the agent directory's
	 * `mcp.json`).
	 */
	overrideTarget?: string;
}

export interface LoadedMcpConfig {
	servers: McpServerEntry[];
	/** Activate the codemode tool when `codemode` servers connect. Default: true. */
	autoEnableCodemode?: boolean;
	errors: string[];
	/** The project `mcp.json` when the project is trusted, where `/mcp` saves project overrides. */
	projectConfig?: string;
}

const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Home directory `~/.agents/mcp.json` is read from, resolved as the package manager does. */
export function getMcpHomeDir(): string {
	return process.env.HOME || homedir();
}

/** The `.agents/mcp.json` in a directory (the home directory or a project). */
export function getAgentsMcpConfigPath(dir: string): string {
	return join(dir, AGENTS_DIR_NAME, "mcp.json");
}

/** Whether a config path is an `.agents/mcp.json`, which Primus reads but never writes. */
export function isAgentsMcpConfig(path: string): boolean {
	return resolve(path) === resolve(getAgentsMcpConfigPath(dirname(dirname(resolve(path)))));
}

/** Whether an `mcp.json` has an entry named `name` (a server or an override). False when unreadable. */
export function definesMcpServer(path: string, name: string): boolean {
	if (!existsSync(path)) return false;
	try {
		const parsed: unknown = JSON.parse(stripBom(readFileSync(path, "utf8")));
		return isRecord(parsed) && isRecord(parsed.mcpServers) && parsed.mcpServers[name] !== undefined;
	} catch {
		return false;
	}
}

interface McpConfigState {
	servers: Map<string, McpServerEntry>;
	autoEnableCodemode?: boolean;
	errors: string[];
}

interface ParsedConfigFile {
	path: string;
	servers: [string, unknown][];
	autoEnableCodemode?: boolean;
}

function parseConfigFile(path: string, errors: string[]): ParsedConfigFile | undefined {
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
	} catch (error) {
		errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		errors.push(`${path}: expected an object with an "mcpServers" object`);
		return undefined;
	}
	const file: ParsedConfigFile = { path, servers: Object.entries(parsed.mcpServers ?? {}) };
	if (typeof parsed.autoEnableCodemode === "boolean") file.autoEnableCodemode = parsed.autoEnableCodemode;
	else if (parsed.autoEnableCodemode !== undefined) errors.push(`${path}: autoEnableCodemode must be a boolean`);
	return file;
}

/** One file of a level. `overrideTarget` is set for `.agents/mcp.json`, which is never written. */
interface LevelFile {
	path: string;
	overrideTarget?: string;
}

/**
 * Read one level (global or project): its main file first, then its `.agents/mcp.json`. Entries of the
 * `.agents` file that the main file already defines or overrides are skipped and reported.
 */
function readConfigLevel(files: LevelFile[], scope: "global" | "project", state: McpConfigState): void {
	const { servers, errors } = state;
	const parsed = files.flatMap((file) => {
		const result = parseConfigFile(file.path, errors);
		return result ? [{ ...result, overrideTarget: file.overrideTarget }] : [];
	});

	let codemode: { value: boolean; path: string } | undefined;
	for (const file of parsed) {
		if (file.autoEnableCodemode === undefined) continue;
		if (!codemode) codemode = { value: file.autoEnableCodemode, path: file.path };
		else if (codemode.value !== file.autoEnableCodemode) {
			errors.push(`${file.path}: autoEnableCodemode conflicts with ${codemode.path}, which is used`);
		}
	}
	if (codemode) state.autoEnableCodemode = codemode.value;

	/** Namespace of every server this level defines or overrides, with the file and name that did. */
	const claimed = new Map<string, { path: string; name: string }>();
	const claim = (path: string, name: string): boolean => {
		const other = claimed.get(mcpNamespace(name));
		if (other && other.path !== path) {
			errors.push(
				other.name === name
					? `${path}: server "${name}" is also defined in ${other.path}, which is used`
					: `${path}: server "${name}" conflicts with "${other.name}" in ${other.path}, which is used`,
			);
			return false;
		}
		claimed.set(mcpNamespace(name), { path, name });
		return true;
	};
	const isOverride = (value: unknown): value is Record<string, unknown> =>
		isRecord(value) && isMcpServerOverride(value);

	// Full definitions first, so the main file can override a server of the level's `.agents` file.
	for (const file of parsed) {
		for (const [name, value] of file.servers) {
			if (isOverride(value)) continue;
			if (!claim(file.path, name)) continue;
			const config = validateMcpServerConfig(name, value);
			if (typeof config === "string") {
				errors.push(`${file.path}: ${config}`);
				continue;
			}
			// Names that differ only in `-` and `_` would share a namespace.
			const clash = [...servers.keys()].find(
				(other) => other !== name && mcpNamespace(other) === mcpNamespace(name),
			);
			if (clash) {
				errors.push(`${file.path}: server "${name}" conflicts with "${clash}"`);
				continue;
			}
			if (scope === "project" && "url" in config && config.auth) {
				errors.push(`${file.path}: server "${name}": auth is only allowed in the global mcp.json`);
				continue;
			}
			servers.set(name, {
				name,
				config,
				source: file.path,
				scope,
				...(file.overrideTarget ? { overrideTarget: file.overrideTarget } : {}),
			});
		}
	}

	const overridden = new Map<string, string>();
	for (const file of parsed) {
		for (const [name, value] of file.servers) {
			if (!isOverride(value)) continue;
			const definedHere = claimed.get(mcpNamespace(name));
			// An `.agents` file can only override a server of the level below; the main file may also
			// override the servers of the level's `.agents` file.
			if (definedHere && (file.overrideTarget !== undefined || definedHere.path === file.path)) {
				errors.push(`${file.path}: server "${name}" is also defined in ${definedHere.path}, which is used`);
				continue;
			}
			const otherOverride = overridden.get(mcpNamespace(name));
			if (otherOverride) {
				errors.push(`${file.path}: server "${name}" is also overridden in ${otherOverride}, which is used`);
				continue;
			}
			overridden.set(mcpNamespace(name), file.path);
			const base = servers.get(name);
			const extra = Object.keys(value).filter((key) => !OVERRIDE_KEYS.includes(key));
			if (!base) {
				errors.push(
					scope === "project"
						? `${file.path}: server "${name}" needs "command" or "url", or a global server to override`
						: `${file.path}: server "${name}" needs "command" or "url", or a server in ~/${AGENTS_DIR_NAME}/mcp.json to override`,
				);
			} else if (extra.length > 0) {
				errors.push(`${file.path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`);
			} else {
				const config = validateMcpServerConfig(name, { ...base.config, ...value });
				if (typeof config === "string") errors.push(`${file.path}: ${config}`);
				else servers.set(name, { ...base, config, override: file.path });
			}
		}
	}
}

/**
 * Load global and (when trusted) project MCP configuration. Disabled servers are included with
 * `enabled: false`, so they can be enabled again. `homeDir` (default: the user's home directory) is
 * where `~/.agents/mcp.json` is read from.
 */
export function loadMcpConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	homeDir?: string;
}): LoadedMcpConfig {
	const state: McpConfigState = { servers: new Map(), errors: [] };
	const globalConfig = join(options.agentDir, "mcp.json");
	const globalAgentsConfig = getAgentsMcpConfigPath(options.homeDir ?? getMcpHomeDir());
	readConfigLevel(
		[{ path: globalConfig }, { path: globalAgentsConfig, overrideTarget: globalConfig }],
		"global",
		state,
	);
	const projectConfig = options.projectTrusted ? join(options.cwd, CONFIG_DIR_NAME, "mcp.json") : undefined;
	if (projectConfig) {
		const projectAgentsConfig = getAgentsMcpConfigPath(options.cwd);
		// In the home directory the project's `.agents/mcp.json` is the global one, already read.
		const projectFiles: LevelFile[] =
			resolve(projectAgentsConfig) === resolve(globalAgentsConfig)
				? [{ path: projectConfig }]
				: [{ path: projectConfig }, { path: projectAgentsConfig, overrideTarget: projectConfig }];
		readConfigLevel(projectFiles, "project", state);
	}
	return {
		servers: [...state.servers.values()],
		...(state.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: state.autoEnableCodemode }),
		errors: state.errors,
		...(projectConfig ? { projectConfig } : {}),
	};
}

/**
 * The file `/mcp` saves a change of `entry` to, and whether it is saved as an override there. Never an
 * `.agents/mcp.json`: their servers get an override in `overrideTarget`.
 */
export function getMcpConfigWriteTarget(entry: McpServerEntry): { path: string; override: boolean } {
	const override = entry.override ?? entry.overrideTarget;
	return override ? { path: override, override: true } : { path: entry.source, override: false };
}

/** Settings `/mcp` changes. `enabled: true` and `exposure: "codemode"` are the defaults and remove the key. */
export interface McpServerConfigPatch {
	enabled?: boolean;
	exposure?: McpExposure;
}

/**
 * Change one server's settings in the `mcp.json` that defines or overrides it. With `override`, a
 * missing entry is added as an override. Overrides keep default values, since they replace the global
 * server's. Other content is kept; the file is rewritten with its indentation.
 */
export function updateMcpServerConfig(
	path: string,
	name: string,
	patch: McpServerConfigPatch,
	options: { override?: boolean } = {},
): void {
	editMcpServers(path, (servers, parsed) => {
		let server = servers?.[name];
		if (server === undefined && options.override) {
			server = {};
			parsed.mcpServers = { ...servers, [name]: server };
		}
		if (!isRecord(server)) throw new Error(`${path} does not define MCP server "${name}"`);
		const keepDefaults = isMcpServerOverride(server);
		if (patch.enabled !== undefined) {
			if (patch.enabled && !keepDefaults) delete server.enabled;
			else server.enabled = patch.enabled;
		}
		if (patch.exposure !== undefined) {
			if (patch.exposure === "codemode" && !keepDefaults) delete server.exposure;
			else server.exposure = patch.exposure;
		}
		return true;
	});
}

/**
 * Add a server to an `mcp.json`, creating the file when missing. An existing entry with the same
 * name is replaced. Returns true when an entry was replaced.
 */
export function addMcpServerConfig(path: string, name: string, config: McpServerConfig): boolean {
	let replaced = false;
	editMcpServers(path, (servers, parsed) => {
		const target = servers ?? {};
		replaced = target[name] !== undefined;
		target[name] = config;
		parsed.mcpServers = target;
		return true;
	});
	return replaced;
}

/** Remove a server from an `mcp.json`. Returns false when the file does not define it. */
export function removeMcpServerConfig(path: string, name: string): boolean {
	if (!existsSync(path)) return false;
	let removed = false;
	editMcpServers(path, (servers) => {
		if (!servers || servers[name] === undefined) return false;
		delete servers[name];
		removed = true;
		return true;
	});
	return removed;
}

/**
 * Read an `mcp.json` (an empty config when missing), let `edit` change its `mcpServers`, and write
 * it back with its indentation when `edit` returns true. Other content is kept. Refuses
 * `.agents/mcp.json`, which is read but never written.
 */
function editMcpServers(
	path: string,
	edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): void {
	if (isAgentsMcpConfig(path)) {
		throw new Error(`${path} is shared with other agents and is never edited; save an override instead`);
	}
	const text = existsSync(path) ? stripBom(readFileSync(path, "utf8")) : undefined;
	const parsed: unknown = text === undefined ? {} : JSON.parse(text);
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		throw new Error(`${path}: expected an object with an "mcpServers" object`);
	}
	const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
	if (!edit(servers, parsed)) return;
	const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(parsed, null, indent)}\n`);
}
