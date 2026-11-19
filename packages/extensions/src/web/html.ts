// 网页 HTML → 便于模型阅读的 Markdown 文本（primus-web 的 web_fetch 用，ADR 0020）。
// 不引入依赖：逐段扫描处理，目标是“读得懂”而不是忠实还原排版——
// 去掉脚本、样式、导航、页脚等噪音；优先取 <main> / <article>；标题、列表、链接、代码块、表格转成 Markdown；
// 代码块里的空白原样保留，其余空白合并。

/** 常见命名实体（其余命名实体原样保留） */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwj: "",
  zwnj: "",
  shy: "",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  times: "×",
  divide: "÷",
  plusmn: "±",
  deg: "°",
  para: "¶",
  sect: "§",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  hearts: "♥",
  check: "✓",
};

/** 代码块占位符的标记字符（私用区）。页面里自带的同一字符（含实体编码）在转换前去掉，占位符无法伪造 */
const MARK = "\uE000";
const MARK_CODE = 0xe000;

/** 解码 HTML 实体（命名实体只认常见的；数字实体全部支持，非法码点替换为 U+FFFD） */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (all, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff) ||
        code === MARK_CODE
      )
        return "\uFFFD";
      return String.fromCodePoint(code);
    }
    const named = NAMED[body.toLowerCase()];
    return named ?? all;
  });
}

// 网页内容不可信：所有扫描都保证线性耗时（正则同步执行、无法中断，畸形页面不能拖住 Core）。
// 开始标签到其后第一个引号外的 `>` 为止（属性值里允许出现 `>`）；
// 找不到 `>` 或结束标签时立即停止（后面的同类标签也不会有）。

/**
 * 从 `pos`（标签名之后）找标签结束的 `>`：跳过 `=` 之后的引号属性值。
 * 引号不闭合时退回引号外的第一个 `>`（不让一个坏引号吞掉整页）；都没有返回 -1。
 * 从 `pos` 到结果最多扫两遍，线性。
 */
function tagEnd(s: string, pos: number): number {
  let prev = "";
  for (let i = pos; i < s.length; i++) {
    const c = s[i] as string;
    if (c === ">") return i;
    if ((c === '"' || c === "'") && prev === "=") {
      const q = s.indexOf(c, i + 1);
      if (q < 0) return s.indexOf(">", pos);
      i = q;
      prev = c;
      continue;
    }
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r" && c !== "\f") prev = c;
  }
  return -1;
}

/**
 * 查找 `pos` 之后的标签结束（`tagEnd`）。调用方按位置递增调用（下一次从上一个结果之后开始），
 * 一旦某次找不到，之后的查找直接返回 -1，连续查找总耗时线性。
 */
function gtFinder(s: string): (pos: number) => number {
  let none = Number.POSITIVE_INFINITY;
  return (pos) => {
    if (pos >= none) return -1;
    const end = tagEnd(s, pos);
    if (end < 0) none = pos;
    return end;
  };
}

/** 去掉所有标签（不解码实体）。线性扫描：`<` 之后没有 `>` 时其余原样保留 */
export function stripTags(html: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const lt = html.indexOf("<", at);
    if (lt < 0) break;
    const gt = tagEnd(html, lt + 1);
    if (gt < 0) break;
    out += html.slice(at, lt);
    at = gt + 1;
  }
  return out + html.slice(at);
}

/** 按起止标记线性删除成对内容（如注释）；找不到结束标记时停止 */
function removeDelimited(s: string, open: string, close: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const a = s.indexOf(open, at);
    if (a < 0) break;
    const b = s.indexOf(close, a + open.length);
    if (b < 0) break;
    out += s.slice(at, a);
    at = b + close.length;
  }
  return out + s.slice(at);
}

/**
 * 标签名之后的结束判断：标签名后只能是空白、`/` 或 `>`（`\b` 会在 `nav-panel` 的连字符前误判为 `nav`）。
 * 所有按标签名匹配的正则都用它结尾。
 */
const NAME_END = "(?=[\\t\\n\\f\\r />])";

/** 匹配开始标签 `<tag`（标签名完整匹配，不区分大小写，全局） */
function openTag(names: string): RegExp {
  return new RegExp(`<(?:${names})${NAME_END}`, "gi");
}

