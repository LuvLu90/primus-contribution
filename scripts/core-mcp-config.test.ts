// Core 的 MCP 配置读取（ADR 0022）：`<agentDir>/mcp.json` 与 `~/.agents/mcp.json` 同为全局级，
// `<cwd>/.primus/mcp.json` 与 `<cwd>/.agents/mcp.json` 同为项目级；同级冲突取 `.primus` / agentDir 一侧，
// `.agents/` 下的文件只读不写。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// agent-core 不在 pnpm 工作区内（没有安装依赖）：它的工作区包由根 vitest 配置沿用 Core 自己的映射指到源码，
// 用到的第三方依赖这里换成占位。
vi.mock("cross-spawn", () => ({
  default: () => {
    throw new Error("测试中不启动子进程");
  },
}));

// `primus mcp add/remove` 只用到配置读写；其余依赖换成占位。
vi.mock("chalk", () => ({
  default: { bold: (text: string) => text, dim: (text: string) => text },
}));
vi.mock("../agent-core/packages/coding-agent/src/core/model-runtime.ts", () => ({
  ModelRuntime: class {},
}));
vi.mock("../agent-core/packages/coding-agent/src/core/trust-manager.ts", () => ({
  ProjectTrustStore: class {
    get() {
      return true;
    }
  },
}));
vi.mock("../agent-core/packages/coding-agent/src/extensions/mcp/runtime.ts", () => ({}));

const config = await import("../agent-core/packages/coding-agent/src/extensions/mcp/config.ts");
const { planRadiusMcpServer } = await import(
  "../agent-core/packages/coding-agent/src/core/radius-mcp.ts"
);
const { runMcpCommand } = await import(
  "../agent-core/packages/coding-agent/src/extensions/mcp/cli.ts"
);
const { RADIUS_MCP_URL } = await import("../agent-core/packages/coding-agent/src/core/radius.ts");
const {
  loadMcpConfig,
  getMcpConfigWriteTarget,
  updateMcpServerConfig,
  addMcpServerConfig,
  removeMcpServerConfig,
} = config;

let root: string;
let home: string;
let agentDir: string;
let cwd: string;

const write = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const globalFile = () => join(agentDir, "mcp.json");
const homeAgentsFile = () => join(home, ".agents", "mcp.json");
const projectFile = () => join(cwd, ".primus", "mcp.json");
const projectAgentsFile = () => join(cwd, ".agents", "mcp.json");
const load = (projectTrusted = true, dir = cwd) =>
  loadMcpConfig({ agentDir, cwd: dir, projectTrusted, homeDir: home });
const server = (loaded: ReturnType<typeof load>, name: string) =>
  loaded.servers.find((entry) => entry.name === name);
