import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/features/chat/message-content";
import { cleanFragment, fragmentText, handleCopy, isNativeCopy } from "./clean-copy";

function clean(html: string) {
  const src = document.createElement("div");
  src.innerHTML = html;
  const holder = document.createElement("div");
  holder.appendChild(cleanFragment(src, document));
  return { html: holder.innerHTML, text: fragmentText(holder) };
}

describe("clean-copy", () => {
  it("去掉 class、style 与图标，只留语义标签", () => {
    const { html, text } = clean(
      '<div class="md" style="color:#fff"><h2 style="font-size:20px">标题</h2><p>一段<strong class="x">粗体</strong>和<code>code</code><svg aria-hidden="true"><path d="M0"/></svg></p></div>',
    );
    expect(html).toBe(
      "<div><h2>标题</h2><p>一段<strong>粗体</strong>和<code>code</code></p></div>",
    );
    expect(text).toBe("标题\n一段粗体和code");
  });

  it("文件引用胶囊复制成完整路径加行号，其他按钮不复制", () => {
    const md = renderMarkdown("看 `src/lib/utils.ts:12` 这里");
    expect(md).toContain("data-file-ref");
    const { html, text } = clean(`${md}<button aria-label="复制">复制</button>`);
    expect(html).toContain("<code>src/lib/utils.ts:12</code>");
    // 界面上只显示文件名；复制的是回复原文里的完整路径与行号
    expect(html).not.toContain("button");
    expect(text).toBe("看 src/lib/utils.ts:12 这里");
  });

  it("不加任何内容：列表不加符号与序号，分隔线不加记号；代码块保留换行、缩进与空行，表格用制表符", () => {
    const md = renderMarkdown(
      "1. 第一\n2. 第二\n   - 子项\n\n---\n\n```\nconst a = 1;\n\n\n  b();\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |",
    );
    const { text } = clean(md);
    expect(text).toBe("第一\n第二\n子项\nconst a = 1;\n\n\n  b();\nA\tB\n1\t2");
  });

  it("列表项里的段落（li > p）不被拆开，也不加符号", () => {
    const { text } = clean("<ul><li><p>项目</p><p>补充</p></li><li>二</li></ul>");
    expect(text).toBe("项目\n补充\n二");
  });

  it("外链只保留 http(s) 地址，外链图标不复制", () => {
    const { html, text } = clean(renderMarkdown("[文档](https://example.com/a)"));
    expect(html.trim()).toBe('<p><a href="https://example.com/a">文档</a></p>');
    expect(text).toBe("文档");
  });

  it("copy 事件：只写入纯文本并阻止默认；输入框里的复制保持默认", () => {
    document.body.innerHTML = `<div class="md">${renderMarkdown("**你好** 世界")}</div><textarea>原文</textarea>`;
    const p = document.querySelector(".md p") as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = document.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(isNativeCopy(sel)).toBe(false);
    const data = copy(p);
    expect(data.prevented).toBe(true);
    expect(data["text/plain"]).toBe("你好 世界");
    expect(data["text/html"]).toBeUndefined();

    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    const r2 = document.createRange();
    r2.selectNodeContents(ta);
    sel.removeAllRanges();
    sel.addRange(r2);
    expect(isNativeCopy(sel)).toBe(true);
  });

  it("从列表项选到下一项开头（三击选中一行）：只复制这一项的文字，不加序号", () => {
    document.body.innerHTML = `<div class="md">${renderMarkdown("1. 添加 `PRIMUS_ASR_KEY`\n2. 第二步")}</div>`;
    const items = document.querySelectorAll(".md li");
    const range = document.createRange();
    range.setStart((items[0] as Node).firstChild as Node, 0);
    range.setEnd(items[1] as Node, 0);
    const sel = document.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(copy(items[0] as HTMLElement)["text/plain"]).toBe("添加 PRIMUS_ASR_KEY");
  });

  it("只选中代码块内部的几行：保留换行与缩进", () => {
    document.body.innerHTML = `<div class="md">${renderMarkdown("```\nif a:\n    b()\n\nc()\n```")}</div>`;
    const code = document.querySelector(".md pre code") as HTMLElement;
    const textNode = (() => {
      const w = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      return w.nextNode() as Text;
    })();
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.data.indexOf("c()"));
    const sel = document.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(copy(code)["text/plain"]).toBe("if a:\n    b()\n");
  });

  it("用户消息正文：多行与缩进原样复制（整条或只选一部分）", async () => {
    const { render } = await import("@testing-library/react");
    const { UserBubble } = await import("@/features/chat/user-bubble");
    document.body.innerHTML = "";
    const { container } = render(<UserBubble text={"第一行\n  第二行\n\n\n第三行"} index={0} />);
    const p = container.querySelector("[data-copy-pre]") as HTMLElement;
    const sel = document.getSelection() as Selection;
    const range = document.createRange();
    range.selectNodeContents(container);
    sel.removeAllRanges();
    sel.addRange(range);
    expect(copy(p)["text/plain"]).toBe("第一行\n  第二行\n\n\n第三行");
    // 只选中正文中间的一段
    const t = p.firstChild as Text;
    const part = document.createRange();
    part.setStart(t, 0);
    part.setEnd(t, t.data.indexOf("\n\n"));
    sel.removeAllRanges();
    sel.addRange(part);
    expect(copy(p)["text/plain"]).toBe("第一行\n  第二行");
  });
});

function copy(target: HTMLElement) {
  const data: Record<string, string> & { prevented?: boolean } = {};
  handleCopy({
    target,
    clipboardData: { setData: (k: string, v: string) => (data[k] = v) },
    preventDefault: () => (data.prevented = true),
  } as unknown as ClipboardEvent);
  return data;
}