/** 逐个替换单个标签（`head` 匹配标签开头，如 `openTag("img")`）；`by` 收到整个标签文本 */
function replaceTags(s: string, head: RegExp, by: (tag: string) => string): string {
  const nextGt = gtFinder(s);
  let out = "";
  let at = 0;
  for (;;) {
    head.lastIndex = at;
    const o = head.exec(s);
    if (!o) break;
    const gt = nextGt(o.index + o[0].length);
    if (gt < 0) break;
    out += s.slice(at, o.index) + by(s.slice(o.index, gt + 1));
    at = gt + 1;
  }
  return out + s.slice(at);
}

/**
 * 逐个替换 `<tag …>…</tag>`（不区分大小写，取最近的结束标签）。`fn` 收到内部内容、开始标签的属性与整段原文。
 * 返回 undefined 时提前结束（其余原样保留）。
 */
export function replaceElements(
  s: string,
  tag: string,
  fn: (inner: string, attrs: string, all: string) => string | undefined,
): string {
  const head = openTag(tag);
  const close = new RegExp(`<\\/${tag}\\s{0,64}>`, "gi");
  const nextGt = gtFinder(s);
  let out = "";
  let at = 0;
  for (;;) {
    head.lastIndex = at;
    const o = head.exec(s);
    if (!o) break;
    const attrsStart = o.index + o[0].length;
    const gt = nextGt(attrsStart);
    if (gt < 0) break;
    close.lastIndex = gt + 1;
    const c = close.exec(s);
    if (!c) break;
    const end = c.index + c[0].length;
    const by = fn(s.slice(gt + 1, c.index), s.slice(attrsStart, gt), s.slice(o.index, end));
    if (by === undefined) break;
    out += s.slice(at, o.index) + by;
    at = end;
  }
  return out + s.slice(at);
}

/** 第一个 `<tag …>…</tag>` 的内部内容 */
function firstElement(s: string, tag: string): string | undefined {
  let found: string | undefined;
  replaceElements(s, tag, (inner) => {
    found = inner;
    return undefined;
  });
  return found;
}

/**
 * HTML 开头里的 `<meta>` 编码声明（编码预扫描）：`charset` 属性，或 `http-equiv="content-type"` 时
 * 从 `content` 属性里取 `charset=`。只看完整属性（`name="description" content="… charset=gbk …"` 不算），
 * 注释里的不算；没有时返回 undefined。
 */
export function metaCharset(head: string): string | undefined {
  let found: string | undefined;
  replaceTags(removeDelimited(head, "<!--", "-->"), openTag("meta"), (tag) => {
    if (found !== undefined) return "";
    const charset = attr(tag, "charset")?.trim();
    if (charset) found = charset;
    else if (attr(tag, "http-equiv")?.trim().toLowerCase() === "content-type")
      found = /charset\s*=\s*["']?([\w-]+)/i.exec(attr(tag, "content") ?? "")?.[1];
    return "";
  });
  return found;
}

/** 网页标题：<title>，没有时取 og:title */
export function htmlTitle(html: string): string | undefined {
  let raw = firstElement(html, "title");
  if (raw === undefined)
    replaceTags(html, openTag("meta"), (tag) => {
      if (raw === undefined && attr(tag, "property")?.toLowerCase() === "og:title")
        raw = attr(tag, "content");
      return "";
    });
  if (raw === undefined) return undefined;
  const title = decodeEntities(stripTags(raw)).replace(/\s+/g, " ").trim();
  return title || undefined;
}

/** 整段删除的元素（连同内容） */
const DROP = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "head",
  "nav",
  "footer",
  "aside",
  "form",
  "button",
  "select",
  "textarea",
  "dialog",
];

/** 块级元素：前后换段 */
const BLOCK = new RegExp(
  `<\\/?(?:p|div|section|article|main|header|blockquote|ul|ol|dl|dd|figure|figcaption|table|thead|tbody|tfoot|details|summary|address|hr)${NAME_END}`,
  "gi",
);

const isSpace = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/**
 * 取属性值（双引号、单引号或不加引号）。`tag` 是整个标签（`<a …>`）或标签名之后的属性部分。
 * 逐个读出属性名与值，只在属性名完整匹配（不区分大小写）时返回，其他属性值里的同名文字不算
 * （`title="href=/old"`、`data-href` 都不是 `href`）。只看前 8192 个字符，线性。
 */
