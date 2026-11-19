import { describe, expect, it } from "vitest";
import {
  formatPairs,
  joinCommandLine,
  listServers,
  listSharedServers,
  nameConflict,
  ownValue,
  parseMcpDocument,
  parseMcpList,
  parsePairs,
  parsePastedServers,
  removeServer,
  setServer,
  setServerEnabled,
  setSharedServerEnabled,
  splitCommandLine,
  validateServer,
} from "./mcp-config";

const err = (name: string, raw: unknown, global?: boolean) => {
  const r = validateServer(name, raw, global);
  return "error" in r ? r.error : null;
};

describe("validateServer（与 Core 规则一致）", () => {
  it("接受 stdio 与 HTTP 条目，识别传输方式", () => {
    expect(validateServer("fs", { command: "npx", args: ["-y", "x"] })).toEqual({
      transport: "stdio",
    });
    expect(validateServer("docs", { url: "https://e.com/mcp", type: "streamable-http" })).toEqual({
      transport: "http",
    });
    expect(validateServer("a_b-1", { type: "stdio", command: "x", env: { A: "1" } })).toEqual({
      transport: "stdio",
    });
  });

  it("拒绝 Core 会拒绝的条目", () => {
    expect(err("a b", { command: "x" })).toContain("服务器名");
    expect(err("a", [])).toContain("应为对象");
    expect(err("a", { url: "https://x", type: "sse" })).toContain("SSE");
    expect(err("a", { url: "ftp://x" })).toContain("http 或 https");
    expect(err("a", { url: "https://x", headers: { A: 1 } })).toContain("headers");
    expect(err("a", { command: "x", args: "y" })).toContain("args");
    expect(err("a", { command: "x", env: [] })).toContain("env");
    expect(err("a", { command: "x", cwd: 1 })).toContain("cwd");
    expect(err("a", { command: "x", enabled: "no" })).toContain("enabled");
    expect(err("a", { command: "x", timeout: 0 })).toContain("timeout");
    expect(err("a", { command: "x", description: 1 })).toContain("description");
    expect(err("a", { args: [] })).toContain("command");
    expect(err("a", { url: "https://x", type: "stdio" })).toContain("command");
    expect(err("a", { command: "x", exposure: "all" })).toContain("exposure");
    expect(err("a", { command: "x", exposure: "codemode-deferred" })).toBeNull();
    expect(err("a", { command: "x", toolExposure: { t: "bad" } })).toContain("toolExposure");
  });

  it("oauth 与 auth 的检查", () => {
    const http = (extra: object) => ({ url: "https://x/mcp", ...extra });
    expect(err("a", http({ oauth: { callbackPort: 70000 } }))).toContain("callbackPort");
    expect(err("a", http({ oauth: { callbackUrl: "https://localhost/cb" } }))).toContain(
      "callbackUrl",
    );
    expect(
      err("a", http({ oauth: { callbackUrl: "http://localhost:8080/cb", callbackPort: 9 } })),
    ).toContain("端口不一致");
    expect(err("a", http({ oauth: { clientName: " " } }))).toContain("clientName");
    expect(err("a", http({ oauth: { clientRegistration: "x" } }))).toContain("clientRegistration");
    expect(err("a", http({ oauth: { clientRegistration: "cimd", clientId: "c" } }))).toContain(
      "cimd",
    );
    expect(
      err("a", http({ oauth: { clientRegistration: "cimd", callbackUrl: "http://localhost/cb" } })),
    ).toContain("/callback");
    expect(
      err(
        "a",
        http({ oauth: { clientRegistration: "cimd", callbackUrl: "http://127.0.0.1:5/callback" } }),
      ),
    ).toBeNull();
    expect(err("a", http({ oauth: { authServerMetadataUrl: "http://e.com" } }))).toContain(
      "authServerMetadataUrl",
    );
    expect(err("a", http({ auth: { provider: "" } }))).toContain("auth.provider");
    expect(err("a", { url: "http://e.com", auth: { provider: "p" } })).toContain("https");
    expect(err("a", { url: "http://localhost:3/m", auth: { provider: "p" } })).toBeNull();
    expect(err("a", http({ auth: { provider: "p" } }), false)).toContain("用户级");
  });
});

