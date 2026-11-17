// 能力中心·MCP（ADR 0017）：用户级 mcp.json 的解析、校验与修改，以及 Core `mcp list --json` 输出的解析。
// 校验规则与 Core 一致（服务器名、stdio / HTTP 字段、oauth、exposure、auth、只差 - 与 _ 的名字冲突），
// 让界面在保存前就指出 Core 会拒绝的条目；文案为中文。修改只动 `mcpServers` 里的目标条目，其余内容
// （顶层的其他键、条目里不认识的字段）原样保留，按原文的缩进重写，与 Core 自己改写 mcp.json 的方式一致。
// 启用 = 删掉 `enabled` 键，停用 = 写 `enabled: false`（Core 的默认值不落盘）。

import type { CliOutput } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { fill } from "./ui";

const msg = strings.capabilityChecks.mcp;

export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
export const MCP_EXPOSURES: readonly McpExposure[] = ["codemode", "deferred", "direct", "hidden"];
/** Core 的默认暴露方式 */
export const DEFAULT_EXPOSURE: McpExposure = "codemode";
const EXPOSURE_ALIASES: Readonly<Record<string, McpExposure>> = { "codemode-deferred": "codemode" };

/** 表里自有的值；`__proto__`、`toString` 等原型上的名字不算 */
export function ownValue<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** 暴露方式的别名换成正式写法（只认自有键） */
function exposureName(v: string): string {
  return ownValue(EXPOSURE_ALIASES, v) ?? v;
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

type Obj = Record<string, unknown>;

export function isRecord(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isStringRecord = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every((x) => typeof x === "string");

const canParseUrl = (v: string): URL | null => {
  try {
    return new URL(v);
  } catch {
    return null;
  }
};

/** 服务器名的规则：字母、数字、_ 与 - */
export function validServerName(name: string): boolean {
  return SERVER_NAME.test(name);
}

/** 工具命名空间：只差 - 与 _ 的两个名字会共用一个（Core 拒绝后一个） */
export function serverNamespace(name: string): string {
  return name.replace(/-/g, "_");
}

/** 条目没有 command / url / type：只覆盖全局同名服务器的少数字段（项目文件的写法） */
export function isOverrideEntry(entry: Obj): boolean {
  return entry.command === undefined && entry.url === undefined && entry.type === undefined;
}

export type McpTransport = "stdio" | "http";

function checkBase(entry: Obj): string | null {
  const { enabled, timeout, description } = entry;
  if (enabled !== undefined && typeof enabled !== "boolean") return msg.enabledBool;
  if (description !== undefined && typeof description !== "string") return msg.descriptionString;
  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0)))
    return msg.timeoutPositive;
  return null;
}

function checkOAuth(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return msg.oauthObject;
  if (value.clientId !== undefined && typeof value.clientId !== "string") return msg.oauthClientId;
  if (value.clientSecret !== undefined && typeof value.clientSecret !== "string")
    return msg.oauthClientSecret;
  const port = value.callbackPort;
  if (
    port !== undefined &&
    (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
  )
    return msg.oauthCallbackPort;
  let callback: URL | null = null;
  if (value.callbackUrl !== undefined) {
    callback = typeof value.callbackUrl === "string" ? canParseUrl(value.callbackUrl) : null;
    if (
      callback?.protocol !== "http:" ||
      !LOOPBACK_HOSTS.includes(callback.hostname) ||
      callback.search !== "" ||
      callback.hash !== ""
    )
      return msg.oauthCallbackUrl;
    if (callback.port && port !== undefined && Number(callback.port) !== port)
      return msg.oauthPortMismatch;
  }
  if (value.scope !== undefined && typeof value.scope !== "string") return msg.oauthScope;
  if (
    value.clientName !== undefined &&
    (typeof value.clientName !== "string" || !value.clientName.trim())
  )
    return msg.oauthClientName;
  const registration = value.clientRegistration;
  if (registration !== undefined && registration !== "auto" && registration !== "dcr") {
    if (registration !== "cimd") return msg.oauthRegistration;
    if (value.clientId !== undefined || value.clientName !== undefined) return msg.oauthCimdClient;
    // Core 的客户端元数据文档只登记了回环地址上路径为 /callback 的回调
    if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback"))
      return msg.oauthCimdCallback;
  }
  const metadataUrl = value.authServerMetadataUrl;
  if (metadataUrl !== undefined) {
    const url = typeof metadataUrl === "string" ? canParseUrl(metadataUrl) : null;
    if (
      !url ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))
      )
    )
      return msg.oauthMetadataUrl;
  }
  return null;
}

