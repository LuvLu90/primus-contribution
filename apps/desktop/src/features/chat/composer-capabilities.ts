// “+”菜单里的技能与 MCP：列出全局（Core 用户目录 `skills/`、`~/.agents/skills`、用户级 mcp.json）
// 与当前项目（已信任工作区的 `.primus/skills`、`.agents/skills`、`.primus/mcp.json`）里会被 Core 加载的技能与 MCP 服务器。
// 选中的项以“/名称”标签挂在输入框上方，发送时在消息开头注明要使用哪些技能与 MCP。
import { useCallback, useEffect, useRef, useState } from "react";
import { listServers, parseMcpDocument } from "@/features/capabilities/mcp-config";
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

async function globalMcp(): Promise<ComposerCapability[]> {
  const file = await (await getPlatform()).mcpConfigRead();
  return listServers(parseMcpDocument(file.text))
    .filter((s) => s.enabled && !s.error)
    .map((s) => ({ kind: "mcp", name: s.name, scope: "global", description: s.description }));
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
 * MCP 读 `.primus/mcp.json` 自己解析，文件无效或过大时不列出（workspaceInspect 此时只给诊断占位值）
 */
async function projectCapabilities(workspace: WorkspaceInfo | null): Promise<ComposerCapability[]> {
  if (!workspace?.trusted) return [];
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
  const mcp =
    d.mcpServers.length === 0 ? [] : await projectMcp(joinPath(root, ".primus", "mcp.json"));
  return [...skills.filter((c): c is ComposerCapability => c !== null), ...mcp];
}

async function projectMcp(file: string): Promise<ComposerCapability[]> {
  const r = await (await getPlatform()).previewFile(file).catch(() => null);
  if (r?.kind !== "text" || r.truncated) return [];
  let doc: ReturnType<typeof parseMcpDocument>;
  try {
    doc = parseMcpDocument(r.text);
  } catch {
    return [];
  }
  return listServers(doc)
    .filter((s) => s.enabled && !s.error)
    .map((s) => ({ kind: "mcp", name: s.name, scope: "project", description: s.description }));
}

/** 读取失败的来源不影响其余来源，只是不列出 */
const settle = (p: Promise<ComposerCapability[]>) => p.catch(() => [] as ComposerCapability[]);

export async function loadCapabilities(
  workspace: WorkspaceInfo | null,
): Promise<ComposerCapability[]> {
  const parts = await Promise.all([
    settle(projectCapabilities(workspace)),
    settle(globalSkills()),
    settle(globalMcp()),
  ]);
  return mergeCapabilities(parts.flat());
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