const stdio = (command: string) => ({ command });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "primus-mcp-"));
  home = join(root, "home");
  agentDir = join(root, "data", "agent");
  cwd = join(root, "work", "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("全局级：agentDir/mcp.json 与 ~/.agents/mcp.json", () => {
  it("两处的服务器都读入，都是 global，~/.agents 里也允许 auth", () => {
    write(globalFile(), { mcpServers: { a: stdio("a") } });
    write(homeAgentsFile(), {
      mcpServers: { b: { url: "https://example.com/mcp", auth: { provider: "demo" } } },
    });
    const loaded = load(false);
    expect(loaded.errors).toEqual([]);
    expect(server(loaded, "a")).toMatchObject({ scope: "global", source: globalFile() });
    expect(server(loaded, "b")).toMatchObject({
      scope: "global",
      source: homeAgentsFile(),
      overrideTarget: globalFile(),
      config: { auth: { provider: "demo" } },
    });
  });

  it("同名服务器报冲突，保留 agentDir 那一条", () => {
    write(globalFile(), { mcpServers: { a: stdio("primus") } });
    write(homeAgentsFile(), { mcpServers: { a: stdio("agents") } });
    const loaded = load(false);
    expect(server(loaded, "a")).toMatchObject({
      source: globalFile(),
      config: { command: "primus" },
    });
    expect(loaded.errors).toEqual([
      `${homeAgentsFile()}: server "a" is also defined in ${globalFile()}, which is used`,
    ]);
  });

  it("只差 - 与 _ 的名字同样算同级冲突", () => {
    write(globalFile(), { mcpServers: { "my-tools": stdio("primus") } });
    write(homeAgentsFile(), { mcpServers: { my_tools: stdio("agents") } });
    const loaded = load(false);
    expect(loaded.servers.map((entry) => entry.name)).toEqual(["my-tools"]);
    expect(loaded.errors).toEqual([
      `${homeAgentsFile()}: server "my_tools" conflicts with "my-tools" in ${globalFile()}, which is used`,
    ]);
  });

  it("agentDir/mcp.json 可以只写 enabled/exposure/toolExposure 覆盖 ~/.agents 的服务器", () => {
    write(globalFile(), { mcpServers: { b: { enabled: false } } });
    write(homeAgentsFile(), { mcpServers: { b: { url: "https://example.com/mcp" } } });
    const loaded = load(false);
    expect(loaded.errors).toEqual([]);
    expect(server(loaded, "b")).toMatchObject({
      source: homeAgentsFile(),
      override: globalFile(),
      config: { url: "https://example.com/mcp", enabled: false },
    });
  });

  it("覆盖项只能改三个键；~/.agents 里没有可覆盖对象的覆盖项报错", () => {
    write(globalFile(), {
      mcpServers: { b: { enabled: false, env: { X: "1" } }, c: { enabled: false } },
    });
    write(homeAgentsFile(), { mcpServers: { b: stdio("b"), d: { exposure: "direct" } } });
    const loaded = load(false);
    expect(loaded.errors).toEqual([
      `${globalFile()}: server "b": an override can only set enabled, exposure, toolExposure`,
      `${globalFile()}: server "c" needs "command" or "url", or a server in ~/.agents/mcp.json to override`,
      `${homeAgentsFile()}: server "d" needs "command" or "url", or a server in ~/.agents/mcp.json to override`,
    ]);
    expect(server(loaded, "b")?.config.enabled).toBeUndefined();
  });

  it("autoEnableCodemode 两处不一致时报冲突，取 agentDir 的值", () => {
    write(globalFile(), { autoEnableCodemode: false, mcpServers: {} });
    write(homeAgentsFile(), { autoEnableCodemode: true, mcpServers: {} });
    const loaded = load(false);
    expect(loaded.autoEnableCodemode).toBe(false);
    expect(loaded.errors).toEqual([
      `${homeAgentsFile()}: autoEnableCodemode conflicts with ${globalFile()}, which is used`,
    ]);
  });

  it("两处一致或只有一处设置时不报错", () => {
    write(homeAgentsFile(), { autoEnableCodemode: false, mcpServers: {} });
    expect(load(false)).toMatchObject({ autoEnableCodemode: false, errors: [] });
    write(globalFile(), { autoEnableCodemode: false, mcpServers: {} });
    expect(load(false)).toMatchObject({ autoEnableCodemode: false, errors: [] });
  });
});

