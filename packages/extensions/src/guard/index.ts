// primus-guard：权限模式与工具调用审批（技术方案附录 A）。
//
// 三种权限模式（界面输入框左下角的“权限”菜单，经 `/primus-mode <模式>` 设置）：
//   ask   每次询问：修改文件、运行命令、联网，以及读取工作区以外的文件，都先征求同意
//   edit  自动编辑：工作区内的读写直接执行；运行命令、联网与工作区以外的文件仍询问
//   full  完全访问：所有操作直接放行，不询问也不拒绝（含受保护路径与强制推送、下载后执行的命令）
// 询问走扩展 UI 的 select 对话框（RPC 的 extension_ui_request），用户可选“允许”“本会话内始终允许”或“拒绝”。
// 询问 / 自动编辑模式下，受保护路径（.env*、.git/、~/.ssh、<安装目录>\data）的写入拒绝，读取需要确认；
// 两处例外（ADR 0016）：Core 已加载技能目录内的读取任何模式都放行（目录取自 before_agent_start）；
// 用户级 MCP 配置 <agentDir>/mcp.json 的读写按工作区外的文件处理（完全访问放行，其他模式询问）。
// 联网搜索与读取网页（web_search / web_fetch，ADR 0020）任何模式都放行，由设置里的“联网”开关控制。
// 强制推送与下载后直接执行的命令在每次询问、自动编辑模式下必定询问，且不能“始终允许”。路径按 Core 的规则解析并跟随符号链接比较。
// 没有界面（hasUI 为 false）时需要询问的调用一律拒绝；处理出错时 Core 按失败即拦截处理。
// 当前模式经 setWidget("primus:mode") 告知前端。
// 计划模式（primus-plan 经 plan/gate.ts 打开只读开关）压过上面三种模式：修改文件一律拒绝，命令按只读分类器
// 放行 / 拒绝 / 询问（询问时不提供“始终允许”），其他未声明只读的工具询问（decidePlan）。

import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGEGEN_TOOL, WEB_TOOLS } from "@primus/protocol";
import { type PlanGate, planGate } from "../plan/gate.ts";
import { classifyCommand, shellWords, splitSegments } from "../plan/readonly.ts";

export const MODES = ["ask", "edit", "full"] as const;
export type PermissionMode = (typeof MODES)[number];

export const MODE_COMMAND = "primus-mode";
export const MODE_WIDGET = "primus:mode";

/** 计划模式下拒绝修改时给模型的原因 */
export const PLAN_DENY_REASON =
  "计划模式只读：不能修改文件或运行会改动系统的命令。把要做的改动写进计划，用 plan_submit 提交给用户审批。";
/** 计划模式下需要用户确认时标题的前缀 */
export const PLAN_ASK_PREFIX = "计划模式：";

export const CHOICES = {
  allow: "允许",
  always: "本会话内始终允许",
  deny: "拒绝",
} as const;

/** 只读取文件内容的内置工具 */
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** 修改文件的内置工具 */
const EDIT_TOOLS = new Set(["write", "edit"]);
/**
 * 联网搜索与读取网页（primus-web，ADR 0020）：只读、只访问公网，任何模式（含计划模式）都放行；
 * 是否允许联网由设置里的“联网”开关决定（关闭时工具不提供给模型）
 */
const WEB_TOOL_NAMES = new Set<string>(WEB_TOOLS);

export function isMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/** 与 Core 一致地把 Git Bash / MSYS / Cygwin / WSL 的盘符路径（`/d/…`、`/mnt/d/…`）转成 `D:\…` */
function windowsShellPath(p: string): string {
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return p;
  const m = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(p);
  if (!m?.[1]) return p;
  return `${m[1].toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}`;
}

/**
 * 把工具参数里的路径解析成绝对路径，规则与 Core 的工具一致（packages/coding-agent/src/utils/paths.ts）：
 * 去掉开头的 `@`，Windows 上转换 shell 盘符路径，展开 `~` 与 `file://`，再相对工作区解析。
 */
export function resolveToolPath(
  input: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  let p = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (platform === "win32") p = windowsShellPath(p);
  if (p === "~") p = home;
  else if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\")))
    p = join(home, p.slice(2));
  else if (/^file:\/\//.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {}
  }
  return resolve(cwd, p);
}

/**
 * 跟随符号链接后的真实路径。目标还不存在时，取最近的已存在祖先目录的真实路径，再接上其余部分；
 * 悬空符号链接按链接目标解析。这样工作区内指向外部的符号链接（含悬空链接）不会被当成工作区内。
 */