const FILE = `{
    "autoEnableCodemode": false,
    "mcpServers": {
        "fs": { "command": "npx", "args": ["-y", "server-fs"], "custom": 1 },
        "docs": { "url": "https://e.com/mcp", "enabled": false, "exposure": "direct" },
        "my-tool": { "command": "a" },
        "my_tool": { "command": "b" },
        "bad": { "type": "sse", "url": "https://x" }
    }
}
`;

describe("mcp.json 修改", () => {
  it("列出服务器：目标、启用、暴露方式、冲突与错误", () => {
    const list = listServers(parseMcpDocument(FILE));
    expect(list.map((s) => s.name)).toEqual(["fs", "docs", "my-tool", "my_tool", "bad"]);
    expect(list[0]).toMatchObject({
      transport: "stdio",
      target: "npx -y server-fs",
      enabled: true,
      exposure: "codemode",
      error: null,
    });
    expect(list[1]).toMatchObject({ transport: "http", enabled: false, exposure: "direct" });
    expect(list[3]?.error).toContain("冲突");
    expect(list[4]?.error).toContain("SSE");
  });

  it("暴露方式只认自有的别名：__proto__ 等原型上的名字原样保留并报错", () => {
    const names = ["__proto__", "toString", "constructor", "codemode-deferred"];
    const doc = parseMcpDocument(
      JSON.stringify({
        mcpServers: Object.fromEntries(
          names.map((x, i) => [`s${i}`, { command: "x", exposure: x }]),
        ),
      }),
    );
    const list = listServers(doc);
    for (const [i, x] of names.slice(0, 3).entries()) {
      expect(list[i]?.exposure).toBe(x);
      expect(typeof list[i]?.exposure).toBe("string");
      expect(list[i]?.error).toContain("exposure");
    }
    expect(list[3]).toMatchObject({ exposure: "codemode", error: null });
    expect(ownValue({ a: 1 }, "a")).toBe(1);
    expect(ownValue({ a: 1 }, "__proto__")).toBeUndefined();
    expect(ownValue({ a: 1 }, "toString")).toBeUndefined();
  });

  it("文件不存在或为空时视为空配置；格式错误时报错", () => {
    expect(listServers(parseMcpDocument(null))).toEqual([]);
    expect(() => parseMcpDocument("[1]")).toThrow("mcpServers");
    expect(() => parseMcpDocument('{"mcpServers": []}')).toThrow("mcpServers");
    expect(() => parseMcpDocument("{")).toThrow("JSON");
  });

  it("添加、改名（留在原位置）、删除、启停都保留缩进与其他内容", () => {
    const added = setServer(FILE, "new", { url: "https://n.com/mcp" });
    expect(added).toContain('\n    "autoEnableCodemode": false');
    expect(Object.keys(JSON.parse(added).mcpServers).at(-1)).toBe("new");
    expect(JSON.parse(added).mcpServers.fs.custom).toBe(1);

    const renamed = setServer(FILE, "files", { command: "npx" }, "fs");
    expect(Object.keys(JSON.parse(renamed).mcpServers)[0]).toBe("files");
    expect(JSON.parse(renamed).mcpServers.fs).toBeUndefined();

    expect(() => setServer(FILE, "docs", { command: "x" })).toThrow("已有名为");
    expect(() => setServer(FILE, "f-s", { command: "x" }, "docs")).not.toThrow();
    expect(() => setServer(FILE, "my_tool", { command: "x" }, "fs")).toThrow("已有名为");
    expect(() => setServer(FILE, "x", { command: 1 })).toThrow("command");

    const removed = removeServer(FILE, "docs");
    expect(JSON.parse(removed).mcpServers.docs).toBeUndefined();
    expect(() => removeServer(FILE, "none")).toThrow("没有服务器");

    const enabled = setServerEnabled(FILE, "docs", true);
    expect("enabled" in JSON.parse(enabled).mcpServers.docs).toBe(false);
    const disabled = setServerEnabled(FILE, "fs", false);
    expect(JSON.parse(disabled).mcpServers.fs.enabled).toBe(false);

    // 没有文件时用两个空格
    expect(setServer(null, "a", { command: "x" })).toBe(
      '{\n  "mcpServers": {\n    "a": {\n      "command": "x"\n    }\n  }\n}\n',
    );
    // 制表符缩进
    expect(setServer('{\n\t"mcpServers": {}\n}', "a", { command: "x" })).toContain(
      '\n\t"mcpServers"',
    );
  });

  it("名为 __proto__ 的服务器作为普通键保留；不存在的名字不会命中原型上的属性", () => {
    const text = '{"mcpServers": {"__proto__": {"command": "a"}}}';
    const next = setServer(text, "b", { command: "b" });
    expect(Object.keys(JSON.parse(next).mcpServers)).toEqual(["__proto__", "b"]);
    expect(
      Object.keys(JSON.parse(setServer(null, "__proto__", { command: "x" })).mcpServers),
    ).toEqual(["__proto__"]);
    expect(() => removeServer(FILE, "toString")).toThrow("没有服务器");
    expect(() => setServerEnabled(FILE, "toString", false)).toThrow("没有服务器");
  });

  it("nameConflict 忽略正在编辑的条目", () => {
    const doc = parseMcpDocument(FILE);
    expect(nameConflict(doc, "fs", "fs")).toBeNull();
    expect(nameConflict(doc, "fs")).toContain("已有名为");
    expect(nameConflict(doc, "my-tool", "fs")).toContain("已有名为");
  });
});

