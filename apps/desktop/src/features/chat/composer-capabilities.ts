// “+”菜单里的技能与 MCP：列出全局（Core 用户目录 `skills/`、`~/.agents/skills`、用户级 mcp.json、`~/.agents/mcp.json`）
// 与当前项目（已信任工作区的 `.primus/skills`、`.agents/skills`、`.primus/mcp.json`、`.agents/mcp.json`）里会被 Core
// 加载的技能与 MCP 服务器。同级两个 mcp.json 冲突时与 Core 一样取 `.primus` / 用户级那一条（ADR 0022）。
// 选中的项以“/名称”标签挂在输入框上方，发送时在消息开头注明要使用哪些技能与 MCP。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isApplicableOverride,
  isOverrideEntry,
  isRecord,
  listServers,
  listSharedServers,
  type McpDocument,
  type McpServerView,
  parseMcpDocument,
  serverNamespace,
  validateServer,
} from "@/features/capabilities/mcp-config";
import { checkSkill } from "@/features/capabilities/skill-frontmatter";
import { fill } from "@/features/capabilities/ui";
import { getPlatform } from "@/lib/platform";
import type { WorkspaceInfo } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { baseName } from "./composer-menus";

export type CapabilityKind = "skill" | "mcp";
export type CapabilityScope = "global" | "project";

export interface ComposerCapability {
  kind: CapabilityKind;
  name: string;
  scope: CapabilityScope;
  description: string | null;
}

/** 选中项的唯一键（同名的技能与 MCP 服务器互不冲突） */
export const capabilityKey = (c: Pick<ComposerCapability, "kind" | "name">) =>
  `${c.kind}:${c.name}`;

