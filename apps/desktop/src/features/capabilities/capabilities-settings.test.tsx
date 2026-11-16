import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, setPlatformForTesting } from "@/lib/platform";
import { createMockPlatform } from "@/lib/platform/mock";
import { strings } from "@/lib/strings";
import { CapabilitiesSettings } from "./capabilities-settings";
import { entryFromForm } from "./mcp-settings";

const t = strings.settings.capabilities;
const ts = t.skills;
const tm = t.mcp;

function setup(patch: Partial<Platform> = {}) {
  const platform = { ...createMockPlatform(), ...patch };
  setPlatformForTesting(platform);
  render(<CapabilitiesSettings />);
  return platform;
}

async function row(listName: string, text: string) {
  const list = await screen.findByRole("list", { name: listName });
  const li = within(list)
    .getAllByRole("listitem")
    .find((x) => x.textContent?.includes(text));
  if (!li) throw new Error(`没有 ${text}`);
  return li;
}

const openMcp = () => fireEvent.mouseDown(screen.getByRole("tab", { name: t.tabs.mcp }));

describe("设置·能力中心·技能", () => {
  afterEach(() => setPlatformForTesting(undefined));

  it("列出技能：来源标记，~/.agents 的技能不能删除；启停写入", async () => {
    const platform = setup();
    const toggle = vi.spyOn(platform, "skillSetEnabled");
    const pdf = await row(ts.installedTitle, "pdf");
    expect(pdf.textContent).toContain(ts.scopeUser);
    expect(within(pdf).getByRole("button", { name: `删除 pdf` })).toBeTruthy();
    const agents = await row(ts.installedTitle, "release-notes");
    expect(agents.textContent).toContain(ts.scopeAgents);
    expect(within(agents).queryByRole("button", { name: /删除/ })).toBeNull();
    fireEvent.click(within(agents).getByRole("switch", { name: "启用 release-notes" }));
    await waitFor(() =>
      expect(toggle).toHaveBeenCalledWith(expect.stringContaining("release-notes"), false),
    );
  });

  it("GitHub 链接安装：缺 description 的技能不能选，同名时确认替换", async () => {
    const platform = setup();
    const install = vi.spyOn(platform, "skillInstall");
    fireEvent.change(screen.getByLabelText(ts.githubLabel), {
      target: { value: "https://github.com/acme/skills" },
    });
    fireEvent.click(screen.getByRole("button", { name: ts.githubRead }));
    const dialog = await screen.findByRole("dialog", { name: ts.dialog.title });
    const radios = within(dialog).getAllByRole("radio") as HTMLInputElement[];
    expect(radios[0]?.checked).toBe(true);
    expect(radios[1]?.disabled).toBe(true);
    expect(dialog.textContent).toContain("缺少 description");
    fireEvent.click(within(dialog).getByRole("button", { name: ts.dialog.install }));
    await waitFor(() =>
      expect(install).toHaveBeenCalledWith(
        expect.any(String),
        "skills/web-search",
        "web-search",
        false,
      ),
    );
    expect(await screen.findByText(`已安装“web-search”`)).toBeTruthy();
    await row(ts.installedTitle, "web-search");

    // 同名：先以 exists 拒绝，确认后带 overwrite 重试
    fireEvent.change(screen.getByLabelText(ts.githubLabel), {
      target: { value: "https://github.com/acme/skills/tree/main/skills/pdf" },
    });
    fireEvent.click(screen.getByRole("button", { name: ts.githubRead }));
    const second = await screen.findByRole("dialog", { name: ts.dialog.title });
    fireEvent.click(within(second).getByRole("button", { name: ts.dialog.install }));
    const confirm = await screen.findByRole("dialog", { name: "替换已有的技能“pdf”？" });
    fireEvent.click(within(confirm).getByRole("button", { name: ts.overwrite.confirm }));
    await waitFor(() =>
      expect(install).toHaveBeenLastCalledWith(expect.any(String), "", "pdf", true),
    );
  });

  it("取消安装时放弃暂存；目录名无效时不能安装", async () => {
    const platform = setup();
    const discard = vi.spyOn(platform, "skillDiscard");
    fireEvent.click(screen.getByRole("button", { name: ts.pickFolder }));
    const dialog = await screen.findByRole("dialog", { name: ts.dialog.title });
    // 中文目录名：建议名去掉不允许的字符后为空，需要用户填写
    const input = within(dialog).getByLabelText(new RegExp(ts.dialog.dirName)) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(dialog.textContent).toContain(ts.dialog.dirNameInvalid);
    expect(
      (within(dialog).getByRole("button", { name: ts.dialog.install }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(input, { target: { value: "new-project" } });
    expect(
      (within(dialog).getByRole("button", { name: ts.dialog.install }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: t.cancel }));
    await waitFor(() => expect(discard).toHaveBeenCalled());
  });

  it("zip：选到的不是 .zip 时提示", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: ts.pickZip }));
    expect(await screen.findByText(ts.notZip)).toBeTruthy();
  });

  it("删除前确认", async () => {
    const platform = setup();
    const remove = vi.spyOn(platform, "skillDelete");
    const pdf = await row(ts.installedTitle, "pdf");
    fireEvent.click(within(pdf).getByRole("button", { name: "删除 pdf" }));
    const dialog = await screen.findByRole("dialog", { name: "删除技能“pdf”？" });
    fireEvent.click(within(dialog).getByRole("button", { name: t.deleteConfirm }));
    await waitFor(() => expect(remove).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText("读取、合并、拆分 PDF，提取其中的文字与表格。")).toBeNull(),
    );
  });
});

