// 网页 HTML → 便于模型阅读的 Markdown 文本（primus-web 的 web_fetch 用，ADR 0020）。
// 不引入依赖：按正则逐段处理，目标是“读得懂”而不是忠实还原排版——
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
        (code >= 0xd800 && code <= 0xdfff)
      )
        return "\uFFFD";
      return String.fromCodePoint(code);
    }
    const named = NAMED[body.toLowerCase()];
    return named ?? all;
  });
}

/** 去掉所有标签（不解码实体） */
const stripTags = (html: string) => html.replace(/<[^>]*>/g, "");

/** 网页标题：<title>，没有时取 og:title */
export function htmlTitle(html: string): string | undefined {
  const raw =
    /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ??
    /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(
      html,
    )?.[1];
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
const BLOCK =
  /<\/?(p|div|section|article|main|header|blockquote|ul|ol|dl|dd|figure|figcaption|table|thead|tbody|tfoot|details|summary|address|hr)\b[^>]*>/gi;

/** 取属性值（双引号、单引号或不加引号） */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** 相对地址按页面地址补全；只保留 http / https 链接，其他（javascript:、mailto:、页内锚点）返回 undefined */
function absoluteHref(href: string | undefined, base: string | undefined): string | undefined {
  if (!href) return undefined;
  const h = decodeEntities(href.trim());
  if (!h || h.startsWith("#")) return undefined;
  try {
    const u = base ? new URL(h, base) : new URL(h);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** 取正文区域：有 <main> 用 <main>，否则用最长的 <article>，都没有用 <body>（或整页） */
function contentRegion(html: string): string {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1];
  if (main && stripTags(main).trim().length > 200) return main;
  let best = "";
  for (const m of html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi))
    if ((m[1]?.length ?? 0) > best.length) best = m[1] ?? "";
  if (stripTags(best).trim().length > 200) return best;
  return /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
}

/** HTML → Markdown 文本。`baseUrl` 用来补全相对链接 */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  for (const tag of DROP)
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
  // 页头常是站点导航；只在它不像正文标题区时去掉（含 h1 的保留）
  s = s.replace(/<header\b[^>]*>([\s\S]*?)<\/header\s*>/gi, (all, inner: string) =>
    /<h1\b/i.test(inner) ? all : " ",
  );
  s = contentRegion(s);

  // 代码块：先换成占位符，最后还原，保证里面的空白与换行不被合并
  const blocks: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_all, inner: string) => {
    const code = decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, "\n"))).replace(
      /^\n+|\s+$/g,
      "",
    );
    const lang = /class\s*=\s*["'][^"']*\blang(?:uage)?-([\w+-]+)/i.exec(inner)?.[1] ?? "";
    blocks.push(`\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`);
    return `\uE000${blocks.length - 1}\uE000`;
  });

  s = s
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_all, level: string, inner: string) => {
      const text = stripTags(inner).replace(/\s+/g, " ").trim();
      return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "\n\n";
    })
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_all, attrs: string, inner: string) => {
      const text = stripTags(inner).replace(/\s+/g, " ").trim();
      const href = absoluteHref(attr(attrs, "href"), baseUrl);
      if (!text) return "";
      return href ? `[${text}](${href})` : text;
    })
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const alt = attr(tag, "alt")?.trim();
      return alt ? `[图片：${alt}]` : "";
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_all, inner: string) => {
      const text = stripTags(inner);
      return text.trim() ? `\`${text}\`` : "";
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_all, _t, inner: string) =>
      inner.trim() ? `**${inner.trim()}**` : "",
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<dt\b[^>]*>/gi, "\n\n")
    .replace(/<tr\b[^>]*>/gi, "\n|")
    .replace(/<\/t[dh]\s*>/gi, " |")
    .replace(/<t[dh]\b[^>]*>/gi, " ")
    .replace(BLOCK, "\n\n");

  s = decodeEntities(stripTags(s));

  // 合并空白：行内多个空白合成一个，行首尾去空白，连续空行最多一行
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00a0\u3000]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  // 只剩一个竖线或横杠的残行（空表格单元、空列表项）去掉
  s = s.replace(/^(\||-)\s*$/gm, "").replace(/\n{3,}/g, "\n\n");
  // 还原代码块
  s = s.replace(/\uE000(\d+)\uE000/g, (_all, i: string) => blocks[Number(i)] ?? "");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}
