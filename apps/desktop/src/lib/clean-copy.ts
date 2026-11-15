// 选中复制（Ctrl+C / 右键复制）时写进剪贴板的内容。
//
// WebView2（Chromium）默认把选区连同“计算后的样式”一起复制成 HTML：字体、字号、颜色（深色模式下是浅色字）、
// 背景、圆角等都以内联 style 带进 Word、邮件、飞书等富文本编辑器；文件引用胶囊只复制出文件名，完整路径丢失；
// 粘贴到富文本编辑器还会变成列表、代码块。这里改为：
// 只写 text/plain：选中的文字本身，不带任何格式（粘贴到富文本编辑器时不会变成列表、代码块、表格），
// 也不添加任何内容（列表的符号与序号、分隔线记号、来源、水印等都不加）。图标、按钮不复制；
// 文件引用胶囊界面上只显示文件名，复制为回复原文里的完整路径与行号；代码块的换行、缩进与空行原样保留；
// 表格单元格用制表符分隔。输入框、代码编辑器、终端里的复制保持系统默认行为。

/** 选区在这些元素里时不接管（它们有自己的复制逻辑或本来就是纯文本） */
const NATIVE_COPY =
  "input, textarea, [contenteditable=''], [contenteditable='true'], .cm-editor, .xterm";

/** 原样保留（去掉属性）的语义标签 */
const KEEP = new Set([
  "p",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "del",
  "s",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "blockquote",
  "a",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "hr",
]);
/** 不复制的元素：图标、脚本、样式、表单控件 */
const SKIP = new Set(["svg", "script", "style", "template", "img", "input", "textarea", "select"]);
/** 布局容器：保留为不带属性的块，复制多条消息时仍各自成段 */
const BLOCK_WRAPPERS = new Set(["div", "article", "section", "header", "footer", "main", "aside"]);
/** 纯文本中自成一段的元素 */
const BLOCK = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "ul",
  "ol",
  "li",
  "blockquote",
  "table",
  "tr",
  "hr",
  ...BLOCK_WRAPPERS,
]);
const SAFE_HREF = /^(https?:|mailto:)/i;
/** 干净片段里按原样复制的文字（文件引用路径） */
const RAW_TEXT = "data-raw-text";
/** 干净片段里来自 Markdown 渲染的代码块（末尾换行是渲染器加的） */
const RENDERED_PRE = "data-rendered-pre";

/** 把选区克隆出的片段转换成干净的 HTML 片段（新文档中的节点） */
export function cleanFragment(src: DocumentFragment | Node, doc: Document): DocumentFragment {
  const out = doc.createDocumentFragment();
  for (const child of Array.from(src.childNodes)) appendClean(child, out, doc);
  return out;
}

function appendClean(node: Node, parent: Node, doc: Document): void {
  if (node.nodeType === 3) {
    parent.appendChild(doc.createTextNode(node.textContent ?? ""));
    return;
  }
  if (node.nodeType !== 1 && node.nodeType !== 11) return;
  if (node.nodeType === 11) {
    for (const c of Array.from(node.childNodes)) appendClean(c, parent, doc);
    return;
  }
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (
    SKIP.has(tag) ||
    el.getAttribute("aria-hidden") === "true" ||
    el.hasAttribute("data-copy-skip")
  )
    return;
  // 文件引用胶囊：完整路径加行号（与右键“复制路径”相同）
  const fileRef = el.getAttribute("data-file-ref");
  if (fileRef !== null) {
    const code = doc.createElement("code");
    code.textContent = fileRef;
    // 路径原样复制：连续空格不能像普通段落那样合并
    code.setAttribute(RAW_TEXT, "");
    parent.appendChild(code);
    return;
  }
  // 其他按钮（复制、展开等操作）不进剪贴板
  if (tag === "button") return;
  // 按原样显示空白的正文（用户消息，whitespace-pre-wrap）：换行与缩进原样保留，按代码块处理
  if (el.hasAttribute("data-copy-pre")) {
    const pre = doc.createElement("pre");
    for (const c of Array.from(el.childNodes)) appendClean(c, pre, doc);
    parent.appendChild(pre);
    return;
  }
  let target: Node = parent;
  if (KEEP.has(tag)) {
    const copy = doc.createElement(tag);
    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      if (SAFE_HREF.test(href.trim())) copy.setAttribute("href", href.trim());
    } else if (tag === "ol") {
      const start = el.getAttribute("start");
      if (start && /^\d+$/.test(start)) copy.setAttribute("start", start);
    } else if (tag === "td" || tag === "th") {
      for (const a of ["colspan", "rowspan"]) {
        const v = el.getAttribute(a);
        if (v && /^\d+$/.test(v)) copy.setAttribute(a, v);
      }
    }
    // Markdown 渲染的代码块，源码末尾自带一个换行（不是用户选中的内容）
    if (tag === "pre") copy.setAttribute(RENDERED_PRE, "");
    parent.appendChild(copy);
    target = copy;
  } else if (BLOCK_WRAPPERS.has(tag)) {
    const div = doc.createElement("div");
    parent.appendChild(div);
    target = div;
  }
  for (const c of Array.from(el.childNodes)) appendClean(c, target, doc);
}