describe("项目级：.primus/mcp.json 与 .agents/mcp.json", () => {
  it("未信任的项目两处都不读", () => {
    write(projectFile(), { mcpServers: { p: stdio("p") } });
    write(projectAgentsFile(), { mcpServers: { q: stdio("q") } });
    const loaded = load(false);
    expect(loaded.servers).toEqual([]);
    expect(loaded.projectConfig).toBeUndefined();
  });

  it("已信任的项目两处都读，都是 project", () => {
    write(projectFile(), { mcpServers: { p: stdio("p") } });
    write(projectAgentsFile(), { mcpServers: { q: stdio("q") } });
    const loaded = load(true);
    expect(loaded.errors).toEqual([]);
    expect(server(loaded, "p")).toMatchObject({ scope: "project", source: projectFile() });
    expect(server(loaded, "q")).toMatchObject({
      scope: "project",
      source: projectAgentsFile(),
      overrideTarget: projectFile(),
    });
  });

  it("同名服务器报冲突，保留 .primus 那一条", () => {
    write(projectFile(), { mcpServers: { p: stdio("primus") } });
    write(projectAgentsFile(), { mcpServers: { p: stdio("agents") } });
    const loaded = load(true);
    expect(server(loaded, "p")).toMatchObject({
      source: projectFile(),
      config: { command: "primus" },
    });
    expect(loaded.errors).toEqual([
      `${projectAgentsFile()}: server "p" is also defined in ${projectFile()}, which is used`,
    ]);
  });

  it("项目级覆盖全局级同名服务器（含 ~/.agents 来源）", () => {
    write(globalFile(), { mcpServers: { a: stdio("global") } });
    write(homeAgentsFile(), { mcpServers: { b: stdio("global-agents") } });
    write(projectAgentsFile(), {
      mcpServers: { a: stdio("project-agents"), b: stdio("project-agents") },
    });
    const loaded = load(true);
    expect(loaded.errors).toEqual([]);
    expect(server(loaded, "a")).toMatchObject({ scope: "project", source: projectAgentsFile() });
    expect(server(loaded, "b")).toMatchObject({ scope: "project", source: projectAgentsFile() });
  });

  it("项目级（含 .agents）不许 auth", () => {
    write(projectAgentsFile(), {
      mcpServers: { r: { url: "https://example.com/mcp", auth: { provider: "demo" } } },
    });
    const loaded = load(true);
    expect(loaded.servers).toEqual([]);
    expect(loaded.errors).toEqual([
      `${projectAgentsFile()}: server "r": auth is only allowed in the global mcp.json`,
    ]);
  });

  it(".agents 里的覆盖项可以关掉全局服务器", () => {
    write(globalFile(), {
      mcpServers: { a: { url: "https://example.com/mcp", auth: { provider: "demo" } } },
    });
    write(projectAgentsFile(), { mcpServers: { a: { enabled: false } } });
    const loaded = load(true);
    expect(loaded.errors).toEqual([]);
    expect(server(loaded, "a")).toMatchObject({
      scope: "global",
      override: projectAgentsFile(),
      config: { enabled: false, auth: { provider: "demo" } },
    });
  });

  it("同级两处都覆盖同一全局服务器时报冲突，取 .primus", () => {
    write(globalFile(), { mcpServers: { a: stdio("a") } });
    write(projectFile(), { mcpServers: { a: { exposure: "direct" } } });
    write(projectAgentsFile(), { mcpServers: { a: { enabled: false } } });
    const loaded = load(true);
    expect(server(loaded, "a")).toMatchObject({
      override: projectFile(),
      config: { exposure: "direct" },
    });
    expect(server(loaded, "a")?.config.enabled).toBeUndefined();
    expect(loaded.errors).toEqual([
      `${projectAgentsFile()}: server "a" is also overridden in ${projectFile()}, which is used`,
    ]);
  });

  it(".agents 里覆盖同级 .primus 定义的服务器算冲突", () => {
    write(projectFile(), { mcpServers: { p: stdio("p") } });
    write(projectAgentsFile(), { mcpServers: { p: { enabled: false } } });
    const loaded = load(true);
    expect(server(loaded, "p")?.config.enabled).toBeUndefined();
    expect(loaded.errors).toEqual([
      `${projectAgentsFile()}: server "p" is also defined in ${projectFile()}, which is used`,
    ]);
  });

  it(".primus 里的覆盖项作用于同级 .agents 定义的服务器", () => {
    write(projectFile(), { mcpServers: { q: { enabled: false } } });
    write(projectAgentsFile(), { mcpServers: { q: stdio("q") } });
    const loaded = load(true);
    expect(loaded.errors).toEqual([]);
    expect(server(loaded, "q")).toMatchObject({
      scope: "project",
      source: projectAgentsFile(),
      override: projectFile(),
      config: { command: "q", enabled: false },
    });
  });

  it("项目级 autoEnableCodemode 冲突取 .primus，并覆盖全局值", () => {
    write(globalFile(), { autoEnableCodemode: true, mcpServers: {} });
    write(projectFile(), { autoEnableCodemode: false, mcpServers: {} });
    write(projectAgentsFile(), { autoEnableCodemode: true, mcpServers: {} });
    const loaded = load(true);
    expect(loaded.autoEnableCodemode).toBe(false);
    expect(loaded.errors).toEqual([
      `${projectAgentsFile()}: autoEnableCodemode conflicts with ${projectFile()}, which is used`,
    ]);
  });

  it("只读工作区本级的 .agents/mcp.json，不往上级目录找", () => {
    write(join(cwd, "..", ".agents", "mcp.json"), { mcpServers: { parent: stdio("parent") } });
    const sub = join(cwd, "sub");
    mkdirSync(sub);
    expect(load(true).servers).toEqual([]);
    expect(load(true, sub).servers).toEqual([]);
  });

  it("工作区就是主目录时 .agents/mcp.json 只按全局级读一次（auth 仍有效）", () => {
    write(homeAgentsFile(), {
      mcpServers: { r: { url: "https://example.com/mcp", auth: { provider: "demo" } } },
    });
    const loaded = load(true, home);
    expect(loaded.errors).toEqual([]);
    expect(server(loaded, "r")).toMatchObject({
      scope: "global",
      config: { auth: { provider: "demo" } },
    });
  });

  it("解析失败的 .agents/mcp.json 报错，不影响其他文件", () => {
    write(projectFile(), { mcpServers: { p: stdio("p") } });
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    writeFileSync(projectAgentsFile(), "{ not json");
    const loaded = load(true);
    expect(loaded.servers.map((entry) => entry.name)).toEqual(["p"]);
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]).toContain(projectAgentsFile());
  });
});