/** 去重（同类同名只留第一个：项目的排在全局之前，与 Core 项目优先一致），各类内按名称排序，项目的在前 */
export function mergeCapabilities(items: ComposerCapability[]): ComposerCapability[] {
  const seen = new Set<string>();
  const unique = items.filter((c) => {
    const key = capabilityKey(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const order = (c: ComposerCapability) => (c.scope === "project" ? 0 : 1);
  return unique.sort(
    (a, b) => a.kind.localeCompare(b.kind) || order(a) - order(b) || a.name.localeCompare(b.name),
  );
}

async function globalSkills(): Promise<ComposerCapability[]> {
  const list = await (await getPlatform()).skillsList();
  return list.flatMap((s) => {
    if (!s.enabled) return [];
    const check = checkSkill(s.content ?? "", s.dirName);
    // Core 不会加载的技能不列出
    if (check.errors.length > 0) return [];
    return [{ kind: "skill", name: check.name, scope: "global", description: check.description }];
  });
}

/** 解析 mcp.json 原文；不存在、无效时为 null（Core 不加载其中的服务器） */
function tryParse(text: string | null | undefined): McpDocument | null {
  if (text === null || text === undefined) return null;
  try {
    return parseMcpDocument(text);
  } catch {
    return null;
  }
}

/** 一级（全局或项目）的 MCP：Core 会加载的服务器（含停用的，用于遮蔽下一级同名服务器），与改下一级服务器的覆盖项 */
export interface McpLevel {
  scope: CapabilityScope;
  /** 本级通过校验的服务器（已套用同级覆盖项） */
  servers: McpServerView[];
  /** 本级没定义、留给下一级同名服务器的覆盖项（只含 enabled / exposure / toolExposure，同命名空间只取第一个） */
  overrides: Map<string, Record<string, unknown>>;
}

const serversIn = (doc: McpDocument | null): [string, unknown][] =>
  doc && isRecord(doc.root.mcpServers) ? Object.entries(doc.root.mcpServers) : [];

/**
 * 同级两个文件里 Core 会加载的服务器：主文件（用户级 mcp.json 或 `.primus/mcp.json`）的服务器，加上 `.agents/mcp.json`
 * 里没被主文件同名定义的服务器（套用主文件的覆盖项）。停用的也保留：项目级的停用条目要遮蔽全局同名服务器，
 * 跨级合并（{@link mergeMcpLevels}）之后才过滤
 */
export function levelServers(
  primary: McpDocument | null,
  shared: McpDocument | null,
  scope: CapabilityScope,
): McpLevel {
  const views: McpServerView[] = [
    ...(primary ? listServers(primary, shared) : []),
    ...(shared
      ? listSharedServers(shared, primary, {
          global: scope === "global",
          primaryFile: scope === "global" ? "mcp.json" : ".primus/mcp.json",
        })
      : []),
  ];
  // 与 Core 的 readConfigLevel 一致：本级完整定义（不论是否有效）登记命名空间；其余覆盖项改下一级的服务器，
  // 先出现（主文件优先）的那个生效，含其他键的 Core 报错、不套用
  const claimed = new Set<string>();
  const files = [serversIn(primary), serversIn(shared)];
  for (const entries of files)
    for (const [name, entry] of entries)
      if (!(isRecord(entry) && isOverrideEntry(entry))) claimed.add(serverNamespace(name));
  const overrides = new Map<string, Record<string, unknown>>();
  const taken = new Set<string>();
  for (const entries of files)
    for (const [name, entry] of entries) {
      if (!(isRecord(entry) && isOverrideEntry(entry))) continue;
      const ns = serverNamespace(name);
      if (claimed.has(ns) || taken.has(ns)) continue;
      taken.add(ns);
      if (isApplicableOverride(entry)) overrides.set(name, entry);
    }
  return { scope, servers: views.filter((s) => !s.error), overrides };
}

/**
 * 跨级合并后 Core 实际启用的服务器：项目级同名定义取代全局那条（项目里停用的也遮蔽全局的），项目覆盖项改全局
 * 服务器的启停；最后才去掉停用的
 */
export function mergeMcpLevels(levels: McpLevel[]): ComposerCapability[] {
  const effective = new Map<string, { view: McpServerView; scope: CapabilityScope }>();
  for (const level of levels) {
    // 本级覆盖项只改更低一级已有的服务器（Core 按名字取），校验不过时 Core 报错、保留原状态
    for (const [name, override] of level.overrides) {
      const base = effective.get(name);
      if (!base) continue;
      const merged = { ...(isRecord(base.view.entry) ? base.view.entry : {}), ...override };
      if ("error" in validateServer(name, merged)) continue;
      if (typeof override.enabled === "boolean")
        effective.set(name, { ...base, view: { ...base.view, enabled: override.enabled } });
    }
    for (const view of level.servers) effective.set(view.name, { view, scope: level.scope });
  }
  return [...effective.values()]
    .filter(({ view }) => view.enabled)
    .map(({ view, scope }) => ({
      kind: "mcp",
      name: view.name,
      scope,
      description: view.description,
    }));
}

async function globalMcp(): Promise<McpLevel> {
  const file = await (await getPlatform()).mcpConfigRead();
  return levelServers(tryParse(file.text ?? "{}"), tryParse(file.agents?.text), "global");
}

/** 在工作区路径下拼出子路径（按工作区路径的分隔符） */
function joinPath(base: string, ...parts: string[]): string {
  const sep =
    /^[A-Za-z]:|^\\\\/.test(base) || (base.includes("\\") && !base.includes("/")) ? "\\" : "/";
  const rel = parts
    .join("/")
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(sep);
  return base.replace(/[\\/]+$/, "") + sep + rel;
}

/** 读取一个技能文件，按 Core 的规则取有效名称；读不到或 Core 不会加载时为 null */
async function readSkill(file: string, dirName: string): Promise<ComposerCapability | null> {
  const r = await (await getPlatform()).previewFile(file);
  if (r.kind !== "text") return null;
  const check = checkSkill(r.text, dirName);
  if (check.errors.length > 0) return null;
  return { kind: "skill", name: check.name, scope: "project", description: check.description };
}

/** 技能条目（相对技能根目录）对应的文件与目录名：`foo.md` 是单文件技能，其余是含 SKILL.md 的目录 */
function skillFile(root: string, entry: string): { file: string; dirName: string } {
  if (/\.md$/i.test(entry) && !/(^|[\\/])SKILL\.md$/.test(entry))
    return { file: joinPath(root, entry), dirName: baseName(entry).replace(/\.md$/i, "") };
  const dir = entry.replace(/[\\/]?SKILL\.md$/, "");
  return { file: joinPath(root, dir, "SKILL.md"), dirName: baseName(dir || root) };
}

/**
 * 项目里的技能与 MCP：只有已信任的工作区 Core 才会加载。
 * 技能读出 SKILL.md 的 frontmatter，用 Core 实际加载的名称（可能与目录名不同）；
 * MCP 读 `.primus/mcp.json` 与工作区本级的 `.agents/mcp.json` 自己解析，文件无效或过大时不列出其中的服务器
 * （workspaceInspect 此时只给诊断占位值）
 */
async function projectCapabilities(
  workspace: WorkspaceInfo | null,
): Promise<{ skills: ComposerCapability[]; mcp: McpLevel | null }> {
  if (!workspace?.trusted) return { skills: [], mcp: null };
  const root = workspace.path;
  const d = await (await getPlatform()).workspaceInspect(root);
  const skillRoot = joinPath(root, ".primus", "skills");
  const files = [
    ...d.skills.map((e) => skillFile(skillRoot, e)),
    ...d.agentsSkills.map((p) => skillFile(root, p)),
  ];
  const skills = await Promise.all(
    files.map(({ file, dirName }) => readSkill(file, dirName).catch(() => null)),
  );
  const [primary, shared] = await Promise.all([
    d.mcpServers.length === 0 ? null : readMcp(joinPath(root, ".primus", "mcp.json")),
    d.agentsMcpServers.length === 0 ? null : readMcp(joinPath(root, ".agents", "mcp.json")),
  ]);
  return {
    skills: skills.filter((c): c is ComposerCapability => c !== null),
    mcp: levelServers(primary, shared, "project"),
  };
}

/** 读出并解析项目里的 mcp.json；读不到、过大或无效时为 null */
async function readMcp(file: string): Promise<McpDocument | null> {
  const r = await (await getPlatform()).previewFile(file).catch(() => null);
  if (r?.kind !== "text" || r.truncated) return null;
  return tryParse(r.text);
}

/** 读取失败的来源不影响其余来源，只是不列出 */
const settle = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

export async function loadCapabilities(
  workspace: WorkspaceInfo | null,
): Promise<ComposerCapability[]> {
  const [project, skills, global] = await Promise.all([
    settle(projectCapabilities(workspace), { skills: [], mcp: null }),
    settle(globalSkills(), []),
    settle(globalMcp(), null),
  ]);
  const levels = [global, project.mcp].filter((l): l is McpLevel => l !== null);
  return mergeCapabilities([...project.skills, ...skills, ...mergeMcpLevels(levels)]);
}

/**
 * 菜单打开时（`setOpen(true)`）重新读取一次；结果为 null 表示还在读取。
 * 菜单开着时工作区或信任变化，清空后立即重读。
 * 工作区变化时丢弃旧结果，避免列出上一个项目的技能。
 */
export function useComposerCapabilities(workspace: WorkspaceInfo | null) {
  const [items, setItems] = useState<ComposerCapability[] | null>(null);
  const seq = useRef(0);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  // 菜单是否开着：开着时工作区或信任变化，清空后要立刻重读，不能停在“读取中”
  const openRef = useRef(false);
  const refresh = useCallback(() => {
    const id = ++seq.current;
    void loadCapabilities(workspaceRef.current).then((list) => {
      if (id === seq.current) setItems(list);
    });
  }, []);
  const setOpen = useCallback(
    (open: boolean) => {
      openRef.current = open;
      if (open) refresh();
    },
    [refresh],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: 工作区变化时清空旧列表
  useEffect(() => {
    seq.current++;
    setItems(null);
    if (openRef.current) refresh();
  }, [workspace?.path, workspace?.trusted]);
  return { items, refresh, setOpen };
}

/** 发送时在正文前注明选中的技能与 MCP（模型据此读取对应技能、调用对应 MCP 服务器） */
export function withCapabilities(
  text: string,
  selected: ComposerCapability[],
  opts: { image?: boolean } = {},
): string {
  const s = strings.chat.capabilities;
  const names = (kind: CapabilityKind) =>
    selected
      .filter((c) => c.kind === kind)
      .map((c) => `/${c.name}`)
      .join(s.separator);
  const lines: string[] = [];
  // 图片生成模式（“+”菜单）：这条消息固定交给 generate_image 出图
  if (opts.image) lines.push(s.useImage);
  const skills = names("skill");
  const mcp = names("mcp");
  if (skills) lines.push(fill(s.useSkills, { names: skills }));
  if (mcp) lines.push(fill(s.useMcp, { names: mcp }));
  if (lines.length === 0) return text;
  return text ? `${lines.join("\n")}\n\n${text}` : lines.join("\n");
}

/** 用户气泡用：拆出 withCapabilities 加在开头的说明，返回正文与所选能力（气泡里显示成标签，不显示说明原文） */
export function parseCapabilities(text: string): {
  body: string;
  image: boolean;
  skills: string[];
  mcp: string[];
} {
  const s = strings.chat.capabilities;
  const { body, lines } = splitHeader(text);
  const names = (line: string, tpl: string) =>
    line
      .slice((tpl.split("{names}")[0] as string).length)
      .split(s.separator)
      .map((n) => n.trim().replace(/^\//, ""))
      .filter(Boolean);
  const skillPrefix = s.useSkills.split("{names}")[0] as string;
  const mcpPrefix = s.useMcp.split("{names}")[0] as string;
  return {
    body,
    image: lines.includes(s.useImage),
    skills: lines.filter((l) => l.startsWith(skillPrefix)).flatMap((l) => names(l, s.useSkills)),
    mcp: lines.filter((l) => l.startsWith(mcpPrefix)).flatMap((l) => names(l, s.useMcp)),
  };
}

function splitHeader(text: string): { body: string; lines: string[] } {
  const s = strings.chat.capabilities;
  const prefixes = [s.useImage, s.useSkills, s.useMcp].map((x) => x.split("{names}")[0] as string);
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && prefixes.some((p) => (lines[i] as string).startsWith(p))) i++;
  return {
    body: i === 0 ? text : lines.slice(i).join("\n").replace(/^\n+/, ""),
    lines: lines.slice(0, i),
  };
}

/** 去掉 withCapabilities 加在开头的能力说明，返回正文与说明行（提问索引只看正文） */
export function stripCapabilities(text: string): { body: string; header: string } {
  const { body, lines } = splitHeader(text);
  return { body, header: lines.join(" ") };
}