/**
 * 干净片段的纯文本：只有选中的文字本身，不添加任何内容（不加列表符号与序号、分隔线记号等）。
 * 块元素各自成行，表格单元格用制表符分隔；代码块（pre）里的换行、缩进与空行原样保留，
 * 只合并普通段落之间多余的空行。
 */
export function fragmentText(root: Node): string {
  // 每行记下是否来自代码块：代码块里的空行原样保留
  const lines: { text: string; pre: boolean }[] = [];
  let line = "";
  const flush = () => {
    lines.push({ text: line.replace(/\s+$/, ""), pre: false });
    line = "";
  };
  const breakBlock = () => {
    if (line.trim() !== "") flush();
    else line = "";
  };

  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      const collapsed = (node.textContent ?? "").replace(/[ \t\r\n]+/g, " ");
      line += line === "" || /\s$/.test(line) ? collapsed.replace(/^ /, "") : collapsed;
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    const tag = node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : "";
    if (tag && (node as Element).hasAttribute(RAW_TEXT)) {
      line += node.textContent ?? "";
      return;
    }
    const kids = Array.from(node.childNodes);
    switch (tag) {
      case "br":
        flush();
        return;
      case "hr":
        breakBlock();
        return;
      case "tr": {
        breakBlock();
        const cells = kids
          .filter((c) => c.nodeType === 1)
          .map((c) => fragmentText(c).replace(/\n+/g, " ").trim());
        lines.push({ text: cells.join("\t"), pre: false });
        return;
      }
      case "pre": {
        breakBlock();
        // 原样保留，选中的末尾换行也保留；只去掉 Markdown 渲染器在代码块末尾加的那个换行
        let raw = (node.textContent ?? "").replace(/\r\n?/g, "\n");
        if ((node as Element).hasAttribute(RENDERED_PRE)) raw = raw.replace(/\n$/, "");
        for (const l of raw.split("\n")) lines.push({ text: l, pre: true });
        return;
      }
    }
    const block = BLOCK.has(tag);
    if (block) breakBlock();
    for (const c of kids) walk(c);
    if (block) breakBlock();
  };
  walk(root);
  if (line.trim() !== "") flush();
  // 普通段落之间不留连续空行，首尾不留空行；代码块里的行原样保留
  const out: { text: string; pre: boolean }[] = [];
  for (const l of lines) {
    if (!l.pre && l.text === "" && (out.length === 0 || out.at(-1)?.text === "")) continue;
    out.push(l);
  }
  while (out.length > 0 && !out.at(-1)?.pre && out.at(-1)?.text === "") out.pop();
  return out.map((l) => l.text).join("\n");
}

/** 选区应交给系统默认复制（输入框、编辑器、终端里，或没有选中内容）时返回 true */
export function isNativeCopy(selection: Selection | null): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return true;
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return !el || !!el.closest(NATIVE_COPY);
}

/** document 的 copy 事件处理：接管时只写入选中的纯文本（不带格式，也不添加任何内容） */
export function handleCopy(e: ClipboardEvent): void {
  const doc = (e.target as Node | null)?.ownerDocument ?? document;
  const selection = doc.getSelection();
  if (isNativeCopy(selection) || !e.clipboardData || !selection) return;
  const holder = doc.createElement("div");
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    const anc = range.commonAncestorContainer;
    const ancEl = anc.nodeType === 1 ? (anc as Element) : anc.parentElement;
    // 只选中文件引用胶囊内部的文字时，克隆出的片段不含胶囊本身（及其 data-file-ref）：按整个胶囊复制完整路径
    const fileRef = ancEl?.closest("[data-file-ref]");
    let contents: DocumentFragment;
    if (fileRef) {
      contents = doc.createDocumentFragment();
      contents.appendChild(fileRef.cloneNode(false));
    } else contents = range.cloneContents();
    const fragment = cleanFragment(contents, doc);
    // 只选中代码块（或用户消息正文）内部的文字时，克隆出的片段不含外层元素：补上 pre，保留换行与缩进
    if (ancEl?.closest("pre, [data-copy-pre]")) {
      const pre = doc.createElement("pre");
      pre.appendChild(fragment);
      holder.appendChild(pre);
    } else if (ancEl?.tagName.toLowerCase() === "tr") {
      // 选区在同一行内跨多个单元格时，片段只有几个单元格、不含行：补上行，单元格之间仍用制表符
      const tr = doc.createElement("tr");
      tr.appendChild(fragment);
      holder.appendChild(tr);
    } else holder.appendChild(fragment);
  }
  const text = fragmentText(holder);
  if (!text) return;
  e.clipboardData.setData("text/plain", text);
  e.preventDefault();
}