describe("写入：/mcp 的改动不碰 .agents/", () => {
  const snapshot = (path: string) => ({
    text: readFileSync(path, "utf8"),
    mtime: statSync(path).mtimeMs,
  });

  it("项目 .agents 的服务器写成 .primus/mcp.json 里的覆盖项", () => {
    write(projectAgentsFile(), { mcpServers: { q: stdio("q") } });
    const before = snapshot(projectAgentsFile());
    const entry = server(load(true), "q");
    if (!entry) throw new Error("q 未读到");
    const target = getMcpConfigWriteTarget(entry);
    expect(target).toEqual({ path: projectFile(), override: true });
    updateMcpServerConfig(
      target.path,
      entry.name,
      { enabled: false },
      { override: target.override },
    );
    updateMcpServerConfig(
      target.path,
      entry.name,
      { exposure: "codemode" },
      { override: target.override },
    );
    expect(snapshot(projectAgentsFile())).toEqual(before);
    expect(JSON.parse(readFileSync(projectFile(), "utf8"))).toEqual({
      mcpServers: { q: { enabled: false, exposure: "codemode" } },
    });
    const reloaded = load(true);
    expect(reloaded.errors).toEqual([]);
    expect(server(reloaded, "q")).toMatchObject({
      source: projectAgentsFile(),
      override: projectFile(),
    });
    expect(server(reloaded, "q")?.config.enabled).toBe(false);
  });

  it("~/.agents 的服务器写成 agentDir/mcp.json 里的覆盖项", () => {
    write(globalFile(), { mcpServers: { a: stdio("a") } });
    write(homeAgentsFile(), { mcpServers: { b: stdio("b") } });
    const before = snapshot(homeAgentsFile());
    const entry = server(load(false), "b");
    if (!entry) throw new Error("b 未读到");
    const target = getMcpConfigWriteTarget(entry);
    expect(target).toEqual({ path: globalFile(), override: true });
    updateMcpServerConfig(
      target.path,
      entry.name,
      { exposure: "direct" },
      { override: target.override },
    );
    expect(snapshot(homeAgentsFile())).toEqual(before);
    expect(JSON.parse(readFileSync(globalFile(), "utf8"))).toEqual({
      mcpServers: { a: { command: "a" }, b: { exposure: "direct" } },
    });
    const reloaded = load(false);
    expect(reloaded.errors).toEqual([]);
    expect(server(reloaded, "b")).toMatchObject({
      override: globalFile(),
      config: { command: "b", exposure: "direct" },
    });
  });

  it("已有覆盖项时写回同一个覆盖项", () => {
    write(globalFile(), { mcpServers: { b: { enabled: false } } });
    write(homeAgentsFile(), { mcpServers: { b: stdio("b") } });
    const entry = server(load(false), "b");
    if (!entry) throw new Error("b 未读到");
    expect(getMcpConfigWriteTarget(entry)).toEqual({ path: globalFile(), override: true });
  });

  it("自己文件里定义的服务器照旧写回定义处", () => {
    write(projectFile(), { mcpServers: { p: stdio("p") } });
    const entry = server(load(true), "p");
    if (!entry) throw new Error("p 未读到");
    expect(getMcpConfigWriteTarget(entry)).toEqual({ path: projectFile(), override: false });
  });

  it("写 .agents/mcp.json 的调用一律拒绝", () => {
    write(projectAgentsFile(), { mcpServers: { q: stdio("q") } });
    const before = snapshot(projectAgentsFile());
    expect(() => updateMcpServerConfig(projectAgentsFile(), "q", { enabled: false })).toThrow(
      /never edited/,
    );
    expect(() => addMcpServerConfig(projectAgentsFile(), "x", { command: "x" })).toThrow(
      /never edited/,
    );
    expect(() => removeMcpServerConfig(projectAgentsFile(), "q")).toThrow(/never edited/);
    expect(() => addMcpServerConfig(homeAgentsFile(), "x", { command: "x" })).toThrow(
      /never edited/,
    );
    expect(snapshot(projectAgentsFile())).toEqual(before);
  });
});