describe("粘贴格式", () => {
  it("Claude Desktop / Core 的 mcpServers", () => {
    const r = parsePastedServers(
      '{"mcpServers": {"fs": {"command": "npx", "args": ["x"]}, "d": {"url": "https://d"}}}',
    );
    expect(r.servers.map(([n]) => n)).toEqual(["fs", "d"]);
    expect(r.notes).toEqual([]);
  });

  it("VS Code 的 servers 与 settings.json 的 mcp.servers：去掉 type 与不支持的字段，提示 input 变量", () => {
    // VS Code 的输入变量 `${input:tok}`
    const input = ["$", "{input:tok}"].join("");
    const r = parsePastedServers(
      JSON.stringify({
        servers: {
          gh: { type: "http", url: "https://g", headers: { A: input } },
          fs: { type: "stdio", command: "x", envFile: ".env" },
        },
        inputs: [],
      }),
    );
    expect(r.servers).toEqual([
      ["gh", { url: "https://g", headers: { A: input } }],
      ["fs", { command: "x" }],
    ]);
    expect(r.notes.join("\n")).toContain("envFile");
    expect(r.notes.join("\n")).toContain("input:");
    // VS Code 的 ${env:NAME}：env、headers 与 oauth.clientSecret 里换成 Core 的 ${NAME}；其他字段只提示
    const env = (n: string) => ["$", `{env:${n}}`].join("");
    const core = (n: string) => ["$", `{${n}}`].join("");
    const e = parsePastedServers(
      JSON.stringify({
        servers: {
          s: {
            command: "x",
            args: [env("HOME")],
            env: { K: `a-${env("TOKEN")}` },
          },
          h: {
            url: "https://h",
            headers: { Authorization: `Bearer ${env("T")}` },
            oauth: { clientSecret: env("S"), callbackPort: 1 },
          },
        },
      }),
    );
    expect(e.servers).toEqual([
      ["s", { command: "x", args: [env("HOME")], env: { K: `a-${core("TOKEN")}` } }],
      [
        "h",
        {
          url: "https://h",
          headers: { Authorization: `Bearer ${core("T")}` },
          oauth: { clientSecret: core("S"), callbackPort: 1 },
        },
      ],
    ]);
    expect(e.notes.join("\n")).toContain("args");
    expect(e.notes.filter((n) => n.includes("Core 的写法"))).toHaveLength(2);
    const s = parsePastedServers(
      '{"mcp": {"servers": {"a": {"type": "sse", "url": "https://a"}}}}',
    );
    expect(s.servers[0]?.[1]).toEqual({ type: "sse", url: "https://a" });
  });

  it("单条：带名字、不带名字、缺外层花括号与末尾逗号", () => {
    expect(parsePastedServers('{"fs": {"command": "npx"}}').servers).toEqual([
      ["fs", { command: "npx" }],
    ]);
    expect(parsePastedServers('{"url": "https://x"}').servers).toEqual([
      ["", { url: "https://x" }],
    ]);
    expect(parsePastedServers('"fs": {"command": "npx"},').servers).toEqual([
      ["fs", { command: "npx" }],
    ]);
  });

  it("不认识的格式报错", () => {
    expect(() => parsePastedServers("")).toThrow("请粘贴");
    expect(() => parsePastedServers("nope")).toThrow("JSON");
    expect(() => parsePastedServers("[1]")).toThrow("JSON 对象");
    expect(() => parsePastedServers('{"a": 1}')).toThrow("没有找到");
    expect(() => parsePastedServers('{"mcpServers": {}}')).toThrow("没有服务器");
    expect(() => parsePastedServers('{"mcpServers": {"a": 1}}')).toThrow("应为对象");
  });
});

