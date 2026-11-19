// 浏览器预览中的能力中心（ADR 0017）：技能与 mcp.json 都在内存里，行为与薄壳一致——
// 安装遇同名以 code `exists` 拒绝、`~/.agents/skills` 的技能只能启停、mcp.json 读后被改以 code `conflict` 拒绝、
// 只有 Core 用户目录 `skills/` 下的技能可以删除。`mcp list` 按内存中的 mcp.json 给出连接结果：
// 名字含 `auth` 的 HTTP 服务器需要登录（登录后连上），名字含 `fail` 的连接失败。

import {
  type CliOutput,
  MCP_CONFLICT,
  type McpConfigFile,
  type Platform,
  PlatformError,
  SKILL_EXISTS,
  type SkillCandidate,
  type SkillInfo,
  type SkillSource,
  type SkillStage,
} from "../types";

type CapabilityMethods = Pick<
  Platform,
  | "skillsList"
  | "skillStage"
  | "skillInstall"
  | "skillDiscard"
  | "skillDelete"
  | "skillSetEnabled"
  | "mcpConfigRead"
  | "mcpConfigWrite"
  | "mcpList"
  | "mcpLogin"
  | "mcpLogout"
>;

const CORE_DIR = "C:\\Users\\mock\\AppData\\Roaming\\Primus\\core";
const USER_SKILLS = `${CORE_DIR}\\skills`;
const AGENTS_SKILLS = "C:\\Users\\mock\\.agents\\skills";
export const MOCK_MCP_PATH = `${CORE_DIR}\\mcp.json`;
/** `~/.agents/mcp.json`：与其他工具共用，只读（ADR 0022） */
export const MOCK_AGENTS_MCP_PATH = "C:\\Users\\mock\\.agents\\mcp.json";

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const SEED_SKILLS: SkillInfo[] = [
  {
    dirName: "pdf",
    file: `${USER_SKILLS}\\pdf\\SKILL.md`,
    dir: `${USER_SKILLS}\\pdf`,
    scope: "user",
    content: skillMd("pdf", "读取、合并、拆分 PDF，提取其中的文字与表格。"),
    enabled: true,
    deletable: true,
    link: false,
    package: null,
  },
  {
    dirName: "release-notes",
    file: `${AGENTS_SKILLS}\\release-notes\\SKILL.md`,
    dir: `${AGENTS_SKILLS}\\release-notes`,
    scope: "agents",
    content: skillMd("release-notes", "按提交记录整理版本说明。"),
    enabled: true,
    deletable: false,
    link: false,
    package: null,
  },
];