function checkExposures(entry: Obj): string | null {
  const { exposure, toolExposure } = entry;
  const valid = (v: unknown) =>
    typeof v === "string" && (MCP_EXPOSURES as readonly string[]).includes(exposureName(v));
  const list = MCP_EXPOSURES.join("、");
  if (exposure !== undefined && !valid(exposure)) return fill(msg.exposure, { list });
  if (toolExposure !== undefined) {
    if (!isRecord(toolExposure)) return msg.toolExposureObject;
    for (const [tool, v] of Object.entries(toolExposure))
      if (!valid(v)) return fill(msg.toolExposure, { tool, list });
  }
  return null;
}

/**
 * 校验一个服务器条目（与 Core 的规则一致）。返回传输方式，或中文的错误说明。
 * `global` 为 false 时（项目文件）不允许 `auth`；能力中心只写用户级文件，默认 true。
 */
export function validateServer(
  name: string,
  raw: unknown,
  global = true,
): { transport: McpTransport } | { error: string } {
  const fail = (m: string) => ({ error: fill(msg.server, { name, message: m }) });
  if (!validServerName(name)) return { error: fill(msg.serverName, { name }) };
  if (!isRecord(raw)) return fail(msg.entryObject);
  const base = checkBase(raw);
  if (base) return fail(base);
  const { type, url, command } = raw;
  if (type === "sse") return fail(msg.sse);
  let transport: McpTransport;
  if (
    typeof url === "string" &&
    (type === undefined || type === "http" || type === "streamable-http")
  ) {
    const parsed = canParseUrl(url);
    if (!parsed || !/^https?:$/.test(parsed.protocol)) return fail(msg.url);
    if (raw.headers !== undefined && !isStringRecord(raw.headers)) return fail(msg.headers);
    const oauth = checkOAuth(raw.oauth);
    if (oauth) return fail(oauth);
    transport = "http";
  } else if (typeof command === "string" && (type === undefined || type === "stdio")) {
    const { args, env, cwd } = raw;
    if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === "string")))
      return fail(msg.args);
    if (env !== undefined && !isStringRecord(env)) return fail(msg.env);
    if (cwd !== undefined && typeof cwd !== "string") return fail(msg.cwd);
    transport = "stdio";
  } else {
    return fail(msg.commandOrUrl);
  }
  const exposure = checkExposures(raw);
  if (exposure) return fail(exposure);
  if (transport === "http" && raw.auth !== undefined) {
    if (!global) return fail(msg.authGlobal);
    const auth = raw.auth;
    if (!isRecord(auth) || typeof auth.provider !== "string" || !auth.provider)
      return fail(msg.authProvider);
    const parsed = new URL(url as string);
    if (parsed.protocol !== "https:" && !LOOPBACK_HOSTS.includes(parsed.hostname))
      return fail(msg.authHttps);
  }
  return { transport };
}

/** 已解析的 mcp.json */
export interface McpDocument {
  /** 整个文件的对象（会被就地修改） */
  root: Obj;
  /** 原文的缩进，重写时沿用 */
  indent: string;
}

/** mcp.json 中的一个服务器（界面列表用） */
export interface McpServerView {
  name: string;
  /** 条目原样（含不认识的字段） */
  entry: unknown;
  transport: McpTransport | null;
  /** http 地址或命令行 */
  target: string;
  enabled: boolean;
  exposure: string;
  description: string | null;
  /** Core 会拒绝这个条目的原因 */
  error: string | null;
}

/** 解析 mcp.json 原文（null 表示文件不存在）；格式不对时抛出中文错误 */
export function parseMcpDocument(text: string | null): McpDocument {
  if (text === null || text.trim() === "") return { root: {}, indent: "  " };
  let root: unknown;
  try {
    root = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Error(fill(msg.fileJson, { message: e instanceof Error ? e.message : String(e) }));
  }
  if (!isRecord(root) || (root.mcpServers !== undefined && !isRecord(root.mcpServers)))
    throw new Error(msg.fileShape);
  return { root, indent: /^([ \t]+)\S/m.exec(text)?.[1] || "  " };
}