describe("parseMcpList", () => {
  const out = (stdout: string, code = 0, stderr = "") => ({
    code,
    stdout,
    stderr,
    timedOut: false,
  });

  it("解析 JSON 输出（失败退出码 1 时也解析）", () => {
    const r = parseMcpList(
      out(
        JSON.stringify({
          servers: [
            {
              name: "fs",
              scope: "global",
              source: "/x/mcp.json",
              enabled: true,
              exposure: "codemode",
              transport: "npx",
              state: "connected",
              tools: ["read", 1],
            },
            {
              name: "d",
              scope: "global",
              source: "/x",
              enabled: true,
              exposure: "direct",
              transport: "https://d",
              state: "needs-auth",
              tools: [],
              error: "401",
            },
          ],
          errors: ["/x: bad"],
        }),
        1,
      ),
    );
    expect(r.servers[0]?.tools).toEqual(["read"]);
    expect(r.servers[1]).toMatchObject({ state: "needs-auth", error: "401" });
    expect(r.errors).toEqual(["/x: bad"]);
  });

  it("前面有其他输出时从第一个花括号开始；不是 JSON 时带上 stderr 报错；超时", () => {
    expect(parseMcpList(out('warn\n{"servers": [], "errors": []}')).servers).toEqual([]);
    expect(() => parseMcpList(out("", 1, "boom"))).toThrow("boom");
    expect(() => parseMcpList(out("", 2))).toThrow("退出码 2");
    expect(() => parseMcpList({ ...out(""), timedOut: true, code: null })).toThrow("超时");
  });
});

describe("表单辅助", () => {
  it("键值对", () => {
    expect(parsePairs("A=1\n\n B = x=y ", "=", "环境变量")).toEqual({ A: "1", B: "x=y" });
    expect(parsePairs("Authorization: Bearer x", ":", "请求头")).toEqual({
      Authorization: "Bearer x",
    });
    expect(() => parsePairs("=1", "=", "环境变量")).toThrow("第 1 行");
    expect(formatPairs({ A: "1" }, "=")).toBe("A=1");
    expect(formatPairs({ A: "1" }, ":")).toBe("A: 1");
    expect(formatPairs(undefined, ":")).toBe("");
  });

  it("命令行拆分与拼接互逆", () => {
    expect(splitCommandLine(` npx -y "@a/b c" '' x`)).toEqual(["npx", "-y", "@a/b c", "", "x"]);
    expect(() => splitCommandLine('a "b')).toThrow("引号");
    const parts = ["C:\\Program Files\\node.exe", 'say "hi"', "", "-y", `console.log("it's")`];
    expect(splitCommandLine(joinCommandLine(parts))).toEqual(parts);
  });
});