export function realPath(
  p: string,
  real: (p: string) => string = realpathSync.native,
  depth = 0,
): string {
  const rest: string[] = [];
  let current = resolve(p);
  for (;;) {
    try {
      return rest.length > 0 ? join(real(current), ...rest.reverse()) : real(current);
    } catch {
      // 悬空符号链接：realpath 失败，按链接目标继续解析（限制层数防止链接成环）
      if (depth < 32) {
        try {
          if (lstatSync(current).isSymbolicLink()) {
            const target = resolve(dirname(current), readlinkSync(current));
            return join(realPath(target, real, depth + 1), ...rest.reverse());
          }
        } catch {}
      }
      const parent = dirname(current);
      if (parent === current) return resolve(p);
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** `target`（绝对路径）是否在工作区 `cwd` 之内（含工作区本身），比较真实路径；Windows 上不区分大小写 */
export function insideWorkspace(
  cwd: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
  real?: (p: string) => string,
): boolean {
  const norm = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  const rel = relative(norm(realPath(cwd, real)), norm(realPath(resolve(cwd, target), real)));
  const parentStep =
    rel === ".." || rel.startsWith("../") || (platform === "win32" && rel.startsWith("..\\"));
  return rel === "" || (!parentStep && !isAbsolute(rel));
}

/** 是否是已存在的目录（跟随链接）；不存在或读不了时为 false */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `p` 是否是 `root` 本身或在其内（两者都是绝对路径；Windows 上不区分大小写） */
function within(root: string, p: string, platform: NodeJS.Platform): boolean {
  const norm = (x: string) => (platform === "win32" ? x.toLowerCase() : x);
  const rel = relative(norm(resolve(root)), norm(resolve(p)));
  const parentStep =
    rel === ".." || rel.startsWith("../") || (platform === "win32" && rel.startsWith("..\\"));
  return rel === "" || (!parentStep && !isAbsolute(rel));
}

/**
 * 机密路径：`.env*`、`.git/` 内部、`~/.ssh`。不论位置（含技能目录）一律受保护。
 * `~/.ssh` 同时按字面路径与真实路径比较：主目录（或 .ssh）是链接时，直接访问链接目标里的 .ssh 也算。
 * `~/.ssh` 的真实路径每次重新解析、不缓存：用户可能在会话中改链接目标，缓存旧目标会漏掉新目标
 */
function isSecretPath(
  abs: string,
  platform: NodeJS.Platform,
  home: string,
  real?: (p: string) => string,
): boolean {
  const parts = (platform === "win32" ? abs.toLowerCase() : abs).split(/[\\/]+/);
  if (parts.includes(".git")) return true;
  // `.env*` 文件，以及 `.env*` 目录里的任何文件（例如 `.env/secret.txt`）
  if (parts.some((part) => part.startsWith(".env"))) return true;
  const ssh = join(home, ".ssh");
  return within(ssh, abs, platform) || within(realPath(ssh, real), abs, platform);
}

/** Core 的用户目录 `<安装目录>\data\users\<SID>\core`（PRIMUS_CODING_AGENT_DIR）；未设置为 undefined */
function agentDirOf(env: Record<string, string | undefined>): string | undefined {
  const dir = env.PRIMUS_CODING_AGENT_DIR;
  return dir ? resolve(dir) : undefined;
}

/** App 数据目录 `<安装目录>\data`：PRIMUS_CODING_AGENT_DIR 往上三级，且名为 data；否则 undefined */
function dataDirOf(env: Record<string, string | undefined>): string | undefined {
  const coreDir = agentDirOf(env);
  if (!coreDir) return undefined;
  const data = resolve(coreDir, "..", "..", "..");
  return basename(data).toLowerCase() === "data" ? data : undefined;
}

/** 安装层面的目录（App 数据目录、Core 用户目录）的真实路径缓存：会话内不会变，只缓存已存在的目录 */
const realDirCache = new Map<string, string>();

/** 目录的真实路径；用默认的 realpath 且目录存在时缓存（测试替换 real 时不缓存） */
function realDir(dir: string, real?: (p: string) => string): string {
  if (real) return realPath(dir, real);
  const cached = realDirCache.get(dir);
  if (cached !== undefined) return cached;
  const r = realPath(dir);
  if (isDirectory(dir)) realDirCache.set(dir, r);
  return r;
}

/**
 * App 数据目录的比较根：数据目录本身与其真实路径、Core 用户目录的真实路径（它自身是链接、指向数据目录外时），
 * 以及要排除的默认对话工作区——按数据目录的字面路径与真实路径各一份（不取 chat 自身的真实路径：
 * chat 是指向 core 等目录的链接时不能借此把它们排除在外）。未配置时为 undefined。
 */
function appDataRoots(
  env: Record<string, string | undefined>,
  real?: (p: string) => string,
): { data: string[]; chat: string[] } | undefined {
  const data = dataDirOf(env);
  const coreDir = agentDirOf(env);
  if (!data || !coreDir) return undefined;
  const dataReal = realDir(data, real);
  // 例外：users\<SID>\chat 是未选工作区时对话的默认工作区（薄壳 sessions.rs 的 DEFAULT_WORKSPACE_DIR），
  // 属于用户自己的文件，不算 App 数据；其中的 .env*、.git 仍按机密路径保护
  const chat = resolve(coreDir, "..", "chat");
  return {
    data: [data, dataReal, realDir(coreDir, real)],
    chat: [chat, join(dataReal, relative(data, chat))],
  };
}

/**
 * App 数据目录内（默认对话工作区 `data\users\<SID>\chat` 除外）。数据目录按字面路径与真实路径都比较：
 * 数据目录在平台链接下（macOS 的 /var → /private/var、安装路径里的目录联接）时，经真实路径给出的
 * auth.json、mcp.json 同样识别。调用方另把 `abs` 的真实路径也传进来比较。
 */
function isAppDataPath(
  abs: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  real?: (p: string) => string,
): boolean {
  const roots = appDataRoots(env, real);
  if (!roots) return false;
  return (
    roots.data.some((d) => within(d, abs, platform)) &&
    !roots.chat.some((c) => within(c, abs, platform))
  );
}

/**
 * 受保护路径（技术方案第 17.4 节）：`.env*`、`.git/` 内部、`~/.ssh`、App 的数据目录 `<安装目录>\data`
 * （默认对话工作区 `data\users\<SID>\chat` 除外）。
 * 写入一律拒绝（不论权限模式），读取需要确认。例外见 decide：已加载技能目录内的读取、用户级 `mcp.json`（ADR 0016）。
 */
export function isProtectedPath(
  abs: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  real?: (p: string) => string,
): boolean {
  return isSecretPath(abs, platform, home, real) || isAppDataPath(abs, env, platform, real);
}

/**
 * 是否正是用户级 MCP 配置 `<agentDir>/mcp.json`（ADR 0016）。三条都满足才算：
 * 1. 解析后的路径（`..` 按字面消去，与 Core 打开的路径相同）正是 `<agentDir>/mcp.json`：除 agentDir 自身的
 *    各级目录外不经过任何目录，所以不会经由别处指向 agentDir 的链接 / 目录联接到达；
 * 2. mcp.json 本身不是符号链接（可能指向 auth.json 等）；还不存在（新建）时可以；
 * 3. 真实路径是 agentDir 真实路径下的 `mcp.json`（再防一道，例如不算符号链接的重解析点）。
 * agentDir（PRIMUS_CODING_AGENT_DIR）由 App 设置，属于可信配置：它自身路径里的链接（macOS 的 `/var`、
 * 安装路径里的目录联接，或 agentDir 本身就是链接）是平台 / 安装层面的，不影响判断。
 * 不满足时按 App 数据目录处理。
 */
export function isUserMcpConfig(abs: string, ge: GuardEnv): boolean {
  const agentDir = agentDirOf(ge.env);
  if (!agentDir) return false;
  const eq = (a: string, b: string) =>
    ge.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const file = join(agentDir, "mcp.json");
  if (!eq(resolve(abs), file)) return false;
  try {
    if (lstatSync(file).isSymbolicLink()) return false;
  } catch (err) {
    // 不存在时是新建；其他错误（无权限、上级不是目录等）无法确认，不算
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  return eq(realPath(file, ge.real), join(realPath(agentDir, ge.real), "mcp.json"));
}

/**
 * `abs` 是否在某个已加载技能的目录（Skill.baseDir）内（ADR 0016）。解析后的路径须在技能目录内，
 * 且真实路径须在技能目录的真实路径内：`..` 与指向外部的符号链接 / 目录联接都逃不出去。
 * 技能目录本身包含 Core 用户目录、App 数据目录、用户主目录或是根目录时不算（配置错误的技能不能把整块数据放开）。
 */
export function insideLoadedSkill(abs: string, ge: GuardEnv): boolean {
  const dirs = ge.skillDirs ?? [];
  if (dirs.length === 0) return false;
  const real = realPath(abs, ge.real);
  // 受保护的根目录连同其真实路径：技能目录经链接 / 目录联接指向数据目录时同样识别
  const guarded = [agentDirOf(ge.env), dataDirOf(ge.env), ge.home]
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .flatMap((d) => [d, realPath(d, ge.real)]);
  return dirs.some((dir) => {
    if (typeof dir !== "string" || !isAbsolute(dir)) return false;
    const base = resolve(dir);
    const baseReal = realPath(base, ge.real);
    for (const b of [base, baseReal]) {
      if (dirname(b) === b) return false;
      if (guarded.some((g) => within(b, g, ge.platform))) return false;
    }
    return within(base, abs, ge.platform) && within(baseReal, real, ge.platform);
  });
}

/**
 * 始终询问的命令（技术方案第 17.4 节）：强制推送、下载后直接执行。每次询问、自动编辑模式下必定询问，且不能“始终允许”；
 * 完全访问模式不询问（用户选择完全访问即表示不再确认）。
 * 管道与 `&&`、`;` 拆开后逐段检查。
 */
export function isAlwaysAskCommand(command: string): boolean {
  const text = command.replace(/\s+/g, " ");
  if (
    /\bgit\b[^|;&]*\bpush\b[^|;&]*(\s--force(-with-lease)?\b|\s-[a-z]*f[a-z]*\b|\s\+\S)/i.test(text)
  )
    return true;
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/i.test(text)) return true;
  if (
    /\b(iwr|irm|curl|wget|invoke-webrequest|invoke-restmethod)\b[^|;&]*\|\s*(iex|invoke-expression)\b/i.test(
      text,
    )
  )
    return true;
  return false;
}

export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

/** 工具调用涉及的路径（读写类工具）；没有则为 undefined */
function targetPath(call: ToolCall): string | undefined {
  const p = call.input?.path;
  return typeof p === "string" && p.trim() ? p : undefined;
}

export interface GuardEnv {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  real?: (p: string) => string;
  /** 读文本文件（git 配置）；读不到返回 undefined。测试里替换 */
  readText?: (p: string) => string | undefined;
  /** 本会话 Core 已加载技能的目录（Skill.baseDir，取自 before_agent_start 的 systemPromptOptions.skills） */
  skillDirs?: readonly string[];
}

const defaultEnv = (): GuardEnv => ({
  platform: process.platform,
  home: homedir(),
  env: process.env,
});

export type Decision = "allow" | "ask" | "deny";

/** 按模式判断一次工具调用：放行、询问或拒绝（完全访问一律放行；其他模式下受保护路径的写入拒绝） */
export function decide(
  mode: PermissionMode,
  call: ToolCall,
  cwd: string,
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean },
  ge: GuardEnv = defaultEnv(),
): Decision {
  // 完全访问：所有操作直接放行，包括受保护路径的读写与始终询问的命令（计划模式另由 decidePlan 判断）
  if (mode === "full") return "allow";
  if (call.toolName === IMAGEGEN_TOOL) return decideImageGen(mode, call, cwd, ge);
  if (WEB_TOOL_NAMES.has(call.toolName)) return "allow";
  const raw = targetPath(call);
  const abs = raw === undefined ? undefined : resolveToolPath(raw, cwd, ge.platform, ge.home);
  const isRead = READ_TOOLS.has(call.toolName);
  const isEdit = EDIT_TOOLS.has(call.toolName);
  if (abs !== undefined && (isRead || isEdit)) {
    const real = realPath(abs, ge.real);
    // .env*、.git、~/.ssh：不论在哪（含技能目录）都按受保护处理
    if (
      isSecretPath(abs, ge.platform, ge.home, ge.real) ||
      isSecretPath(real, ge.platform, ge.home, ge.real)
    )
      return isEdit ? "deny" : "ask";
    // 用户级 MCP 配置 <agentDir>/mcp.json：读写都按工作区外的文件处理（完全访问放行，其他模式询问），
    // 计划模式的修改已在 decidePlan 拒绝（ADR 0016）
    if (isUserMcpConfig(abs, ge)) return "ask";
    // 已加载技能目录内的读取：任何模式都放行（技能按需读取 SKILL.md 与其引用的文件，ADR 0016）。
    // grep 会递归读取目录里的文件内容（含隐藏文件，如技能目录里的 .env），只对单个文件放行
    if (isRead && insideLoadedSkill(abs, ge) && (call.toolName !== "grep" || !isDirectory(real)))
      return "allow";
    if (
      isAppDataPath(abs, ge.env, ge.platform, ge.real) ||
      isAppDataPath(real, ge.env, ge.platform, ge.real)
    )
      return isEdit ? "deny" : "ask";
  }
  const command = call.input?.command;
  if (
    (call.toolName === "bash" || call.toolName === "powershell") &&
    typeof command === "string" &&
    isAlwaysAskCommand(command)
  )
    return "ask";
  const inside = abs === undefined || insideWorkspace(cwd, abs, ge.platform, ge.real);
  if (isRead) return inside ? "allow" : "ask";
  if (isEdit) return mode === "edit" && inside ? "allow" : "ask";
  // 其他工具（命令、联网、MCP、子 Agent 等）：只有声明只读且不联网的才放行
  if (annotations?.readOnlyHint === true && annotations.openWorldHint === false) return "allow";
  return "ask";
}

/** 生成的图片所在目录 `users/<SID>/images`（与 primus-imagegen 的 imagesDirOf 一致）；未配置为 undefined */
function imagesDirOf(env: Record<string, string | undefined>): string | undefined {
  const core = agentDirOf(env);
  return core ? resolve(core, "..", "images") : undefined;
}

/**
 * 图片生成（generate_image，ADR 0018）：只联网、只写 App 自己的图片目录，不带参考图时直接放行；
 * 参考图会上传到图片服务，每张按 read 的规则判断（受保护路径、工作区外都要确认），
 * 之前生成的图片（图片目录内、不是机密路径）可以直接作为参考图。只会放行或询问，不会拒绝。
 */
function decideImageGen(mode: PermissionMode, call: ToolCall, cwd: string, ge: GuardEnv): Decision {
  const images = call.input?.images;
  if (images === undefined) return "allow";
  if (!Array.isArray(images)) return "ask";
  const dir = imagesDirOf(ge.env);
  for (const raw of images) {
    if (typeof raw !== "string" || !raw.trim()) return "ask";
    const abs = resolveToolPath(raw, cwd, ge.platform, ge.home);
    const real = realPath(abs, ge.real);
    if (
      dir &&
      within(dir, abs, ge.platform) &&
      within(realDir(dir, ge.real), real, ge.platform) &&
      !isSecretPath(abs, ge.platform, ge.home, ge.real) &&
      !isSecretPath(real, ge.platform, ge.home, ge.real)
    )
      continue;
    if (decide(mode, { toolName: "read", input: { path: raw } }, cwd, undefined, ge) !== "allow")
      return "ask";
  }
  return "allow";
}

/**
 * 计划模式（primus-plan，只读）的判断，压过权限模式（完全访问也一样）：
 * 修改文件一律拒绝；命令按只读分类器放行、拒绝或询问；读取类工具与声明只读且不联网的工具交给常规规则（返回 undefined）；
 * 其他工具询问。受保护路径等常规规则在返回 undefined 时照常生效。
 */
export function decidePlan(
  call: ToolCall,
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean },
  cwd = process.cwd(),
  ge: GuardEnv = defaultEnv(),
): Decision | undefined {
  if (EDIT_TOOLS.has(call.toolName)) return "deny";
  if (READ_TOOLS.has(call.toolName)) return undefined;
  // 图片生成不改工作区：交给常规规则（参考图按读取判断）
  if (call.toolName === IMAGEGEN_TOOL) return undefined;
  // 联网搜索与读取网页只读：交给常规规则（放行）
  if (WEB_TOOL_NAMES.has(call.toolName)) return undefined;
  if (call.toolName === "bash" || call.toolName === "powershell") {
    const command = call.input?.command;
    if (typeof command !== "string") return "ask";
    const c = classifyCommand(command, call.toolName === "powershell");
    if (c === "write") return "deny";
    if (c === "unknown") return "ask";
    // 只读命令也可能读受保护的文件（cat .env、git show HEAD:.env、type ~\.ssh\id_rsa）：
    // 与 read 工具一样要确认，不能因为是只读命令就直接放行
    return commandTouchesProtected(command, cwd, ge, call.toolName === "powershell") ||
      searchesHidden(command, call.toolName === "powershell") ||
      gitRunsConfiguredPrograms(command, cwd, ge, call.toolName === "powershell")
      ? "ask"
      : "allow";
  }
  if (annotations?.readOnlyHint === true && annotations.openWorldHint === false) return undefined;
  return "ask";
}

/**
 * 命令文字里是否提到受保护的路径：`.env*`、`.git`、`.ssh` 路径段（含通配写法 `.en?`、`.e*`），
 * 按工作目录解析后落在受保护位置（App 数据目录、`~/.ssh`）的参数，以及展开范围限定不了的参数
 * （工作区外的通配路径、含变量的参数）
 */
export function commandTouchesProtected(
  command: string,
  cwd: string,
  ge: GuardEnv = defaultEnv(),
  powershell = false,
): boolean {
  // bash 的 ANSI-C 引号（$'\x2eenv'）还原不了
  if (!powershell && command.includes("$'")) return true;
  const words = shellWords(command, powershell);
  // 引号没闭合：解析不了，确认
  if (!words) return true;
  // 原文与按 shell 规则拆词、去掉引号和转义后的词都检查：.\env、.e''nv、"/opt/A B"/data/… 展开后才是真正的路径
  const text = [command, ...words.map((w) => w.word)].join("\n");
  if (/(^|[\s\\/'"=:;|&(<>])\.(env|git(?![\w-])|ssh(?![\w-]))/im.test(text)) return true;
  // 隐藏路径段里带通配符：可能展开成 .env、.git
  if (/(^|[\s\\/'"=])\.[^\s\\/'"]*[*?[]/m.test(text)) return true;
  return words.some(({ word, expands }) => {
    const w = word.replace(/^-[^=]*=/, "");
    if (!w || w.startsWith("-")) return false;
    // 展开范围限定不了的路径：工作区外（绝对路径、~、..）带通配符，或含变量（$HOME/…、$env:APPDATA\…）。
    // 展开后可能落进 App 数据目录或 ~/.ssh，按受保护处理
    if (/[*?[]/.test(w) && (isAbsolute(w) || /^[a-zA-Z]:|^~|(^|[\\/])\.\.([\\/]|$)/.test(w)))
      return true;
    if (expands && /\$(\{|[A-Za-z])/.test(w) && !/^\$(_|psitem|true|false|null)\b/i.test(w))
      return true;
    if (!/[\\/~.]/.test(w)) return false;
    try {
      const abs = resolveToolPath(w, cwd, ge.platform, ge.home);
      return (
        isProtectedPath(abs, ge.env, ge.platform, ge.home, ge.real) ||
        isProtectedPath(realPath(abs, ge.real), ge.env, ge.platform, ge.home, ge.real)
      );
    } catch {
      return false;
    }
  });
}

/**
 * 会递归读取文件内容、且不跳过隐藏或被忽略文件的写法：搜到的 .env、.git 里的内容会进到输出里，
 * 与直接读受保护文件一样要确认。rg 默认跳过隐藏与 .gitignore 里的文件，加 -u / --hidden / --no-ignore
 * 就不跳过；grep -r、diff -r、findstr /s 本来就不跳过；PowerShell 的 * 也匹配 .env，
 * 带 -Recurse 或通配符读取内容（Get-ChildItem -Recurse | Select-String、Get-Content *）同样要确认
 */
export function searchesHidden(command: string, powershell: boolean): boolean {
  return (
    splitSegments(command, powershell).some((seg) => {
      // 按 shell 规则拆词：'--hidden'、-\u 还原成真正的参数；拆不了（引号没闭合）当作会读隐藏文件
      const parsed = shellWords(seg, powershell);
      if (!parsed) return true;
      const ws = parsed.map((w) => w.word);
      const name = (ws[0] ?? "")
        .replace(/^&/, "")
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.exe$/i, "")
        .toLowerCase();
      const args = ws.slice(1);
      const has = (re: RegExp) => args.some((a) => re.test(a));
      if (name === "rg")
        return has(/^(-[a-zA-Z]*[u.L]|--unrestricted|--hidden|--no-ignore|--follow)/);
      if (name === "grep" || name === "egrep" || name === "fgrep")
        return has(
          /^(-[a-zA-Z]*[rR]|--recursive|--dereference-recursive|--directories=recurse|-d$)/,
        );
      if (name === "diff") return has(/^(-[a-zA-Z]*r|--recursive)/);
      if (name === "findstr") return has(/^\/s$/i);
      if (name === "git")
        return /\bgrep\b/.test(seg) && has(/^--(no-index|untracked|no-exclude-standard)$/);
      return false;
    }) ||
    (powershell && psReadsMany(command))
  );
}

/**
 * 只读的 git 命令也会执行配置里的外部程序：diff.external、diff.<驱动>.command / textconv（git diff / log -p /
 * show / grep）、filter.<名>.clean / smudge / process（比较工作区文件时）、core.fsmonitor（status 等）。
 * 仓库的 .git/config 可能来自 Agent 下载的仓库：读一遍仓库与用户的配置（含 include 的文件），配了这些就要确认；
 * --git-dir、--work-tree 指向的仓库不好找，也确认
 */
export function gitRunsConfiguredPrograms(
  command: string,
  cwd: string,
  ge: GuardEnv = defaultEnv(),
  powershell = false,
): boolean {
  const read =
    ge.readText ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    });
  if (
    Object.keys(ge.env).some((k) => /^GIT_(EXTERNAL_DIFF|CONFIG_COUNT|CONFIG_PARAMETERS)$/.test(k))
  )
    return splitSegments(command, powershell).some((seg) => isGit(seg, powershell));
  // include / includeIf 的文件也读（条件不判断，一律当作生效），最多跟 5 层
  const risky = (file: string, depth = 0): boolean => {
    const text = read(file);
    if (text === undefined) return false;
    if (
      /^\s*(external|textconv|command|clean|smudge|process)\s*=/im.test(text) ||
      // core.fsmonitor 是布尔值时用内置的守护进程，是路径时执行该程序
      [...text.matchAll(/^[ \t]*fsmonitor[ \t]*=([^\n#;]*)/gim)].some(
        (m) => !/^\s*(true|false|yes|no|on|off|0|1)?\s*$/i.test(m[1] ?? ""),
      )
    )
      return true;
    const includes = [...text.matchAll(/^[ \t]*path[ \t]*=[ \t]*"?([^"\n#;]*?)"?[ \t]*$/gim)]
      .map((m) => (m[1] ?? "").trim())
      .filter(Boolean);
    if (includes.length === 0 || !/^\s*\[\s*include/im.test(text)) return false;
    if (depth >= 5) return true;
    return includes.some((p) =>
      risky(resolve(dirname(file), p.replace(/^~(?=[\\/]|$)/, ge.home)), depth + 1),
    );
  };
  const userConfigs = [
    ge.env.GIT_CONFIG_GLOBAL ?? join(ge.home, ".gitconfig"),
    join(ge.env.XDG_CONFIG_HOME ?? join(ge.home, ".config"), "git", "config"),
  ];
  return splitSegments(command, powershell).some((seg) => {
    const ws = shellWords(seg, powershell)?.map((w) => w.word);
    if (!ws) return true;
    if (!isGit(seg, powershell)) return false;
    let dir = cwd;
    for (let i = 1; i < ws.length; i++) {
      const a = ws[i] as string;
      if (/^--(git-dir|work-tree)/.test(a)) return true;
      if (a === "-C") dir = resolve(dir, ws[++i] ?? "");
      else if (!a.startsWith("-")) break;
    }
    if (userConfigs.some((p) => risky(p))) return true;
    const gitDir = findGitDir(dir, read);
    if (!gitDir) return false;
    const common = read(join(gitDir, "commondir"))?.trim();
    const commonDir = common ? resolve(gitDir, common) : gitDir;
    return [join(commonDir, "config"), join(gitDir, "config.worktree")].some((p) => risky(p));
  });
}

function isGit(seg: string, powershell: boolean): boolean {
  const first = shellWords(seg, powershell)?.[0]?.word ?? "";
  const base = first.replace(/^&/, "").split(/[\\/]/).pop() ?? "";
  return /^git(\.exe)?$/i.test(base);
}

/** 从 dir 往上找仓库的 git 目录：.git 文件夹，或 .git 文件里的 gitdir:（工作树、子模块） */
function findGitDir(start: string, read: (p: string) => string | undefined): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const dotGit = join(dir, ".git");
    if (read(join(dotGit, "HEAD")) !== undefined) return dotGit;
    const link = read(dotGit)?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
    if (link) return resolve(dir, link);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** PowerShell：读取内容的 cmdlet 配上递归或通配符 */
function psReadsMany(command: string): boolean {
  // Select-String 的匹配模式（-Pattern 之后或第一个位置参数）是正则，里面的 * ? 不是通配符；
  // 路径参数即使加引号，* ? 仍是通配符（只有 -LiteralPath 不展开）
  const text = command
    .replace(/(-pattern\s+)('[^']*'|"[^"]*"|\S+)/gi, "$1P")
    .replace(/\b(select-string|sls)(\s+)('[^']*'|"[^"]*"|[^-\s]\S*)/gi, "$1$2P");
  if (!/(^|[\s|;(])(select-string|sls|get-content|gc|cat|type)\b/i.test(text)) return false;
  return (
    /(^|\s)-(recurse|r|depth)\b/i.test(text) || /(^|[\s\\/,])[^\s'"|;]*[*?][^\s|;]*/.test(text)
  );
}

/** 按模式判断一次工具调用是否需要询问（拒绝也算需要处理） */
export function needsApproval(
  mode: PermissionMode,
  call: ToolCall,
  cwd: string,
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean },
  platform: NodeJS.Platform = process.platform,
): boolean {
  return decide(mode, call, cwd, annotations, { ...defaultEnv(), platform }) !== "allow";
}

/**
 * “本会话内始终允许”记住的范围：命令类工具按完整命令文本，读写类工具按解析后的绝对路径，其他工具按工具名加参数。
 * 只放行与当时确认的完全相同的操作，不会因为允许过一条命令就放行之后所有命令或其他路径的写入。
 */
export function approvalKey(call: ToolCall, cwd: string): string {
  const input = call.input ?? {};
  if (call.toolName === "bash" || call.toolName === "powershell")
    return `${call.toolName}\u0000${String(input.command ?? "")}`;
  const path = targetPath(call);
  if (path) return `${call.toolName}\u0000${resolveToolPath(path, cwd)}`;
  let args = "";
  try {
    args = JSON.stringify(input);
  } catch {}
  return `${call.toolName}\u0000${args}`;
}

/** 询问对话框的标题：说明要做什么 */
export function describeCall(call: ToolCall, cwd: string): string {
  const input = call.input ?? {};
  const path = targetPath(call);
  const where = path ? resolveToolPath(path, cwd) : "";
  switch (call.toolName) {
    case "bash":
    case "powershell":
      return `运行命令：${String(input.command ?? "")}`;
    case "write":
      return `写入文件：${where}`;
    case "edit":
      return `修改文件：${where}`;
    case "read":
    case "grep":
    case "find":
    case "ls":
      return `读取工作区以外的内容：${where}`;
    case IMAGEGEN_TOOL: {
      const refs = Array.isArray(input.images)
        ? input.images.map((p) => (typeof p === "string" ? resolveToolPath(p, cwd) : String(p)))
        : [];
      return `把参考图上传到图片服务生成图片：${refs.join("、")}`;
    }
    default: {
      let args = "";
      try {
        args = JSON.stringify(input);
      } catch {}
      if (args.length > 400) args = `${args.slice(0, 400)}…`;
      return `使用工具 ${call.toolName}${args && args !== "{}" ? `：${args}` : ""}`;
    }
  }
}

interface UiContext {
  hasUI: boolean;
  cwd: string;
  signal?: AbortSignal;
  ui: {
    select: (
      title: string,
      options: string[],
      opts?: { signal?: AbortSignal },
    ) => Promise<string | undefined>;
    setWidget?: (key: string, lines: string[] | undefined) => void;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  };
}

interface GuardApi {
  on: (event: string, handler: (event: never, ctx: UiContext) => unknown) => void;
  registerCommand: (
    name: string,
    options: { description: string; handler: (args: string, ctx: UiContext) => Promise<void> },
  ) => void;
  getAllTools?: () => {
    name: string;
    annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
  }[];
}

function isGuardApi(pi: unknown): pi is GuardApi {
  const p = pi as Partial<GuardApi> | null;
  return typeof p?.on === "function" && typeof p.registerCommand === "function";
}

function publishMode(ctx: UiContext, mode: PermissionMode): void {
  ctx.ui.setWidget?.(MODE_WIDGET, [JSON.stringify({ v: 1, type: "mode", data: { mode } })]);
}

export interface GuardState {
  mode: PermissionMode;
  /** 本会话内已“始终允许”的操作（见 approvalKey） */
  alwaysAllowed: Set<string>;
  /** 本会话 Core 已加载技能的目录，每轮开始（before_agent_start）时刷新 */
  skillDirs: string[];
}

/** 从 before_agent_start 事件取已加载技能的目录（systemPromptOptions.skills[].baseDir） */
export function loadedSkillDirs(event: unknown): string[] {
  const skills = (event as { systemPromptOptions?: { skills?: unknown } } | null)
    ?.systemPromptOptions?.skills;
  if (!Array.isArray(skills)) return [];
  return skills
    .map((s) => (s as { baseDir?: unknown } | null)?.baseDir)
    .filter((d): d is string => typeof d === "string" && d.length > 0);
}

export function createGuard(initial: PermissionMode = "ask", gate: PlanGate = planGate) {
  const state: GuardState = { mode: initial, alwaysAllowed: new Set(), skillDirs: [] };
  function guard(pi: unknown): void {
    if (!isGuardApi(pi)) return;
    pi.registerCommand(MODE_COMMAND, {
      description: "设置权限模式：ask（每次询问）、edit（自动编辑）、full（完全访问）",
      handler: async (args, ctx) => {
        const mode = args.trim();
        if (!isMode(mode)) {
          ctx.ui.notify?.(`未知的权限模式：${mode || "（空）"}`, "error");
          return;
        }
        state.mode = mode;
        publishMode(ctx, mode);
      },
    });
    pi.on("session_start", (_event, ctx) => publishMode(ctx, state.mode));
    // 每轮开始时记下 Core 已加载的技能目录（/reload 后下一轮即生效）；只读，不改提示词
    pi.on("before_agent_start", (event: never) => {
      state.skillDirs = loadedSkillDirs(event);
      return undefined;
    });
    pi.on("tool_call", async (event: never, ctx) => {
      const call = event as ToolCall;
      const annotations = pi.getAllTools?.().find((t) => t.name === call.toolName)?.annotations;
      // 计划模式先判断：拒绝与放行直接生效，询问时不提供“始终允许”
      const planDecision = gate.readOnly ? decidePlan(call, annotations, ctx.cwd) : undefined;
      if (planDecision === "deny") return { block: true, reason: PLAN_DENY_REASON };
      const decision =
        planDecision ??
        decide(state.mode, call, ctx.cwd, annotations, {
          ...defaultEnv(),
          skillDirs: state.skillDirs,
        });
      if (decision === "allow") return undefined;
      if (decision === "deny")
        return {
          block: true,
          reason: "受保护的路径（.env、.git、~/.ssh、应用数据目录）不允许写入",
        };
      const command = call.input?.command;
      const inPlan = planDecision === "ask";
      const alwaysAsk = inPlan || (typeof command === "string" && isAlwaysAskCommand(command));
      // 用户在本会话内已对完全相同的操作选过“始终允许”（始终询问的命令除外）
      const key = approvalKey(call, ctx.cwd);
      if (!alwaysAsk && state.alwaysAllowed.has(key)) return undefined;
      if (!ctx.hasUI) return { block: true, reason: "需要确认，但当前没有可以确认的界面，已拒绝" };
      const choice = await ctx.ui.select(
        `${inPlan ? PLAN_ASK_PREFIX : ""}${describeCall(call, ctx.cwd)}`,
        alwaysAsk ? [CHOICES.allow, CHOICES.deny] : [CHOICES.allow, CHOICES.always, CHOICES.deny],
        { signal: ctx.signal },
      );
      // 等确认期间可能开启了计划模式：该拒绝的调用不能因为之前弹出的确认而放行；
      // 计划模式要询问的调用不能沿用普通确认（尤其“始终允许”），按计划模式重新确认一次
      const planNow = gate.readOnly ? decidePlan(call, annotations, ctx.cwd) : undefined;
      if (planNow === "deny") return { block: true, reason: PLAN_DENY_REASON };
      if (planNow === "ask" && !inPlan && choice !== CHOICES.deny) {
        const again = await ctx.ui.select(
          `${PLAN_ASK_PREFIX}${describeCall(call, ctx.cwd)}`,
          [CHOICES.allow, CHOICES.deny],
          { signal: ctx.signal },
        );
        if (gate.readOnly && decidePlan(call, annotations, ctx.cwd) === "deny")
          return { block: true, reason: PLAN_DENY_REASON };
        return again === CHOICES.allow ? undefined : { block: true, reason: "用户拒绝了这次操作" };
      }
      if (choice === CHOICES.always) {
        state.alwaysAllowed.add(key);
        return undefined;
      }
      if (choice === CHOICES.allow) return undefined;
      return { block: true, reason: "用户拒绝了这次操作" };
    });
  }
  return { guard, state };
}

export default createGuard().guard;
