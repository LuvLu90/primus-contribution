import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setPlatformForTesting } from "@/lib/platform";
import { createMockPlatform } from "@/lib/platform/mock";
import { strings } from "@/lib/strings";
import { indexText, pickSuggestions } from "./chat-panel";
import {
  type ComposerCapability,
  capabilityKey,
  loadCapabilities,
  mergeCapabilities,
  stripCapabilities,
  useComposerCapabilities,
  withCapabilities,
} from "./composer-capabilities";

const cap = (
  kind: ComposerCapability["kind"],
  name: string,
  scope: ComposerCapability["scope"] = "global",
): ComposerCapability => ({ kind, name, scope, description: null });

describe("“+”菜单的技能与 MCP", () => {
  it("同类同名去重（项目优先），技能在前、项目在前、按名称排序；同名的技能与 MCP 互不冲突", () => {
    const merged = mergeCapabilities([
      cap("skill", "review", "project"),
      cap("mcp", "github"),
      cap("skill", "lint"),
      cap("skill", "review"),
      cap("mcp", "review"),
      cap("skill", "deploy", "project"),
    ]);
    expect(merged.map((c) => `${capabilityKey(c)}@${c.scope}`)).toEqual([
      "mcp:github@global",
      "mcp:review@global",
      "skill:deploy@project",
      "skill:review@project",
      "skill:lint@global",
    ]);
  });

  it("发送时在正文前注明所选技能与 MCP，每项带 /；没选时原样发送", () => {
    expect(withCapabilities("你好", [])).toBe("你好");
    const text = withCapabilities("修一下测试", [
      cap("skill", "review"),
      cap("mcp", "github"),
      cap("skill", "lint"),
    ]);
    expect(text).toBe(
      `${strings.chat.capabilities.useSkills.replace("{names}", "/review、/lint")}\n` +
        `${strings.chat.capabilities.useMcp.replace("{names}", "/github")}\n\n修一下测试`,
    );
    expect(withCapabilities("", [cap("skill", "review")])).not.toMatch(/\n$/);
  });

  it("图片生成模式：出图说明排在最前，索引里不显示", () => {
    const text = withCapabilities("一只橘猫", [cap("skill", "review")], { image: true });
    expect(text.split("\n")[0]).toBe(strings.chat.capabilities.useImage);
    expect(stripCapabilities(text).body).toBe("一只橘猫");
  });
});

describe("欢迎页建议", () => {
  it("从建议池随机取不重复的 n 条", () => {
    let i = 0;
    const seq = [0.99, 0, 0.5];
    const picked = pickSuggestions(["a", "b", "c", "d"], 3, () => seq[i++] ?? 0);
    expect(picked).toEqual(["d", "a", "c"]);
    expect(pickSuggestions(["a"], 3)).toEqual(["a"]);
  });
});

describe("项目里的技能与 MCP", () => {
  it("技能用 frontmatter 里的名称；mcp.json 无效时不把诊断占位值当成服务器", async () => {
    const platform = createMockPlatform({ intervalMs: 1, batchSize: 50 });
    setPlatformForTesting(platform);
    vi.spyOn(platform, "workspaceInspect").mockResolvedValue({
      path: "/p",
      agentsMd: null,
      agentsMdTruncated: false,
      extensions: [],
      skills: ["tools/review"],
      mcpServers: ["mcp.json"],
      agentsMcpServers: [],
      agentsSkills: [".agents/skills/lint"],
    });
    const files: Record<string, string> = {
      "/p/.primus/skills/tools/review/SKILL.md": "---\nname: audit\ndescription: 审查代码\n---\n",
      "/p/.agents/skills/lint/SKILL.md": "---\nname: lint\ndescription: 检查格式\n---\n",
      "/p/.primus/mcp.json": "{ 坏的",
    };
    vi.spyOn(platform, "previewFile").mockImplementation(async (path) =>
      path in files
        ? { kind: "text", text: files[path] as string, truncated: false, size: 1 }
        : Promise.reject(new Error("missing")),
    );
    const list = await loadCapabilities({
      path: "/p",
      name: "p",
      trusted: true,
      needsTrust: false,
    });
    const project = list.filter((c) => c.scope === "project").map(capabilityKey);
    expect(project).toEqual(["skill:audit", "skill:lint"]);
    setPlatformForTesting(undefined);
  });
});