export function serializeMcpDocument(doc: McpDocument): string {
  return `${JSON.stringify(doc.root, null, doc.indent)}\n`;
}

const serversOf = (doc: McpDocument): Obj =>
  isRecord(doc.root.mcpServers) ? doc.root.mcpServers : {};

function describeTarget(entry: unknown): string {
  if (!isRecord(entry)) return "";
  if (typeof entry.url === "string") return entry.url;
  if (typeof entry.command === "string") {
    const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === "string") : [];
    return [entry.command, ...args].join(" ");
  }
  return "";
}

/** 列出文件里的服务器，按文件中的顺序；名字冲突与 Core 一样记在后出现的那个上 */
export function listServers(doc: McpDocument): McpServerView[] {
  const seen = new Map<string, string>();
  return Object.entries(serversOf(doc)).map(([name, entry]) => {
    const result = validateServer(name, entry);
    let error = "error" in result ? result.error : null;
    if (!error) {
      const clash = seen.get(serverNamespace(name));
      if (clash) error = fill(msg.clash, { name, other: clash });
      else seen.set(serverNamespace(name), name);
    }
    const rec = isRecord(entry) ? entry : {};
    return {
      name,
      entry,
      transport: "transport" in result ? result.transport : null,
      target: describeTarget(entry),
      enabled: rec.enabled !== false,
      exposure: typeof rec.exposure === "string" ? exposureName(rec.exposure) : DEFAULT_EXPOSURE,
      description: typeof rec.description === "string" ? rec.description : null,
      error,
    };
  });
}

/** 与其他服务器的名字冲突（相同或只差 - 与 _）；`except` 是正在编辑的原名 */
export function nameConflict(doc: McpDocument, name: string, except?: string): string | null {
  const names = Object.keys(serversOf(doc)).filter((other) => other !== except);
  if (names.includes(name)) return fill(msg.exists, { name });
  for (const other of names) {
    if (serverNamespace(other) === serverNamespace(name)) return fill(msg.clashExisting, { other });
  }
  return null;
}

/**
 * 添加或替换一个服务器。`previous` 是编辑前的名字：改名时条目留在原位置。
 * 校验不通过或名字冲突时抛出中文错误；返回新的原文
 */
export function setServer(
  text: string | null,
  name: string,
  entry: Obj,
  previous?: string,
): string {
  const doc = parseMcpDocument(text);
  const result = validateServer(name, entry);
  if ("error" in result) throw new Error(result.error);
  const conflict = nameConflict(doc, name, previous);
  if (conflict) throw new Error(conflict);
  const servers = serversOf(doc);
  // 无原型对象：名为 `__proto__` 的服务器也作为普通键保留
  const next: Obj = Object.create(null);
  let placed = false;
  for (const [key, value] of Object.entries(servers)) {
    if (key === previous || key === name) {
      if (!placed) next[name] = entry;
      placed = true;
    } else next[key] = value;
  }
  if (!placed) next[name] = entry;
  doc.root.mcpServers = next;
  return serializeMcpDocument(doc);
}

/** 删除服务器；文件里没有时抛出错误 */
export function removeServer(text: string | null, name: string): string {
  const doc = parseMcpDocument(text);
  const servers = serversOf(doc);
  if (!Object.hasOwn(servers, name)) throw new Error(fill(msg.missing, { name }));
  delete servers[name];
  return serializeMcpDocument(doc);
}

/** 启用（删掉 enabled 键）或停用（enabled: false） */
export function setServerEnabled(text: string | null, name: string, enabled: boolean): string {
  const doc = parseMcpDocument(text);
  const servers = serversOf(doc);
  const entry = Object.hasOwn(servers, name) ? servers[name] : undefined;
  if (!isRecord(entry)) throw new Error(fill(msg.missing, { name }));
  if (enabled) delete entry.enabled;
  else entry.enabled = false;
  return serializeMcpDocument(doc);
}