describe(".agents/mcp.json（与其他工具共用，只读，ADR 0022）", () => {
  const doc = (servers: Record<string, unknown>) =>
    parseMcpDocument(JSON.stringify({ mcpServers: servers }));

  it("套用主文件的覆盖项；主文件完整定义同名（含只差 - 与 _）时记为冲突", () => {
    const shared = doc({
      docs: { url: "https://d.example.com/mcp" },
      "my-tools": { command: "t" },
      off: { command: "o" },
    });
    const primary = doc({
      my_tools: { command: "mine" },
      off: { enabled: false, exposure: "direct" },
    });
    const views = listSharedServers(shared, primary);
    expect(
      views.map((v) => [v.name, v.enabled, v.exposure, v.overridden, v.error !== null]),
    ).toEqual([
      ["docs", true, "codemode", false, false],
      ["my-tools", true, "codemode", false, true],
      ["off", false, "direct", true, false],
    ]);
    expect(views[1]?.error).toContain("my_tools");
  });

  it("项目级不允许 auth，全局级允许", () => {
    const shared = doc({ k: { url: "https://k.example.com/mcp", auth: { provider: "p" } } });
    expect(listSharedServers(shared, null)[0]?.error).toBeNull();
    expect(listSharedServers(shared, null, { global: false })[0]?.error).toContain("auth");
  });

  it("主文件列表不单独列出覆盖 .agents 服务器的条目", () => {
    const primary = doc({
      a: { command: "a" },
      off: { enabled: false },
      ghost: { enabled: false },
    });
    const shared = doc({ off: { command: "o" } });
    expect(listServers(primary, shared).map((v) => v.name)).toEqual(["a", "ghost"]);
  });

  it("启停只改主文件里的覆盖项：启用删掉 enabled，覆盖项变空时整条删除", () => {
    const text = `${JSON.stringify({ mcpServers: { a: { command: "a" } } }, null, 4)}\n`;
    const off = setSharedServerEnabled(text, "docs", false);
    expect(JSON.parse(off).mcpServers).toEqual({ a: { command: "a" }, docs: { enabled: false } });
    expect(off).toContain('\n    "mcpServers"');
    const kept = setSharedServerEnabled(
      JSON.stringify({ mcpServers: { docs: { enabled: false, exposure: "direct" }, a: {} } }),
      "docs",
      true,
    );
    expect(Object.keys(JSON.parse(kept).mcpServers)).toEqual(["docs", "a"]);
    expect(JSON.parse(kept).mcpServers.docs).toEqual({ exposure: "direct" });
    expect(JSON.parse(setSharedServerEnabled(off, "docs", true)).mcpServers).toEqual({
      a: { command: "a" },
    });
    expect(JSON.parse(setSharedServerEnabled(null, "docs", false))).toEqual({
      mcpServers: { docs: { enabled: false } },
    });
    expect(() => setSharedServerEnabled(text, "a", false)).toThrow("a");
  });

  it("共享定义本身停用时，启用写 enabled: true，往返后为启用", () => {
    const shared = doc({ docs: { command: "d", enabled: false } });
    expect(listSharedServers(shared, null)[0]?.enabled).toBe(false);
    const on = setSharedServerEnabled(null, "docs", true, false);
    expect(JSON.parse(on).mcpServers.docs).toEqual({ enabled: true });
    expect(listSharedServers(shared, parseMcpDocument(on))[0]?.enabled).toBe(true);
    const off = setSharedServerEnabled(on, "docs", false, false);
    expect(listSharedServers(shared, parseMcpDocument(off))[0]?.enabled).toBe(false);
  });

  it("含其他键、Core 套用不了的覆盖项留在主列表并标出错误", () => {
    const primary = doc({ docs: { enabled: false, timeout: 30 } });
    const shared = doc({ docs: { command: "d" } });
    const own = listServers(primary, shared);
    expect(own.map((v) => v.name)).toEqual(["docs"]);
    expect(own[0]?.error).not.toBeNull();
    expect(listSharedServers(shared, primary)[0]).toMatchObject({
      enabled: true,
      overridden: false,
    });
    const extra = JSON.stringify({ mcpServers: { docs: { enabled: true, timeout: 30 } } });
    expect(() => setSharedServerEnabled(extra, "docs", false)).toThrow(
      "enabled、exposure、toolExposure",
    );
  });

  it("覆盖项的值不合法时报错，按原定义显示", () => {
    const shared = doc({ docs: { command: "d" } });
    const view = listSharedServers(shared, doc({ docs: { enabled: "false" } }))[0];
    expect(view).toMatchObject({ enabled: true, overridden: false });
    expect(view?.error).not.toBeNull();
    expect(listSharedServers(shared, doc({ docs: { enabled: false } }))[0]).toMatchObject({
      enabled: false,
      error: null,
    });
  });
});