const SEED_MCP = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs-auth": {
      "url": "https://example.com/mcp"
    }
  }
}
`;

const SEED_AGENTS_MCP = `{
  "mcpServers": {
    "shared-docs": {
      "url": "https://docs.example.com/mcp",
      "description": "与其他 Agent 工具共用的文档检索"
    }
  }
}
`;

/** 内容的“版本”：与薄壳一样文件不存在时为空串（这里用长度加简单哈希代替 SHA-256） */
function versionOf(text: string | null): string {
  if (text === null) return "";
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return `${text.length}-${(h >>> 0).toString(16)}`;
}

/** 与薄壳一致的安装目录名规则 */
const validDir = (name: string) =>
  /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(name) &&
  !name.endsWith(".") &&
  !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name);

/** 薄壳接受的 GitHub 链接的简化版：仓库、`tree/` / `blob/` 链接，以及 Core 的 `#<ref>` / `@<ref>` 写法 */
const GITHUB =
  /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(tree|blob)\/[^/?#]+(\/[^?#]*)?|@[^#?]+)?\/?(?:[?#].*)?$/;

const lastSegment = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || "skill";

/** 覆盖项能改的键（与 Core 的 OVERRIDE_KEYS 一致） */
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

const cli = (stdout: string, code = 0, stderr = ""): CliOutput => ({
  code,
  stdout,
  stderr,
  timedOut: false,
});

export interface MockCapabilitiesOptions {
  /** 不预置技能、mcp.json 与 ~/.agents/mcp.json */
  empty?: boolean;
  /** `~/.agents/mcp.json` 的原文（null 为不存在）；默认按 `empty` 预置 */
  agentsMcp?: string | null;
}

export function createMockCapabilities(options: MockCapabilitiesOptions = {}): CapabilityMethods {
  const skills: SkillInfo[] = options.empty ? [] : structuredClone(SEED_SKILLS);
  const stages = new Map<string, SkillCandidate[]>();
  let stageSeq = 0;
  let mcpText: string | null = options.empty ? null : SEED_MCP;
  const agentsMcpText: string | null =
    options.agentsMcp !== undefined ? options.agentsMcp : options.empty ? null : SEED_AGENTS_MCP;
  const loggedIn = new Set<string>();

  const findSkill = (file: string) => {
    const skill = skills.find((s) => s.file === file);
    if (!skill) throw new PlatformError("找不到这个技能");
    return skill;
  };

  /** 暂存结果：来源名与其中的技能 */
  const stageCandidates = (
    source: SkillSource,
  ): { label: string; candidates: SkillCandidate[] } => {
    if (source.kind === "github") {
      const m = GITHUB.exec(source.url.trim());
      if (!m) throw new PlatformError("请输入 GitHub 仓库链接，例如 https://github.com/owner/repo");
      const repo = m[2] ?? "repo";
      const sub = m[4]?.replace(/^\/+|\/+$/g, "");
      if (sub) {
        const dir = lastSegment(m[3] === "blob" ? sub.replace(/\/[^/]*$/, "") : sub);
        return {
          label: dir,
          candidates: [
            { path: "", dirName: dir, content: skillMd(dir, `来自 ${repo} 的示例技能。`) },
          ],
        };
      }
      // 仓库根目录：示例仓库里有两个技能，其中一个缺少 description（Core 不会加载它，界面标出）
      return {
        label: repo,
        candidates: [
          {
            path: "skills/web-search",
            dirName: "web-search",
            content: skillMd("web-search", "搜索网页并总结结果。"),
          },
          {
            path: "skills/broken",
            dirName: "broken",
            content: "---\nname: broken\n---\n\n没有 description。\n",
          },
        ],
      };
    }
    if (source.kind === "zip") {
      if (!/\.zip$/i.test(source.path)) throw new PlatformError("请选择 .zip 文件");
      const dir = lastSegment(source.path.replace(/\.zip$/i, ""));
      return {
        label: dir,
        candidates: [{ path: "", dirName: dir, content: skillMd(dir, "从压缩包安装的示例技能。") }],
      };
    }
    const dir = lastSegment(source.path);
    return {
      label: dir,
      candidates: [
        { path: "", dirName: dir, content: skillMd(dir, "从本地文件夹安装的示例技能。") },
      ],
    };
  };

  return {
    skillsList: async () => structuredClone(skills),

    skillStage: async (source): Promise<SkillStage> => {
      const { label, candidates } = stageCandidates(source);
      const stageId = `stage-${++stageSeq}`;
      stages.set(stageId, candidates);
      return {
        stageId,
        label,
        candidates: structuredClone(candidates),
        skippedLinks: 0,
        truncated: false,
      };
    },

    // 与薄壳一样整个来源装进 skills/<name>，其中的技能全部列出
    skillInstall: async (stageId, name, overwrite) => {
      const candidates = stages.get(stageId);
      if (!candidates) throw new PlatformError("暂存已失效，请重新选择来源");
      if (!validDir(name)) throw new PlatformError("技能目录名无效");
      const top = `${USER_SKILLS}\\${name}`;
      const inTop = (s: SkillInfo) =>
        s.scope === "user" &&
        (s.dir.toLowerCase() === top.toLowerCase() ||
          s.dir.toLowerCase().startsWith(`${top.toLowerCase()}\\`));
      if (skills.some(inTop) && !overwrite)
        throw new PlatformError(`已有同名技能“${name}”`, SKILL_EXISTS);
      for (let i = skills.length - 1; i >= 0; i--) {
        const s = skills[i];
        if (s && inTop(s)) skills.splice(i, 1);
      }
      for (const c of candidates) {
        const dir = c.path ? `${top}\\${c.path.replace(/\//g, "\\")}` : top;
        skills.push({
          dirName: c.path ? c.dirName : name,
          file: `${dir}\\SKILL.md`,
          dir,
          scope: "user",
          content: c.content,
          enabled: true,
          deletable: true,
          link: false,
          package: c.path ? name : null,
        });
      }
      stages.delete(stageId);
      return top;
    },

    skillDiscard: async (stageId) => {
      if (!stages.delete(stageId)) throw new PlatformError("暂存已失效");
    },

    skillDelete: async (file) => {
      const skill = findSkill(file);
      if (!skill.deletable) throw new PlatformError("只能删除能力中心安装的技能");
      skills.splice(skills.indexOf(skill), 1);
    },

    skillSetEnabled: async (file, enabled) => {
      findSkill(file).enabled = enabled;
    },

    mcpConfigRead: async (): Promise<McpConfigFile> => ({
      path: MOCK_MCP_PATH,
      text: mcpText,
      version: versionOf(mcpText),
      agents: { path: MOCK_AGENTS_MCP_PATH, text: agentsMcpText, error: null },
    }),

    mcpConfigWrite: async (text, version) => {
      if (version !== versionOf(mcpText))
        throw new PlatformError("mcp.json 已在别处被修改，请重新读取后再保存", MCP_CONFLICT);
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (e) {
        throw new PlatformError(`mcp.json 内容无效：${e instanceof Error ? e.message : e}`);
      }
      const obj = value as { mcpServers?: unknown };
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        (obj.mcpServers !== undefined &&
          (typeof obj.mcpServers !== "object" ||
            obj.mcpServers === null ||
            Array.isArray(obj.mcpServers)))
      )
        throw new PlatformError("mcp.json 内容无效：应为带 mcpServers 对象的 JSON 对象");
      mcpText = text;
      return versionOf(mcpText);
    },

    mcpList: async () => {
      let servers: Record<string, unknown> = {};
      const errors: string[] = [];
      try {
        servers = mcpText ? (JSON.parse(mcpText).mcpServers ?? {}) : {};
      } catch (e) {
        errors.push(`${MOCK_MCP_PATH}: ${e instanceof Error ? e.message : e}`);
      }
      let shared: Record<string, unknown> = {};
      try {
        shared = agentsMcpText ? (JSON.parse(agentsMcpText).mcpServers ?? {}) : {};
      } catch (e) {
        errors.push(`${MOCK_AGENTS_MCP_PATH}: ${e instanceof Error ? e.message : e}`);
      }
      const isObj = (v: unknown): v is Record<string, unknown> =>
        typeof v === "object" && v !== null && !Array.isArray(v);
      const isOverride = (v: Record<string, unknown>) =>
        v.command === undefined && v.url === undefined && v.type === undefined;
      // 只认自有键：`constructor`、`toString` 等原型上的名字不算用户写的条目
      const own = (map: Record<string, unknown>, name: string) =>
        Object.hasOwn(map, name) ? map[name] : undefined;
      const badArgs = (v: Record<string, unknown>) =>
        v.args !== undefined &&
        !(Array.isArray(v.args) && v.args.every((a) => typeof a === "string"));
      // 与 Core 一样：不合格的条目记进 errors，不列出、不连接
      const valid: [string, Record<string, unknown>, string][] = [];
      for (const [name, entry] of Object.entries(servers)) {
        // 覆盖 ~/.agents/mcp.json 服务器的条目在下面套用
        if (isObj(entry) && isOverride(entry) && isObj(own(shared, name))) continue;
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          errors.push(`${MOCK_MCP_PATH}: server "${name}" must be an object`);
          continue;
        }
        const rec = entry as Record<string, unknown>;
        if (badArgs(rec)) {
          errors.push(`${MOCK_MCP_PATH}: server "${name}": args must be an array of strings`);
          continue;
        }
        valid.push([name, rec, MOCK_MCP_PATH]);
      }
      // ~/.agents/mcp.json：用户级文件已定义同名服务器时冲突、用用户级那条；覆盖项改 enabled / exposure
      for (const [name, entry] of Object.entries(shared)) {
        if (!isObj(entry)) {
          errors.push(`${MOCK_AGENTS_MCP_PATH}: server "${name}" must be an object`);
          continue;
        }
        const mine = own(servers, name);
        if (mine !== undefined && !(isObj(mine) && isOverride(mine))) {
          errors.push(
            `${MOCK_AGENTS_MCP_PATH}: server "${name}" is also defined in ${MOCK_MCP_PATH}, which is used`,
          );
          continue;
        }
        // 与 Core 一样：覆盖项只能改 enabled / exposure / toolExposure，含其他键时报错、整条不套用（保留共享定义的启停）
        let override = isObj(mine) ? mine : null;
        if (override && Object.keys(override).some((k) => !OVERRIDE_KEYS.includes(k))) {
          errors.push(
            `${MOCK_MCP_PATH}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`,
          );
          override = null;
        }
        const merged = { ...entry, ...(override ?? {}) };
        if (badArgs(merged)) {
          errors.push(
            `${MOCK_AGENTS_MCP_PATH}: server "${name}": args must be an array of strings`,
          );
          continue;
        }
        valid.push([name, merged, MOCK_AGENTS_MCP_PATH]);
      }
      const reports = valid.map(([name, entry, source]) => {
        const enabled = entry.enabled !== false;
        const http = typeof entry.url === "string";
        const transport = http
          ? String(entry.url)
          : [entry.command, ...((entry.args as string[] | undefined) ?? [])].join(" ");
        const state = !enabled
          ? "disabled"
          : name.includes("fail")
            ? "failed"
            : http && name.includes("auth") && !loggedIn.has(name)
              ? "needs-auth"
              : "connected";
        return {
          name,
          scope: "global",
          source,
          enabled,
          exposure: typeof entry.exposure === "string" ? entry.exposure : "codemode",
          transport,
          state,
          tools: state === "connected" ? [`${name.replace(/-/g, "_")}_search`, "read"] : [],
          ...(state === "failed" ? { error: "spawn ENOENT" } : {}),
          ...(state === "needs-auth" ? { error: "HTTP 401: sign in required" } : {}),
        };
      });
      const failed = errors.length > 0 || reports.some((r) => r.enabled && r.state !== "connected");
      return cli(JSON.stringify({ servers: reports, errors }, null, 2), failed ? 1 : 0);
    },

    mcpLogin: async (name) => {
      loggedIn.add(name);
      return cli(`Signed in to ${name}.\n`);
    },

    mcpLogout: async (name) => {
      loggedIn.delete(name);
      return cli(`Signed out of ${name}.\n`);
    },
  };
}