describe("Radius MCP 计划", () => {
  it("~/.agents 里已有同一登录的 Radius 服务器时不再提议", () => {
    write(homeAgentsFile(), {
      mcpServers: { radius: { url: RADIUS_MCP_URL, auth: { provider: "radius" } } },
    });
    vi.stubEnv("HOME", home);
    expect(planRadiusMcpServer("radius", agentDir, cwd)).toBeUndefined();
  });

  it("~/.agents 里的 Radius 服务器不被复用改写，新条目避开它的名字", () => {
    write(homeAgentsFile(), { mcpServers: { radius: { url: RADIUS_MCP_URL } } });
    vi.stubEnv("HOME", home);
    expect(planRadiusMcpServer("radius", agentDir, cwd)).toEqual({
      mcpPath: globalFile(),
      name: "radius-mcp",
      config: { url: RADIUS_MCP_URL, auth: { provider: "radius" } },
    });
  });
});

describe("primus mcp add/remove 不改 .agents/", () => {
  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMcpCommand(args, {
      cwd,
      agentDir,
      homeDir: home,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("remove 只在项目 .agents 里的服务器：报清楚的提示，文件不变", async () => {
    write(projectAgentsFile(), { mcpServers: { q: stdio("q") } });
    const before = readFileSync(projectAgentsFile(), "utf8");
    const result = await run(["remove", "q", "--local"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`is defined in ${projectAgentsFile()}, not in ${projectFile()}`);
    expect(result.err).toContain(`does not edit ${projectAgentsFile()}`);
    expect(readFileSync(projectAgentsFile(), "utf8")).toBe(before);
  });

  it("remove 只在 ~/.agents 里的服务器：报清楚的提示，文件不变", async () => {
    write(homeAgentsFile(), { mcpServers: { b: stdio("b") } });
    const before = readFileSync(homeAgentsFile(), "utf8");
    const result = await run(["remove", "b"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`is defined in ${homeAgentsFile()}, not in ${globalFile()}`);
    expect(readFileSync(homeAgentsFile(), "utf8")).toBe(before);
  });

  it("remove 掉 agentDir 里的覆盖项后提示 ~/.agents 里仍有定义", async () => {
    write(globalFile(), { mcpServers: { b: { enabled: false } } });
    write(homeAgentsFile(), { mcpServers: { b: stdio("b") } });
    const result = await run(["remove", "b"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`"b" is still defined in ${homeAgentsFile()}`);
    expect(JSON.parse(readFileSync(globalFile(), "utf8"))).toEqual({ mcpServers: {} });
  });

  it("add 写 .primus/mcp.json，同名的 .agents 条目只提示不改", async () => {
    write(projectAgentsFile(), { mcpServers: { q: stdio("agents") } });
    const before = readFileSync(projectAgentsFile(), "utf8");
    const result = await run(["add", "q", "--local", "--", "primus-q"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      `${projectAgentsFile()} also defines "q"; ${projectFile()} takes precedence`,
    );
    expect(readFileSync(projectAgentsFile(), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(projectFile(), "utf8"))).toEqual({
      mcpServers: { q: { command: "primus-q" } },
    });
  });
});
