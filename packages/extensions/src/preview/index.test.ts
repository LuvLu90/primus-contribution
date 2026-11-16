import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREVIEW_DOCUMENT_MAX_BYTES,
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_TOOL,
  PREVIEW_WIDGET,
} from "@primus/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decide } from "../guard/index.ts";
import preview, { inspectPreview, PREVIEW_PARAMETERS, previewText, runPreview } from "./index.ts";

let root: string;
const pe = () => ({ platform: "linux" as const, home: join(root, "home"), env: {} });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "primus-preview-"));
  const w = join(root, "w");
  mkdirSync(join(w, "docs"), { recursive: true });
  mkdirSync(join(w, ".git"), { recursive: true });
  mkdirSync(join(root, "home", ".ssh"), { recursive: true });
  writeFileSync(join(w, "main.ts"), "export {};\n");
  writeFileSync(join(w, "README.md"), "# hi\n");
  writeFileSync(join(w, "a.bin"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(w, "旧.doc"), "x");
  writeFileSync(join(w, "a.png"), "x");
  writeFileSync(join(w, "a.mp4"), "x");
  writeFileSync(join(w, ".env"), "SECRET=1");
  writeFileSync(join(w, "big.log"), Buffer.alloc(PREVIEW_TEXT_MAX_BYTES + 1, 0x61));
  // 稀疏文件：只设大小，不真的写 30 MiB
  writeFileSync(join(w, "big.pdf"), "");
  truncateSync(join(w, "big.pdf"), PREVIEW_DOCUMENT_MAX_BYTES + 1);
  writeFileSync(join(w, "ok.pdf"), "%PDF-1.7");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const w = () => join(root, "w");

describe("inspectPreview 状态", () => {
  it("shown：文件夹、文本、Markdown、图片、媒体，带类别与绝对路径", async () => {
    expect(await inspectPreview("docs", w(), true, pe())).toEqual({
      status: "shown",
      input: "docs",
      path: join(w(), "docs"),
      kind: "folder",
    });
    expect(await inspectPreview("main.ts", w(), true, pe())).toMatchObject({
      status: "shown",
      kind: "text",
      path: join(w(), "main.ts"),
      size: 11,
    });
    expect(await inspectPreview(join(w(), "README.md"), "/elsewhere", true, pe())).toMatchObject({
      status: "shown",
      kind: "markdown",
    });
    expect((await inspectPreview("a.png", w(), true, pe())).kind).toBe("image");
    expect((await inspectPreview("a.mp4", w(), true, pe())).kind).toBe("media");
    expect((await inspectPreview("ok.pdf", w(), true, pe())).kind).toBe("document");
    // 工作区本身
    expect((await inspectPreview(".", w(), true, pe())).kind).toBe("folder");
  });

  it("超过 1 MiB 的文本照样打开，标记 truncated", async () => {
    expect(await inspectPreview("big.log", w(), true, pe())).toMatchObject({
      status: "shown",
      kind: "text",
      truncated: true,
    });
  });

  it("unsupported：二进制内容与旧版 Office", async () => {
    expect(await inspectPreview("a.bin", w(), true, pe())).toMatchObject({
      status: "unsupported",
      kind: "other",
    });
    expect(await inspectPreview("旧.doc", w(), true, pe())).toMatchObject({
      status: "unsupported",
      kind: "other",
    });
  });

  it("not_found", async () => {
    expect(await inspectPreview("nope.txt", w(), true, pe())).toMatchObject({
      status: "not_found",
      path: join(w(), "nope.txt"),
    });
    expect((await inspectPreview("main.ts/x", w(), true, pe())).status).toBe("not_found");
  });

  it("denied：网址、网络路径、空路径与控制字符", async () => {
    for (const p of ["https://x.com/a", "mailto:a@b.c", "//srv/share/a", "", "a\nb"])
      expect((await inspectPreview(p, w(), true, pe())).status, p).toBe("denied");
    // file:// 按本机路径解析
    expect(
      (await inspectPreview(`file://${join(w(), "main.ts")}`, "/elsewhere", true, pe())).status,
    ).toBe("shown");
  });

  it("受保护路径（.env、.git、~/.ssh）也给用户预览，结果里没有文件内容", async () => {
    expect(await inspectPreview(".env", w(), true, pe())).toMatchObject({
      status: "shown",
      path: join(w(), ".env"),
    });
    expect((await inspectPreview(".git", w(), true, pe())).kind).toBe("folder");
    expect((await inspectPreview("~/.ssh", w(), true, pe())).status).toBe("shown");
    const r = await runPreview(
      "c",
      { path: ".env" },
      { hasUI: true, cwd: w(), ui: { setWidget: vi.fn() } },
      pe(),
    );
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("~/.ssh 里的私钥与 Core 用户目录的 auth.json 也给用户预览，结果里没有内容", async () => {
    const key = join(root, "home", ".ssh", "id_ed25519");
    writeFileSync(key, "PRIVATE-KEY-BODY");
    const core = join(root, "data", "users", "S", "core");
    mkdirSync(core, { recursive: true });
    writeFileSync(join(core, "auth.json"), '{"token":"TOKEN-BODY"}');
    const env = { PRIMUS_CODING_AGENT_DIR: core };
    for (const [path, body] of [
      ["~/.ssh/id_ed25519", "PRIVATE-KEY-BODY"],
      [join(core, "auth.json"), "TOKEN-BODY"],
    ] as const) {
      const widget = vi.fn();
      const r = await runPreview(
        "c",
        { path },
        { hasUI: true, cwd: w(), ui: { setWidget: widget } },
        { ...pe(), env },
      );
      expect(r.details.status, path).toBe("shown");
      expect(widget).toHaveBeenCalledOnce();
      expect(JSON.stringify(r)).not.toContain(body);
      expect(JSON.stringify(widget.mock.calls)).not.toContain(body);
    }
  });

  it("应用数据目录（PRIMUS_CODING_AGENT_DIR 往上三级的 data）也给用户预览", async () => {
    const data = join(root, "data");
    mkdirSync(join(data, "users", "S", "core"), { recursive: true });
    writeFileSync(join(data, "users", "S", "core", "x.json"), "{}");
    const env = { PRIMUS_CODING_AGENT_DIR: join(data, "users", "S", "core") };
    expect(
      (
        await inspectPreview(join(data, "users", "S", "core", "x.json"), w(), true, {
          ...pe(),
          env,
        })
      ).status,
    ).toBe("shown");
  });

  it("too_large：文档超过 30 MiB", async () => {
    expect(await inspectPreview("big.pdf", w(), true, pe())).toMatchObject({
      status: "too_large",
      kind: "document",
      size: PREVIEW_DOCUMENT_MAX_BYTES + 1,
      limit: PREVIEW_DOCUMENT_MAX_BYTES,
    });
  });

  it("no_ui：没有界面时能打开的改为 no_ui，其余照实报告", async () => {
    expect((await inspectPreview("main.ts", w(), false, pe())).status).toBe("no_ui");
    expect((await inspectPreview("a.bin", w(), false, pe())).status).toBe("no_ui");
    expect((await inspectPreview("nope", w(), false, pe())).status).toBe("not_found");
    expect((await inspectPreview(".env", w(), false, pe())).status).toBe("no_ui");
  });
});

describe("runPreview", () => {
  const ctx = (hasUI = true) => ({ hasUI, cwd: w(), ui: { setWidget: vi.fn() } });

  it("shown：推 primus:preview，结果文本以状态开头，不是错误", async () => {
    const c = ctx();
    const r = await runPreview("call-1", { path: "docs" }, c, pe());
    expect(r.isError).toBeUndefined();
    expect(r.details.status).toBe("shown");
    expect(r.content[0]?.text).toMatch(/^\[shown\] /);
    expect(r.content[0]?.text).toContain(join(w(), "docs"));
    expect(c.ui.setWidget).toHaveBeenCalledWith(PREVIEW_WIDGET, [
      JSON.stringify({
        v: 1,
        type: "preview",
        data: { id: "call-1", path: join(w(), "docs"), kind: "folder" },
      }),
    ]);
  });

  it("unsupported 也打开（右栏显示“用默认程序打开”），但告诉模型用户看不到渲染", async () => {
    const c = ctx();
    const r = await runPreview("c", { path: "a.bin" }, c, pe());
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toMatch(/^\[unsupported\] .*用默认程序打开/);
    expect(c.ui.setWidget).toHaveBeenCalledOnce();
  });

  it("失败的状态不推数据，结果标为错误", async () => {
    for (const [path, status] of [
      ["nope", "not_found"],
      ["https://x.com/a", "denied"],
      ["big.pdf", "too_large"],
    ] as const) {
      const c = ctx();
      const r = await runPreview("c", { path }, c, pe());
      expect(r.isError).toBe(true);
      expect(r.details.status).toBe(status);
      expect(r.content[0]?.text).toMatch(new RegExp(`^\\[${status}\\] `));
      expect(c.ui.setWidget).not.toHaveBeenCalled();
    }
  });

  it("no_ui：hasUI 为 false 或没有 setWidget", async () => {
    const r = await runPreview("c", { path: "main.ts" }, { hasUI: false, cwd: w() }, pe());
    expect(r.details.status).toBe("no_ui");
    expect(r.isError).toBe(true);
    const r2 = await runPreview("c", { path: "main.ts" }, { hasUI: true, cwd: w(), ui: {} }, pe());
    expect(r2.details.status).toBe("no_ui");
  });

  it("too_large 的文本给出大小与上限", () => {
    expect(
      previewText({
        status: "too_large",
        input: "a.pdf",
        path: "/w/a.pdf",
        kind: "document",
        size: 31 * 1024 * 1024,
        limit: 30 * 1024 * 1024,
      }),
    ).toBe(
      "[too_large] 文件超过预览上限，没有打开；类别 document；大小 31 MiB，上限 30 MiB：/w/a.pdf",
    );
  });
});

describe("注册", () => {
  it("注册只读、不联网的 preview 工具，带提示词要点", () => {
    const registerTool = vi.fn();
    preview({ registerTool });
    expect(registerTool).toHaveBeenCalledOnce();
    const tool = registerTool.mock.calls[0]?.[0];
    expect(tool.name).toBe(PREVIEW_TOOL);
    expect(tool.parameters).toBe(PREVIEW_PARAMETERS);
    expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(tool.promptGuidelines.join("\n")).toContain("不要每次写文件后都调用 preview");
  });

  it("没有 registerTool 时什么也不做", () => {
    expect(() => preview({})).not.toThrow();
  });

  it("primus-guard 在各权限模式下都直接放行（按注解，不弹确认）", () => {
    for (const mode of ["ask", "edit", "full"] as const)
      expect(
        decide(mode, { toolName: PREVIEW_TOOL, input: { path: "/elsewhere/x.md" } }, w(), {
          readOnlyHint: true,
          openWorldHint: false,
        }),
      ).toBe("allow");
  });
});
