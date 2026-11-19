import { WEBFETCH_TOOL, WEBSEARCH_TOOL } from "@primus/protocol";
import { describe, expect, it, vi } from "vitest";
import { findInText, normalizeFetch, runFetch } from "./fetch.ts";
import { decodeEntities, htmlTitle, htmlToMarkdown } from "./html.ts";
import web, {
  createWeb,
  localDate,
  PROMPT_SECTION,
  type PromptOptions,
  SEARCH_SECRET_ID,
  syncActiveTools,
  type WebDeps,
} from "./index.ts";
import { checkPublicUrl, isPrivateAddress, WebError } from "./net.ts";
import {
  formatResults,
  KeyPool,
  MAX_RESULT_CHARS,
  normalizeSearch,
  parseResults,
} from "./search.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const searchOk = (n = 2) =>
  json(200, {
    code: 200,
    msg: null,
    data: {
      webPages: {
        value: Array.from({ length: n }, (_, i) => ({
          name: `标题 ${i + 1}`,
          url: `https://www.example${i + 1}.com/a`,
          snippet: "短摘要",
          summary: "长摘要内容",
          datePublished: "2026-11-18T08:00:00Z",
        })),
      },
    },
  });

function makeDeps(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  extra: Partial<WebDeps> = {},
) {
  const run = vi.fn((_exe: string, _args: string[]) => "sk-key-a\nsk-key-b\n");
  const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) =>
    fetchImpl(String(url), init),
  );
  let settingsText: string | undefined;
  const deps: WebDeps = {
    env: {
      PRIMUS_EXE: "/opt/Primus/Primus.exe",
      PRIMUS_SEARCH_BASE_URL: "https://search.example.test/v1/",
      PRIMUS_WEB_SETTINGS: "/data/users/S-1/app/web.json",
    },
    fetch: fetchMock as unknown as typeof fetch,
    lookup: async () => ["93.184.216.34"],
    run,
    readSettings: () => settingsText,
    now: () => 1_000_000,
    ...extra,
  };
  const setSettings = (text: string | undefined) => {
    settingsText = text;
  };
  return { deps, run, fetchMock, setSettings };
}

const authOf = (init?: RequestInit) =>
  (init?.headers as Record<string, string> | undefined)?.Authorization;