export function attr(tag: string, name: string): string | undefined {
  const s = tag.slice(0, 8192);
  const want = name.toLowerCase();
  let i = 0;
  // 整个标签时跳过 `<标签名`
  if (s[0] === "<") while (i < s.length && !isSpace(s[i]) && s[i] !== "/" && s[i] !== ">") i++;
  while (i < s.length) {
    while (i < s.length && (isSpace(s[i]) || s[i] === "/")) i++;
    if (i >= s.length || s[i] === ">") return undefined;
    // 属性名：到空白、`/`、`>`、`=` 为止（首字符是 `=` 时算作名字的一部分，同 HTML 解析）
    const nameStart = i++;
    while (i < s.length && !isSpace(s[i]) && s[i] !== "/" && s[i] !== ">" && s[i] !== "=") i++;
    const key = s.slice(nameStart, i).toLowerCase();
    while (i < s.length && isSpace(s[i])) i++;
    if (s[i] !== "=") continue; // 没有值的属性
    i++;
    while (i < s.length && isSpace(s[i])) i++;
    let value: string;
    const q = s[i];
    if (q === '"' || q === "'") {
      const end = s.indexOf(q, i + 1);
      value = s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end + 1;
    } else {
      const start = i;
      while (i < s.length && !isSpace(s[i]) && s[i] !== ">") i++;
      value = s.slice(start, i);
    }
    if (key === want) return value;
  }
  return undefined;
}

/**
 * 链接地址的长度预算：相对链接按页面地址补全后会变长（每个都复制一遍页面地址），
 * 不设上限时链接密集的页面转换结果可远超响应体本身。单个地址超过 MAX_HREF_CHARS、
 * 或所有链接地址累计超过 MAX_LINK_CHARS 后，链接只保留文字（不带地址）。
 */
export const MAX_HREF_CHARS = 2048;
export const MAX_LINK_CHARS = 1_000_000;