describe("设置·能力中心·MCP", () => {
  afterEach(() => setPlatformForTesting(undefined));

  it("列出服务器，启停写入 mcp.json（启用删掉 enabled 键）", async () => {
    const platform = setup();
    openMcp();
    const fs = await row(tm.title, "filesystem");
    expect(fs.textContent).toContain(tm.transports.stdio);
    expect(fs.textContent).toContain(tm.exposures.codemode);
    fireEvent.click(within(fs).getByRole("switch", { name: "启用 filesystem" }));
    await waitFor(async () =>
      expect(
        JSON.parse((await platform.mcpConfigRead()).text ?? "").mcpServers.filesystem.enabled,
      ).toBe(false),
    );
    fireEvent.click(
      within(await row(tm.title, "filesystem")).getByRole("switch", { name: "启用 filesystem" }),
    );
    await waitFor(async () =>
      expect(
        "enabled" in JSON.parse((await platform.mcpConfigRead()).text ?? "").mcpServers.filesystem,
      ).toBe(false),
    );
  });

  it("测试连接显示状态；需要登录的服务器登录后连上", async () => {
    const platform = setup();
    const login = vi.spyOn(platform, "mcpLogin");
    openMcp();
    fireEvent.click(await screen.findByRole("button", { name: tm.test }));
    const docs = await row(tm.title, "docs-auth");
    await waitFor(() => expect(docs.textContent).toContain(tm.states["needs-auth"]));
    expect((await row(tm.title, "filesystem")).textContent).toContain("已连接 · 2 个工具");
    fireEvent.click(within(docs).getByRole("button", { name: "登录 docs-auth" }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("docs-auth"));
    expect(await screen.findByText("“docs-auth”已登录")).toBeTruthy();
  });

  it("用表单添加 stdio 服务器", async () => {
    const platform = setup();
    openMcp();
    fireEvent.click(await screen.findByRole("button", { name: tm.add }));
    const dialog = await screen.findByRole("dialog", { name: tm.dialog.addTitle });
    fireEvent.change(within(dialog).getByLabelText(tm.dialog.name), { target: { value: "git" } });
    fireEvent.change(within(dialog).getByLabelText(tm.dialog.command), {
      target: { value: 'uvx mcp-server-git --repository "C:\\my repo"' },
    });
    fireEvent.change(within(dialog).getByLabelText(tm.dialog.env), { target: { value: "A=1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: tm.dialog.save }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const text = (await platform.mcpConfigRead()).text ?? "";
    expect(JSON.parse(text).mcpServers.git).toEqual({
      command: "uvx",
      args: ["mcp-server-git", "--repository", "C:\\my repo"],
      env: { A: "1" },
    });
    await row(tm.title, "git");
  });

  it("名字冲突与校验错误显示在对话框里", async () => {
    setup();
    openMcp();
    fireEvent.click(await screen.findByRole("button", { name: tm.add }));
    const dialog = await screen.findByRole("dialog", { name: tm.dialog.addTitle });
    fireEvent.change(within(dialog).getByLabelText(tm.dialog.name), {
      target: { value: "docs_auth" },
    });
    fireEvent.change(within(dialog).getByLabelText(tm.dialog.command), { target: { value: "x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: tm.dialog.save }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("冲突");
  });

  it("粘贴 Claude Desktop 配置添加多个服务器", async () => {
    const platform = setup();
    openMcp();
    fireEvent.click(await screen.findByRole("button", { name: tm.add }));
    const dialog = await screen.findByRole("dialog", { name: tm.dialog.addTitle });
    fireEvent.mouseDown(within(dialog).getByRole("tab", { name: tm.dialog.modes.json }));
    fireEvent.change(within(dialog).getByLabelText(tm.dialog.json), {
      target: {
        value: JSON.stringify({
          mcpServers: { a: { command: "x" }, b: { url: "https://b.example/mcp" } },
        }),
      },
    });
    expect(dialog.textContent).toContain("将添加：a、b");
    fireEvent.click(within(dialog).getByRole("button", { name: tm.dialog.save }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const servers = JSON.parse((await platform.mcpConfigRead()).text ?? "").mcpServers;
    expect(Object.keys(servers)).toEqual(["filesystem", "docs-auth", "a", "b"]);
  });

  it("编辑保留表单不管的字段，可以改名", async () => {
    const platform = setup();
    const before = await platform.mcpConfigRead();
    const seeded = JSON.parse(before.text ?? "");
    seeded.mcpServers["docs-auth"].oauth = { clientId: "c" };
    await platform.mcpConfigWrite(JSON.stringify(seeded, null, 2), before.version);
    openMcp();
    const docs = await row(tm.title, "docs-auth");
    fireEvent.click(within(docs).getByRole("button", { name: "编辑 docs-auth" }));
    const dialog = await screen.findByRole("dialog", { name: tm.dialog.editTitle });
    fireEvent.change(within(dialog).getByLabelText(tm.dialog.name), { target: { value: "docs" } });
    fireEvent.change(within(dialog).getByLabelText(tm.dialog.exposure), {
      target: { value: "direct" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: tm.dialog.save }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const servers = JSON.parse((await platform.mcpConfigRead()).text ?? "").mcpServers;
    expect(Object.keys(servers)).toEqual(["filesystem", "docs"]);
    expect(servers.docs).toEqual({
      url: "https://example.com/mcp",
      oauth: { clientId: "c" },
      exposure: "direct",
    });
  });

  it("文件在别处被改过：重新读取并提示再操作一次", async () => {
    const platform = setup();
    openMcp();
    const fs = await row(tm.title, "filesystem");
    // 界面读出之后，别处改了文件
    const current = await platform.mcpConfigRead();
    await platform.mcpConfigWrite(
      JSON.stringify({ mcpServers: { filesystem: { command: "npx" }, other: { command: "y" } } }),
      current.version,
    );
    fireEvent.click(within(fs).getByRole("button", { name: "删除 filesystem" }));
    const dialog = await screen.findByRole("dialog", { name: "删除 MCP 服务器“filesystem”？" });
    fireEvent.click(within(dialog).getByRole("button", { name: t.deleteConfirm }));
    expect(await screen.findByText(tm.conflict)).toBeTruthy();
    await row(tm.title, "other");
  });

  it("mcp.json 无法解析时只读并可重新读取", async () => {
    setup({
      mcpConfigRead: async () => ({ path: "C:\\x\\mcp.json", text: "{", version: "v" }),
    });
    openMcp();
    expect(await screen.findByText(tm.parseFailed)).toBeTruthy();
    expect((screen.getByRole("button", { name: tm.add }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("entryFromForm", () => {
  const form = {
    name: "x",
    transport: "http" as const,
    command: "",
    env: "",
    cwd: "",
    url: " https://x/mcp ",
    headers: "Authorization: Bearer t",
    description: "",
    exposure: "codemode" as const,
  };

  it("换成 HTTP 时去掉 stdio 字段，保留 timeout 等其他字段", () => {
    expect(entryFromForm(form, { command: "a", args: ["b"], env: { A: "1" }, timeout: 5 })).toEqual(
      {
        timeout: 5,
        url: "https://x/mcp",
        headers: { Authorization: "Bearer t" },
      },
    );
  });

  it("换成 stdio 时去掉 oauth 与 auth；缺命令或地址时报错", () => {
    expect(
      entryFromForm(
        { ...form, transport: "stdio", command: "node a.js", exposure: "hidden" },
        { url: "https://x", oauth: {}, auth: { provider: "p" }, enabled: false },
      ),
    ).toEqual({ enabled: false, command: "node", args: ["a.js"], exposure: "hidden" });
    expect(() => entryFromForm({ ...form, transport: "stdio" }, undefined)).toThrow(
      tm.dialog.commandRequired,
    );
    expect(() => entryFromForm({ ...form, url: " " }, undefined)).toThrow(tm.dialog.urlRequired);
  });
});