describe("web_search 参数与结果", () => {
  it("规范化参数：未知时间范围回到 noLimit，结果数夹到 1–20，域名只留主机名", () => {
    expect(
      normalizeSearch({
        query: "  rust   1.99 ",
        freshness: "lastCentury",
        count: 99,
        include_domains: ["https://Docs.rs/x", "bad domain", 3 as never],
      }),
    ).toEqual({
      query: "rust 1.99",
      freshness: "noLimit",
      count: 20,
      includeDomains: ["docs.rs"],
      excludeDomains: [],
    });
    expect(normalizeSearch({ query: "x", freshness: "2026-01-01..2026-02-01" }).freshness).toBe(
      "2026-01-01..2026-02-01",
    );
    expect(normalizeSearch({ query: "x", count: 0 }).count).toBe(1);
    expect(normalizeSearch({ query: "x" }).count).toBe(8);
  });

  it("解析结果：跳过非 http 链接，摘要优先用 summary", async () => {
    const body = (await searchOk(1).json()) as unknown;
    expect(parseResults(body)).toEqual([
      {
        title: "标题 1",
        url: "https://www.example1.com/a",
        site: "www.example1.com",
        date: "2026-11-18T08:00:00Z",
        summary: "长摘要内容",
      },
    ]);
    expect(
      parseResults({ data: { webPages: { value: [{ name: "x", url: "ftp://a" }] } } }),
    ).toEqual([]);
    expect(parseResults(null)).toEqual([]);
  });

  it("给模型的文本：编号、链接、摘要截断，没有结果时给出建议", () => {
    const long = "字".repeat(5000);
    const text = formatResults("q", [
      { title: "A", url: "https://a.com", site: "a.com", summary: long },
    ]);
    expect(text).toContain("[1] A");
    expect(text).toContain("链接：https://a.com");
    expect(text.length).toBeLessThan(1600);
    expect(formatResults("q", [])).toContain("没有找到结果");
    // 首条结果也受总长度限制
    const huge = formatResults("q", [
      {
        title: "t".repeat(30_000),
        url: "https://a.com",
        site: "a.com",
        summary: "s".repeat(30_000),
      },
    ]);
    expect(huge.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  });
});

describe("密钥轮换", () => {
  it("轮流使用，冷却中的排到最后", () => {
    let t = 0;
    const pool = new KeyPool(["a", "b"], () => t);
    expect(pool.order().map((k) => k.key)).toEqual(["a", "b"]);
    expect(pool.order().map((k) => k.key)).toEqual(["b", "a"]);
    pool.fail(0, 429);
    expect(pool.order().map((k) => k.key)).toEqual(["b", "a"]);
    expect(pool.order().map((k) => k.key)).toEqual(["b", "a"]);
    t = 61_000;
    expect(pool.order().map((k) => k.key)).toEqual(["a", "b"]);
    pool.fail(1, 500);
    expect(pool.order().map((k) => k.key)).toEqual(["b", "a"]);
  });
});

describe("web_search 执行", () => {
  const ctxSignal = undefined;

  it("取两把密钥，调用 /web-search，details 只给来源不含摘要", async () => {
    const { deps, run, fetchMock } = makeDeps(async () => searchOk());
    const w = createWeb(deps);
    const r = await w.search({ query: "乾元", freshness: "oneWeek", count: 3 }, ctxSignal);
    expect(run).toHaveBeenCalledWith("/opt/Primus/Primus.exe", ["--secret", SEARCH_SECRET_ID]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://search.example.test/v1/web-search");
    expect(authOf(init)).toBe("Bearer sk-key-a");
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "乾元",
      count: 3,
      freshness: "oneWeek",
      summary: true,
    });
    expect(r.isError).toBeUndefined();
    expect(r.details.status).toBe("done");
    expect(r.details.results).toHaveLength(2);
    expect(r.details.results[0]).not.toHaveProperty("summary");
    expect(r.content[0]?.text).toContain("长摘要内容");
    // 第二次搜索轮到第二把密钥；密钥只取一次
    await w.search({ query: "again" }, ctxSignal);
    expect(authOf(fetchMock.mock.calls[1]?.[1])).toBe("Bearer sk-key-b");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("一把限流 / 鉴权失败 / 服务端错误时换另一把，用户无感", async () => {
    for (const status of [429, 401, 503]) {
      const { deps, fetchMock } = makeDeps(async (_u, init) =>
        authOf(init) === "Bearer sk-key-a" ? json(status, { msg: "x" }) : searchOk(),
      );
      const r = await createWeb(deps).search({ query: "q" }, undefined);
      expect(r.details.status, String(status)).toBe("done");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("业务码不是 200 时同样按状态处理", async () => {
    const { deps, fetchMock } = makeDeps(async (_u, init) =>
      authOf(init) === "Bearer sk-key-a" ? json(200, { code: 429, msg: "quota" }) : searchOk(),
    );
    const r = await createWeb(deps).search({ query: "q" }, undefined);
    expect(r.details.status).toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("网络错误换密钥；两把都失败时报告原因", async () => {
    const { deps, fetchMock } = makeDeps(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await createWeb(deps).search({ query: "q" }, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.isError).toBe(true);
    expect(r.details).toMatchObject({ status: "failed", error: "无法连接搜索服务" });
  });

  it("请求被拒（400）不换密钥，把原因交给模型", async () => {
    const { deps, fetchMock } = makeDeps(async () => json(400, { msg: "count too large" }));
    const r = await createWeb(deps).search({ query: "q" }, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.details.error).toContain("count too large");
  });

  it("用户停止：状态 cancelled，不再换密钥", async () => {
    const ctl = new AbortController();
    const { deps, fetchMock } = makeDeps(
      (_u, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
          ctl.abort();
        }),
    );
    const r = await createWeb(deps).search({ query: "q" }, ctl.signal);
    expect(r.details.status).toBe("cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("缺少关键词、关闭联网、取不到密钥时直接失败，不发请求", async () => {
    const a = makeDeps(async () => searchOk());
    expect((await createWeb(a.deps).search({ query: " " }, undefined)).details.error).toContain(
      "缺少",
    );
    a.setSettings('{"enabled":false}');
    expect((await createWeb(a.deps).search({ query: "q" }, undefined)).details.error).toContain(
      "关闭联网",
    );
    const b = makeDeps(async () => searchOk());
    b.run.mockImplementation(() => {
      throw new Error("denied");
    });
    expect((await createWeb(b.deps).search({ query: "q" }, undefined)).details.error).toBe(
      "搜索服务暂不可用",
    );
    expect(a.fetchMock).not.toHaveBeenCalled();
    expect(b.fetchMock).not.toHaveBeenCalled();
  });
});

describe("联网开关", () => {
  it("没有设置文件或内容无效时默认打开，每轮重新读取", () => {
    const { deps, setSettings } = makeDeps(async () => searchOk());
    const w = createWeb(deps);
    expect(w.enabled()).toBe(true);
    setSettings("not json");
    expect(w.enabled()).toBe(true);
    setSettings('{"enabled":false}');
    expect(w.enabled()).toBe(false);
    setSettings('{"enabled":true}');
    expect(w.enabled()).toBe(true);
    expect(createWeb({ ...deps, env: {} }).enabled()).toBe(true);
  });

  it("关闭时移除两个工具（含本轮的 selectedTools），打开时确保两个都在，其他工具不动", () => {
    let active = ["read", WEBSEARCH_TOOL, WEBFETCH_TOOL];
    const api = {
      getActiveTools: () => active,
      setActiveTools: vi.fn((n: string[]) => {
        active = n;
      }),
    };
    const reg = [WEBSEARCH_TOOL, WEBFETCH_TOOL];
    const opts: PromptOptions = { selectedTools: [...active] };
    syncActiveTools(api, opts, reg, false);
    expect(active).toEqual(["read"]);
    expect(opts.selectedTools).toEqual(["read"]);
    const next: PromptOptions = { selectedTools: ["read"] };
    syncActiveTools(api, next, reg, true);
    expect(active).toEqual(["read", WEBSEARCH_TOOL, WEBFETCH_TOOL]);
    expect(next.selectedTools).toEqual(["read", WEBSEARCH_TOOL, WEBFETCH_TOOL]);
    // Core 重启后从会话恢复的清单只有部分工具：打开时补齐
    active = ["read", WEBFETCH_TOOL];
    syncActiveTools(api, undefined, reg, true);
    expect(active).toEqual(["read", WEBFETCH_TOOL, WEBSEARCH_TOOL]);
    // 已经齐了就不调用 setActiveTools
    api.setActiveTools.mockClear();
    syncActiveTools(api, undefined, reg, true);
    expect(api.setActiveTools).not.toHaveBeenCalled();
  });

  it("离线模式一律不联网；设置文件读取出错时沿用上次的值，从未读到过则不联网", () => {
    const { deps } = makeDeps(async () => searchOk());
    expect(createWeb({ ...deps, env: { ...deps.env, PRIMUS_OFFLINE: "1" } }).enabled()).toBe(false);
    let fail = false;
    let text: string | undefined = '{"enabled":false}';
    const w = createWeb({
      ...deps,
      readSettings: () => {
        if (fail) throw new Error("EBUSY");
        return text;
      },
    });
    expect(w.enabled()).toBe(false);
    fail = true;
    expect(w.enabled()).toBe(false);
    fail = false;
    text = undefined;
    expect(w.enabled()).toBe(true);
    const never = createWeb({
      ...deps,
      readSettings: () => {
        throw new Error("EACCES");
      },
    });
    expect(never.enabled()).toBe(false);
  });

  it("注册：有搜索地址时注册两个工具，并在每轮开始前加“联网”小节与当前日期", () => {
    const tools: string[] = [];
    let handler: ((e: { systemPromptOptions?: PromptOptions }) => unknown) | undefined;
    let active: string[] = [];
    const { deps, setSettings } = makeDeps(async () => searchOk());
    web(
      {
        registerTool: (t: { name: string; annotations?: unknown }) => {
          tools.push(t.name);
          expect(t.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
          active.push(t.name);
        },
        on: (_e: string, h: typeof handler) => {
          handler = h;
        },
        getActiveTools: () => active,
        setActiveTools: (n: string[]) => {
          active = n;
        },
      },
      deps,
    );
    expect(tools).toEqual([WEBSEARCH_TOOL, WEBFETCH_TOOL]);
    const opts: PromptOptions = { selectedTools: [...active], sections: {} };
    handler?.({ systemPromptOptions: opts });
    expect(opts.sections?.[PROMPT_SECTION]).toContain(`当前日期：${localDate(1_000_000)}`);
    setSettings('{"enabled":false}');
    const off: PromptOptions = { selectedTools: [...active], sections: { web: "旧" } };
    handler?.({ systemPromptOptions: off });
    expect(off.sections).toEqual({});
    expect(active).toEqual([]);
  });

  it("没有搜索地址时只注册 web_fetch", () => {
    const tools: string[] = [];
    const { deps } = makeDeps(async () => searchOk());
    web({ registerTool: (t: { name: string }) => tools.push(t.name) }, { ...deps, env: {} });
    expect(tools).toEqual([WEBFETCH_TOOL]);
  });
});

describe("网址检查", () => {
  const lookup = async () => ["93.184.216.34"];

  it("内网与本机地址", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "172.20.0.1",
      "169.254.1.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "0.0.0.0",
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "2606:4700::1111", "172.32.0.1"])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("只接受公网 http / https，拒绝凭证、本机名与解析到内网的域名", async () => {
    await expect(checkPublicUrl("https://example.com/a#x", lookup)).resolves.toMatchObject({
      href: "https://example.com/a",
    });
    for (const bad of [
      "file:///etc/passwd",
      "ftp://a.com",
      "http://user:pw@a.com",
      "http://localhost:3000",
      "http://127.0.0.1",
      "http://[::1]/",
      "http://printer.local/",
      "not a url",
    ])
      await expect(checkPublicUrl(bad, lookup), bad).rejects.toBeInstanceOf(WebError);
    await expect(checkPublicUrl("https://evil.test", async () => ["10.0.0.5"])).rejects.toThrow(
      "内网",
    );
    // 解析不到地址：无法确认不在内网，拒绝
    await expect(
      checkPublicUrl("https://proxy-only.test", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow("无法解析");
  });

  it("域名解析受取消控制：中止后不再等待", async () => {
    const ctl = new AbortController();
    const pending = checkPublicUrl(
      "https://slow.test",
      () => new Promise<string[]>(() => {}),
      ctl.signal,
    );
    ctl.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });
});

describe("HTML 转文本", () => {
  it("实体、标题", () => {
    expect(decodeEntities("a&amp;b &lt;i&gt; &#20013;&#x6587; &nbsp;&bogus;")).toBe(
      "a&b <i> 中文  &bogus;",
    );
    expect(htmlTitle("<head><title> 乾元 &amp; Primus </title></head>")).toBe("乾元 & Primus");
  });

  it("去掉脚本与导航，保留标题、列表、链接、代码块", () => {
    const html = `<html><head><title>T</title><style>.a{}</style></head><body>
      <nav><a href="/home">首页</a></nav>
      <h1>标题</h1>
      <p>第一段 <a href="/docs?a=1&amp;b=2">文档</a> 和 <a href="javascript:void(0)">按钮</a>。</p>
      <ul><li>一</li><li>二</li></ul>
      <pre><code class="language-rust">fn main() {
    println!("&lt;hi&gt;");
}</code></pre>
      <script>alert(1)</script>
      <textarea style="display:none">&lt;style&gt;.css{color:red}&lt;/style&gt;</textarea>
      <footer>版权</footer>
    </body></html>`;
    const md = htmlToMarkdown(html, "https://example.com/guide/");
    expect(md).toContain("# 标题");
    expect(md).toContain("[文档](https://example.com/docs?a=1&b=2)");
    expect(md).toContain("按钮");
    expect(md).not.toContain("javascript:");
    expect(md).toContain("- 一\n");
    expect(md).toContain('```rust\nfn main() {\n    println!("<hi>");\n}\n```');
    expect(md).not.toContain("alert");
    expect(md).not.toContain(".css");
    expect(md).not.toContain("首页");
    expect(md).not.toContain("版权");
  });
});

describe("web_fetch", () => {
  const page = (body: string, type = "text/html; charset=utf-8", status = 200) =>
    new Response(body, { status, headers: { "Content-Type": type } });
  const fetchDeps = (impl: (url: string, init?: RequestInit) => Promise<Response>) => ({
    fetch: vi.fn((u: string | URL | Request, i?: RequestInit) =>
      impl(String(u), i),
    ) as unknown as typeof fetch,
    lookup: async () => ["93.184.216.34"],
  });

  it("参数规范化", () => {
    expect(normalizeFetch({ url: " https://a.com ", offset: -5, max_chars: 999_999 })).toEqual({
      url: "https://a.com",
      find: "",
      offset: 0,
      maxChars: 40_000,
    });
  });

  it("读取 HTML：返回标题、地址与分段正文，提示下一段的 offset", async () => {
    const body = `<html><head><title>文档</title></head><body><main><p>${"内容".repeat(3000)}</p></main></body></html>`;
    const deps = fetchDeps(async () => page(body));
    const r = await runFetch(
      deps,
      normalizeFetch({ url: "https://a.com/x", max_chars: 1000 }),
      undefined,
    );
    expect(r.isError).toBeUndefined();
    expect(r.details).toMatchObject({
      status: "done",
      title: "文档",
      finalUrl: "https://a.com/x",
      contentType: "text/html",
      totalChars: 6000,
      range: [0, 1000],
    });
    expect(r.text).toContain("offset=1000");
  });

  it("跟随跳转并检查每一跳；跳到内网时拒绝", async () => {
    const deps = fetchDeps(async (url) =>
      url === "https://a.com/old"
        ? new Response(null, { status: 301, headers: { Location: "/new" } })
        : url === "https://a.com/new"
          ? page("<p>新页面</p>")
          : new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/admin" } }),
    );
    const ok = await runFetch(deps, normalizeFetch({ url: "https://a.com/old" }), undefined);
    expect(ok.details.finalUrl).toBe("https://a.com/new");
    expect(ok.text).toContain("新页面");
    const bad = await runFetch(deps, normalizeFetch({ url: "https://a.com/evil" }), undefined);
    expect(bad.isError).toBe(true);
    expect(bad.details.error).toContain("内网");
  });

  it("页内查找只返回命中片段", async () => {
    const text = `${"a".repeat(1000)} needle ${"b".repeat(1000)} NEEDLE`;
    const deps = fetchDeps(async () => page(text, "text/plain"));
    const r = await runFetch(
      deps,
      normalizeFetch({ url: "https://a.com/t", find: "Needle" }),
      undefined,
    );
    expect(r.details.matches).toBe(2);
    expect(r.text).toContain("共 2 处");
    expect(r.text.length).toBeLessThan(1600);
    expect(findInText("xx", "y").count).toBe(0);
  });

  it("按 meta 声明的编码解码（GBK）", async () => {
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); // “中文”
    const head = new TextEncoder().encode('<html><head><meta charset="gbk"></head><body><p>');
    const tail = new TextEncoder().encode("</p></body></html>");
    const bytes = new Uint8Array([...head, ...gbk, ...tail]);
    const deps = fetchDeps(
      async () => new Response(bytes, { headers: { "Content-Type": "text/html" } }),
    );
    const r = await runFetch(deps, normalizeFetch({ url: "https://a.com/gbk" }), undefined);
    expect(r.text).toContain("中文");
  });

  it("不支持的内容类型、HTTP 错误、缺少网址", async () => {
    const pdf = await runFetch(
      fetchDeps(async () => page("%PDF", "application/pdf")),
      normalizeFetch({ url: "https://a.com/x.pdf" }),
      undefined,
    );
    expect(pdf.details.error).toContain("application/pdf");
    const missing = await runFetch(
      fetchDeps(async () => page("no", "text/html", 404)),
      normalizeFetch({ url: "https://a.com/404" }),
      undefined,
    );
    expect(missing.details.error).toContain("404");
    const empty = await runFetch(
      fetchDeps(async () => page("")),
      normalizeFetch({}),
      undefined,
    );
    expect(empty.details.error).toContain("缺少网址");
  });

  it("关闭联网时 web_fetch 也不可用", async () => {
    const { deps, setSettings, fetchMock } = makeDeps(async () => page("<p>x</p>"));
    setSettings('{"enabled":false}');
    const r = await createWeb(deps).fetchPage({ url: "https://a.com" }, undefined);
    expect(r.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
