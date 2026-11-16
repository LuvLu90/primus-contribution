import { describe, expect, it } from "vitest";
import { MCP_CONFLICT, PlatformError, SKILL_EXISTS } from "../types";
import { createMockCapabilities } from "./capabilities";
import { createMockPlatform } from "./index";

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof PlatformError ? (e.code ?? "none") : "other";
  }
  return "resolved";
};

describe("mock 能力中心", () => {
  it("挂在 mock 平台上", async () => {
    const platform = createMockPlatform();
    expect((await platform.skillsList()).map((s) => s.dirName)).toEqual(["pdf", "release-notes"]);
    expect((await platform.mcpConfigRead()).text).toContain("filesystem");
  });

  it("技能：暂存、整个来源安装、同名需确认覆盖、启停、只删用户目录下的技能", async () => {
    const c = createMockCapabilities();
    await expect(c.skillStage({ kind: "github", url: "https://gitlab.com/a/b" })).rejects.toThrow(
      "GitHub",
    );
    const repo = await c.skillStage({ kind: "github", url: "https://github.com/acme/skills" });
    expect(repo.label).toBe("skills");
    expect(repo.candidates.map((x) => x.dirName)).toEqual(["web-search", "broken"]);
    // Core 的 ref 写法
    const hashRef = await c.skillStage({
      kind: "github",
      url: "https://github.com/acme/skills#feature/x",
    });
    expect(hashRef.label).toBe("skills");
    await c.skillDiscard(hashRef.stageId);
    // 一次装入仓库里的全部技能
    expect(await c.skillInstall(repo.stageId, "acme", false)).toMatch(/skills\\acme$/);
    const installed = (await c.skillsList()).filter((s) => s.package === "acme");
    expect(installed.map((s) => s.dirName)).toEqual(["web-search", "broken"]);
    expect(installed[0]?.file).toMatch(/skills\\acme\\skills\\web-search\\SKILL\.md$/);

    const sub = await c.skillStage({
      kind: "github",
      url: "https://github.com/acme/skills/blob/main/skills/pdf/SKILL.md",
    });
    expect(sub).toMatchObject({ label: "pdf", candidates: [{ path: "", dirName: "pdf" }] });
    expect(await codeOf(c.skillInstall(sub.stageId, "pdf", false))).toBe(SKILL_EXISTS);
    await c.skillInstall(sub.stageId, "pdf", true);
    // 安装后暂存删除
    await expect(c.skillInstall(sub.stageId, "pdf", true)).rejects.toThrow("暂存");

    await expect(c.skillStage({ kind: "zip", path: "C:\\a\\x.txt" })).rejects.toThrow(".zip");
    const zip = await c.skillStage({ kind: "zip", path: "C:\\a\\my-skill.zip" });
    expect(zip.candidates[0]?.dirName).toBe("my-skill");
    await expect(c.skillInstall(zip.stageId, "../x", false)).rejects.toThrow("目录名");
    expect(await c.skillInstall(zip.stageId, "my-skill", false)).toMatch(/skills\\my-skill$/);
    const file = (await c.skillsList()).find((s) => s.dirName === "my-skill")?.file ?? "";
    expect(file).toMatch(/skills\\my-skill\\SKILL\.md$/);

    const folder = await c.skillStage({ kind: "folder", path: "D:\\work\\notes\\" });
    expect(folder.candidates[0]?.dirName).toBe("notes");
    await c.skillDiscard(folder.stageId);
    await expect(c.skillDiscard(folder.stageId)).rejects.toThrow();

    await c.skillSetEnabled(file, false);
    expect((await c.skillsList()).find((s) => s.file === file)?.enabled).toBe(false);
    const agents = (await c.skillsList()).find((s) => s.scope === "agents");
    if (!agents) throw new Error("缺少 .agents 技能");
    await expect(c.skillDelete(agents.file)).rejects.toThrow("只能删除");
    await c.skillDelete(file);
    expect((await c.skillsList()).some((s) => s.file === file)).toBe(false);
  });

  it("mcp.json：版本不符以 conflict 拒绝，写入返回新版本；内容须为对象", async () => {
    const c = createMockCapabilities({ empty: true });
    const first = await c.mcpConfigRead();
    expect(first).toMatchObject({ text: null, version: "" });
    const v1 = await c.mcpConfigWrite('{"mcpServers": {}}\n', "");
    expect(v1).not.toBe("");
    expect(await codeOf(c.mcpConfigWrite("{}", ""))).toBe(MCP_CONFLICT);
    await expect(c.mcpConfigWrite("[]", v1)).rejects.toThrow("无效");
    await expect(c.mcpConfigWrite('{"mcpServers": 1}', v1)).rejects.toThrow("无效");
    expect((await c.mcpConfigRead()).version).toBe(v1);
  });

  it("mcp list：连接状态、需要登录与登录后连上、停用", async () => {
    const c = createMockCapabilities();
    const parse = async () => JSON.parse((await c.mcpList()).stdout);
    const before = await c.mcpList();
    expect(before.code).toBe(1);
    const list = JSON.parse(before.stdout);
    expect(list.servers.map((s: { state: string }) => s.state)).toEqual([
      "connected",
      "needs-auth",
    ]);
    await c.mcpLogin("docs-auth");
    expect((await parse()).servers[1].state).toBe("connected");
    expect((await c.mcpList()).code).toBe(0);
    await c.mcpLogout("docs-auth");
    const text = (await c.mcpConfigRead()).text ?? "";
    const version = (await c.mcpConfigRead()).version;
    const next = JSON.parse(text);
    next.mcpServers.filesystem.enabled = false;
    await c.mcpConfigWrite(JSON.stringify(next), version);
    expect((await parse()).servers[0]).toMatchObject({ state: "disabled", tools: [] });
  });
});