describe("MCP：.agents/mcp.json 与同级文件（ADR 0022）", () => {
  it("项目：两处都列出，同名取 .primus，.primus 的覆盖项能停用 .agents 的服务器，.agents 里的 auth 不列", async () => {
    const platform = createMockPlatform({ intervalMs: 1, batchSize: 50 });
    setPlatformForTesting(platform);
    vi.spyOn(platform, "workspaceInspect").mockResolvedValue({
      path: "/p",
      agentsMd: null,
      agentsMdTruncated: false,
      extensions: [],
      skills: [],
      mcpServers: ["github", "off"],
      agentsMcpServers: ["github", "docs", "off", "keyed"],
      agentsSkills: [],
    });
    const files: Record<string, string> = {
      "/p/.primus/mcp.json": JSON.stringify({
        mcpServers: { github: { command: "gh-mcp" }, off: { enabled: false } },
      }),
      "/p/.agents/mcp.json": JSON.stringify({
        mcpServers: {
          github: { command: "other" },
          docs: { url: "https://docs.example.com/mcp", description: "文档" },
          off: { command: "off" },
          keyed: { url: "https://k.example.com/mcp", auth: { provider: "demo" } },
        },
      }),
    };
    vi.spyOn(platform, "previewFile").mockImplementation(async (path) =>
      path in files
        ? { kind: "text", text: files[path] as string, truncated: false, size: 1 }
        : Promise.reject(new Error("missing")),
    );
    const list = await loadCapabilities({
      path: "/p",
      name: "p",
      trusted: true,
      needsTrust: false,
    });
    const project = list.filter((c) => c.scope === "project");
    expect(project.map(capabilityKey)).toEqual(["mcp:docs", "mcp:github"]);
    expect(project.find((c) => c.name === "docs")?.description).toBe("文档");
    setPlatformForTesting(undefined);
  });

  it("全局：~/.agents/mcp.json 的服务器也列出；用户级覆盖项停用的不列", async () => {
    const platform = createMockPlatform({ intervalMs: 1, batchSize: 50 });
    setPlatformForTesting(platform);
    vi.spyOn(platform, "mcpConfigRead").mockResolvedValue({
      path: "/core/mcp.json",
      text: JSON.stringify({ mcpServers: { a: { command: "a" }, hidden: { enabled: false } } }),
      version: "v",
      agents: {
        path: "/home/.agents/mcp.json",
        text: JSON.stringify({
          mcpServers: { a: { command: "x" }, shared: { command: "s" }, hidden: { command: "h" } },
        }),
        error: null,
      },
    });
    const list = await loadCapabilities(null);
    expect(list.filter((c) => c.kind === "mcp").map(capabilityKey)).toEqual([
      "mcp:a",
      "mcp:shared",
    ]);
    setPlatformForTesting(undefined);
  });
});

describe("提问索引", () => {
  it("去掉能力说明，只留正文；没有正文时用能力说明", () => {
    const sel = [cap("skill", "review")];
    expect(indexText(withCapabilities("修一下测试", sel), false)).toBe("修一下测试");
    expect(indexText(withCapabilities("", sel), false)).toContain("/review");
  });
});

describe("菜单开着时信任变化", () => {
  it("清空列表后立即重读，不停在读取中；菜单关着时只清空", async () => {
    setPlatformForTesting(createMockPlatform());
    const ws = { path: "/w", name: "w", trusted: false, needsTrust: false };
    const { result, rerender } = renderHook(({ w }) => useComposerCapabilities(w), {
      initialProps: { w: ws },
    });
    act(() => result.current.setOpen(true));
    await waitFor(() => expect(result.current.items).not.toBeNull());
    rerender({ w: { ...ws, trusted: true } });
    await waitFor(() => expect(result.current.items).not.toBeNull());
    act(() => result.current.setOpen(false));
    rerender({ w: { ...ws, trusted: false } });
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.items).toBeNull();
  });
});