/** 相对地址按页面地址补全；只保留 http / https 链接，其他（javascript:、mailto:、页内锚点）返回 undefined */
function absoluteHref(href: string | undefined, base: string | undefined): string | undefined {
  // 原文可能含实体（`&amp;`），先放宽到 4 倍粗筛，补全后再按准确长度判断
  if (!href || href.length > MAX_HREF_CHARS * 4) return undefined;
  const h = decodeEntities(href.trim());
  if (!h || h.startsWith("#")) return undefined;
  try {
    const u = base ? new URL(h, base) : new URL(h);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    // 补全（含百分号编码）后仍可能变长：超过单个上限的不要
    return u.href.length <= MAX_HREF_CHARS ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** 取正文区域：有 <main> 用 <main>，否则用最长的 <article>，都没有用 <body>（或整页） */
function contentRegion(html: string): string {
  const main = firstElement(html, "main");
  if (main && stripTags(main).trim().length > 200) return main;
  let best = "";
  replaceElements(html, "article", (inner) => {
    if (inner.length > best.length) best = inner;
    return "";
  });
  if (stripTags(best).trim().length > 200) return best;
  // <body> 到最后一个 </body>（没有结束标签时到末尾）
  const open = openTag("body").exec(html);
  if (!open) return html;
  const gt = tagEnd(html, open.index + open[0].length);
  if (gt < 0) return html;
  const start = gt + 1;
  const close = /<\/body\s{0,64}>/gi;
  close.lastIndex = start;
  let end = html.length;
  for (let c = close.exec(html); c; c = close.exec(html)) end = c.index;
  return html.slice(start, end);
}

/** HTML → Markdown 文本。`baseUrl` 用来补全相对链接 */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  let s = removeDelimited(html.replaceAll(MARK, ""), "<!--", "-->");
  s = removeDelimited(s, "<![CDATA[", "]]>");
  for (const tag of DROP) s = replaceElements(s, tag, () => " ");
  // 页头常是站点导航；只在它不像正文标题区时去掉（含 h1 的保留）
  s = replaceElements(s, "header", (inner, _attrs, all) => (openTag("h1").test(inner) ? all : " "));
  s = contentRegion(s);

  // 代码块：先换成占位符，最后还原，保证里面的空白与换行不被合并
  const blocks: string[] = [];
  s = replaceElements(s, "pre", (inner) => {
    const code = decodeEntities(stripTags(inner.replace(/<br\s{0,64}\/?>/gi, "\n")))
      .replace(/^\n+/, "")
      .trimEnd();
    const lang =
      /class\s{0,64}=\s{0,64}["'][^"']{0,512}?\blang(?:uage)?-([\w+-]{1,64})/i.exec(
        inner.slice(0, 1024),
      )?.[1] ?? "";
    // 围栏要长于内容里独占一行的反引号序列（否则该行会提前关闭代码块），至少 3 个
    let longest = 0;
    for (const line of code.split("\n")) {
      const run = /^[ \t]*(`+)[ \t]*$/.exec(line)?.[1]?.length ?? 0;
      if (run > longest) longest = run;
    }
    const fence = "`".repeat(Math.max(3, longest + 1));
    blocks.push(`${fence}${lang}\n${code}\n${fence}`);
    return `${MARK}${blocks.length - 1}${MARK}`;
  });

  for (let level = 1; level <= 6; level++)
    s = replaceElements(s, `h${level}`, (inner) => {
      const text = stripTags(inner).replace(/\s+/g, " ").trim();
      return text ? `\n\n${"#".repeat(level)} ${text}\n\n` : "\n\n";
    });
  let linkBudget = MAX_LINK_CHARS;
  s = replaceElements(s, "a", (inner, attrs) => {
    const text = stripTags(inner).replace(/\s+/g, " ").trim();
    if (!text) return "";
    // 预算用完后不再解析地址，链接只留文字
    const href = linkBudget > 0 ? absoluteHref(attr(attrs, "href"), baseUrl) : undefined;
    if (!href) return text;
    // href 已在 absoluteHref 里解码过一次；文本最后还要整体解码，这里把 `&` 写回 `&amp;`，
    // 让那次解码只还原出原样的 `&`（`&amp;copy;` 解码一次得到字面 `&copy;`，不能再变成 ©）
    const dest = href.replaceAll("&", "&amp;");
    if (dest.length > linkBudget) {
      linkBudget = 0;
      return text;
    }
    linkBudget -= dest.length;
    return `[${text}](${dest})`;
  });
  s = replaceTags(s, openTag("img"), (tag) => {
    const alt = attr(tag, "alt")?.trim();
    return alt ? `[图片：${alt}]` : "";
  });
  s = replaceElements(s, "code", (inner) => {
    const text = stripTags(inner);
    return text.trim() ? `\`${text}\`` : "";
  });
  for (const tag of ["strong", "b"])
    s = replaceElements(s, tag, (inner) => (inner.trim() ? `**${inner.trim()}**` : ""));
  s = s
    .replace(/<br\s{0,64}\/?>/gi, "\n")
    .replace(/<\/li\s{0,64}>/gi, "\n")
    .replace(/<\/t[dh]\s{0,64}>/gi, " |");
  s = replaceTags(s, openTag("li"), () => "\n- ");
  s = replaceTags(s, openTag("dt"), () => "\n\n");
  s = replaceTags(s, openTag("tr"), () => "\n|");
  s = replaceTags(s, openTag("td|th"), () => " ");
  s = replaceTags(s, BLOCK, () => "\n\n");

  s = decodeEntities(stripTags(s));

  // 合并空白：行内多个空白合成一个，行首尾去空白，连续空行最多一行
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00a0\u3000]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  // 只剩一个竖线或横杠的残行（空表格单元、空列表项）去掉
  s = s.replace(/^(\||-)[ \t]*$/gm, "").replace(/\n{3,}/g, "\n\n");
  // 还原代码块：普通文本整理完再拼接，代码块里的空行原样保留；每个占位符只还原一次
  const parts = s.split(new RegExp(`${MARK}(\\d+)${MARK}`));
  const used = new Set<number>();
  const out: string[] = [];
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      const text = part.replace(/^\n+|\n+$/g, "");
      if (text.trim()) out.push(text);
      return;
    }
    const n = Number(part);
    const block = blocks[n];
    if (block !== undefined && !used.has(n)) {
      used.add(n);
      out.push(block);
    }
  });
  return out.join("\n\n").trim();
}