/** 粘贴的配置里找到的服务器 */
export interface PastedServers {
  /** 名字 → 条目；单个条目没写名字时名字为空串，由界面填写 */
  servers: [string, Obj][];
  /** 转换时去掉的字段等提示 */
  notes: string[];
}

/** VS Code 条目里 Core 不认识、转换时去掉的字段 */
const VSCODE_ONLY_KEYS = ["envFile", "dev", "gallery", "version"];

/** VS Code 的环境变量引用 `${env:NAME}` */
const VSCODE_ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * 字符串映射里的 `${env:NAME}` 换成 Core 的 `${NAME}`：Core 连接时只展开 env、headers（与 oauth.clientSecret）里的
 * `$NAME` / `${NAME}`（agent-core `core/resolve-config-value.ts`），所以只换这几处。返回是否换过
 */
function convertEnvRefs(map: unknown): boolean {
  if (!isStringRecord(map)) return false;
  let changed = false;
  for (const [k, v] of Object.entries(map)) {
    const next = v.replace(VSCODE_ENV_REF, (_, n: string) => `\${${n}}`);
    if (next !== v) {
      map[k] = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * VS Code 的条目 → Core 的写法：type 为 stdio / http 时去掉，去掉 Core 不认识的字段；env / headers 里的
 * `${env:NAME}` 换成 `${NAME}`。其他字段（command、args、url、cwd）里的变量 Core 不展开，只提示
 */
function fromVsCode(name: string, entry: Obj, notes: string[]): Obj {
  const out: Obj = structuredClone(entry);
  if (out.type === "stdio" || out.type === "http") delete out.type;
  const dropped = VSCODE_ONLY_KEYS.filter((k) => k in out);
  for (const k of dropped) delete out[k];
  if (dropped.length) notes.push(fill(msg.dropped, { name, keys: dropped.join("、") }));
  const secret = isRecord(out.oauth) ? { clientSecret: out.oauth.clientSecret } : null;
  const converted = [
    convertEnvRefs(out.env),
    convertEnvRefs(out.headers),
    convertEnvRefs(secret),
  ].some(Boolean);
  if (secret && isRecord(out.oauth)) out.oauth.clientSecret = secret.clientSecret;
  if (converted) notes.push(fill(msg.vscodeEnv, { name }));
  if (/\$\{input:/.test(JSON.stringify(out))) notes.push(fill(msg.vscodeInput, { name }));
  const literalFields = ["command", "args", "url", "cwd"].filter((k) =>
    /\$\{/.test(JSON.stringify(out[k] ?? "")),
  );
  if (literalFields.length)
    notes.push(fill(msg.vscodeLiteral, { name, keys: literalFields.join("、") }));
  return out;
}

const looksLikeEntry = (v: unknown): boolean =>
  isRecord(v) && (typeof v.command === "string" || typeof v.url === "string");

/**
 * 解析粘贴的 JSON：Claude Desktop / Core 的 `{"mcpServers": {…}}`、VS Code 的 `{"servers": {…}}` 或
 * settings.json 里的 `{"mcp": {"servers": {…}}}`、`{"名字": {…}}` 形式的单条，或不带名字的单个条目
 * `{"command": …}`。允许末尾的逗号与外层缺失的花括号（从文档里复制的片段常见）。格式不认识时抛出中文错误
 */
export function parsePastedServers(input: string): PastedServers {
  const text = input.trim().replace(/,\s*$/, "");
  if (!text) throw new Error(msg.pasteEmpty);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    try {
      // 复制的片段常常是 `"name": { … }`，补上外层花括号再试
      value = JSON.parse(`{${text}}`);
    } catch {
      throw new Error(fill(msg.pasteJson, { message: e instanceof Error ? e.message : String(e) }));
    }
  }
  if (!isRecord(value)) throw new Error(msg.pasteObject);
  const notes: string[] = [];
  if (looksLikeEntry(value)) return { servers: [["", { ...value }]], notes };
  let map: unknown;
  let vscode = false;
  if (isRecord(value.mcpServers)) map = value.mcpServers;
  else if (isRecord(value.servers)) {
    map = value.servers;
    vscode = true;
  } else if (isRecord(value.mcp) && isRecord(value.mcp.servers)) {
    map = value.mcp.servers;
    vscode = true;
  } else if (Object.values(value).length > 0 && Object.values(value).every(looksLikeEntry))
    map = value;
  if (!isRecord(map)) throw new Error(msg.pasteNotFound);
  const servers: [string, Obj][] = [];
  for (const [name, entry] of Object.entries(map)) {
    if (!isRecord(entry)) throw new Error(fill(msg.pasteEntry, { name }));
    servers.push([name, vscode ? fromVsCode(name, entry, notes) : { ...entry }]);
  }
  if (servers.length === 0) throw new Error(msg.pasteNone);
  return { servers, notes };
}

/** `mcp list --json` 中的一个服务器 */
export interface McpServerReport {
  name: string;
  scope: string;
  source: string;
  enabled: boolean;
  exposure: string;
  transport: string;
  /** connected / needs-auth / failed / disabled / … */
  state: string;
  tools: string[];
  error?: string;
  authProvider?: string;
}

export interface McpListResult {
  servers: McpServerReport[];
  /** 配置错误 */
  errors: string[];
  note?: string;
}

/** 解析 `mcp list --json` 的输出（失败时退出码为 1，输出仍是 JSON）；输出不是预期格式时抛出中文错误 */
export function parseMcpList(out: CliOutput): McpListResult {
  if (out.timedOut) throw new Error(msg.listTimeout);
  const start = out.stdout.indexOf("{");
  let value: unknown;
  try {
    value = start >= 0 ? JSON.parse(out.stdout.slice(start)) : undefined;
  } catch {
    value = undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.servers)) {
    const detail = (out.stderr || out.stdout).trim().split("\n").slice(-3).join("\n");
    throw new Error(
      detail ? fill(msg.listFailed, { detail }) : fill(msg.listExit, { code: out.code ?? "-" }),
    );
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const servers = value.servers.filter(isRecord).map(
    (s): McpServerReport => ({
      name: str(s.name),
      scope: str(s.scope),
      source: str(s.source),
      enabled: s.enabled !== false,
      exposure: str(s.exposure) || DEFAULT_EXPOSURE,
      transport: str(s.transport),
      state: str(s.state),
      tools: Array.isArray(s.tools)
        ? s.tools.filter((t): t is string => typeof t === "string")
        : [],
      ...(typeof s.error === "string" ? { error: s.error } : {}),
      ...(typeof s.authProvider === "string" ? { authProvider: s.authProvider } : {}),
    }),
  );
  const errors = Array.isArray(value.errors)
    ? value.errors.filter((e): e is string => typeof e === "string")
    : [];
  return { servers, errors, ...(typeof value.note === "string" ? { note: value.note } : {}) };
}

/** 多行 `KEY=VALUE`（env）或 `Name: value`（headers）→ 对象；格式不对时抛出中文错误 */
export function parsePairs(
  text: string,
  separator: "=" | ":",
  label: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(separator);
    const key = at > 0 ? line.slice(0, at).trim() : "";
    if (!key) throw new Error(fill(msg.pair, { label, line: i + 1, separator }));
    out[key] = line.slice(at + 1).trim();
  }
  return out;
}

/** 对象 → 多行文本（parsePairs 的逆） */
export function formatPairs(value: unknown, separator: "=" | ":"): string {
  if (!isStringRecord(value)) return "";
  const join = separator === "=" ? "=" : ": ";
  return Object.entries(value)
    .map(([k, v]) => `${k}${join}${v}`)
    .join("\n");
}

/**
 * 命令行拆成参数：空白分隔，支持双引号与单引号（不做转义以外的 shell 展开）。
 * 返回 [command, ...args]；引号不配对时抛出中文错误
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (quote) throw new Error(msg.quote);
  if (has || cur) out.push(cur);
  return out;
}

/** 参数 → 显示用的命令行（含空白的参数加双引号） */
export function joinCommandLine(parts: string[]): string {
  return parts
    .map((p) => {
      if (p !== "" && !/[\s"']/.test(p)) return p;
      // 双引号包住；参数里的双引号写成 `"'"'"`（结束双引号、单引号包住的 "、再开双引号），与 splitCommandLine 无损往返
      return `"${p.replace(/"/g, `"'"'"`)}"`;
    })
    .join(" ");
}
