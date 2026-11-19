// web_fetch：读取网页正文（ADR 0020）。仿 Codex 网页工具的 open_page / find_in_page：
// - 打开页面：GET 网页，HTML 转成 Markdown 文本，长页面分段返回（offset 翻页）；
// - 页内查找：带 find 时只返回命中处前后的片段，长页面不必整页读。
// 安全：只允许 http / https 公网地址（每次跳转都重新检查，最多 5 次），不带 Cookie 与凭证；
// 响应体最多读 5 MB；内容只当作数据交给模型（不可信的外部内容）。

import type { WebFetchDetails } from "@primus/protocol";
import { htmlTitle, htmlToMarkdown } from "./html.ts";
import { checkPublicUrl, linkedSignal, readLimited, WebError } from "./net.ts";

/** 单次请求超时（含跳转） */
export const FETCH_TIMEOUT_MS = 30_000;
/** 最多读取的响应字节数 */
export const MAX_FETCH_BYTES = 5 * 1024 * 1024;
/** 一次返回的默认字符数与上限 */
export const DEFAULT_MAX_CHARS = 12_000;
export const MAX_CHARS_LIMIT = 40_000;
/** 最多跟随的跳转次数 */
export const MAX_REDIRECTS = 5;
/** 页内查找：最多返回的命中数与每处前后的字符数 */
export const MAX_FIND_MATCHES = 8;
export const FIND_CONTEXT_CHARS = 300;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36 Primus";

export interface FetchParams {
  url: string;
  find?: string;
  offset?: number;
  max_chars?: number;
}

export interface NormalizedFetch {
  url: string;
  find: string;
  offset: number;
  maxChars: number;
}

export function normalizeFetch(p: Partial<FetchParams> | undefined): NormalizedFetch {
  const url = typeof p?.url === "string" ? p.url.trim() : "";
  const find = typeof p?.find === "string" ? p.find.trim().slice(0, 200) : "";
  const off = Number(p?.offset);
  const max = Number(p?.max_chars);
  return {
    url,
    find,
    offset: Number.isFinite(off) ? Math.max(0, Math.trunc(off)) : 0,
    maxChars: Number.isFinite(max)
      ? Math.min(MAX_CHARS_LIMIT, Math.max(1000, Math.trunc(max)))
      : DEFAULT_MAX_CHARS,
  };
}

/** 能当文本读的内容类型 */
const TEXT_TYPES =
  /^(text\/|application\/(json|ld\+json|xml|rss\+xml|atom\+xml|javascript|x-javascript|ecmascript|x-yaml|yaml|toml|x-sh|markdown)$|application\/[\w.+-]+\+(json|xml)$)/;
const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)$/;

/** 按 Content-Type 与 HTML 的 meta 声明解码；不认识的编码按 UTF-8 */
export function decodeBody(bytes: Uint8Array, contentType: string, html: boolean): string {
  let charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset && html) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    charset =
      /<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
      /<meta\b[^>]*content\s*=\s*["'][^"']*charset=([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset?.toLowerCase() ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** 页内查找（不区分大小写）：返回命中次数与前若干处的片段 */
export function findInText(
  text: string,
  needle: string,
): { count: number; snippets: { at: number; text: string }[] } {
  const hay = text.toLowerCase();
  const n = needle.toLowerCase();
  const snippets: { at: number; text: string }[] = [];
  let count = 0;
  let from = 0;
  let lastEnd = -1;
  for (;;) {
    const at = hay.indexOf(n, from);
    if (at < 0) break;
    count++;
    from = at + Math.max(1, n.length);
    if (snippets.length >= MAX_FIND_MATCHES || at < lastEnd) continue;
    const start = Math.max(0, at - FIND_CONTEXT_CHARS);
    const end = Math.min(text.length, at + n.length + FIND_CONTEXT_CHARS);
    lastEnd = end;
    snippets.push({
      at,
      text: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    });
  }
  return { count, snippets };
}

export interface FetchDeps {
  fetch: typeof fetch;
  lookup: (host: string) => Promise<string[]>;
}

/** 打开网页（跟随跳转，每一跳都检查地址），返回最终地址、内容类型与正文文本 */
export async function fetchPage(
  deps: FetchDeps,
  rawUrl: string,
  signal: AbortSignal | undefined,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<{
  finalUrl: string;
  contentType: string;
  title?: string;
  text: string;
  truncated: boolean;
}> {
  const link = linkedSignal(signal, timeoutMs);
  const failed = (e: unknown): never => {
    if (signal?.aborted || e instanceof WebError) throw e;
    throw new WebError(link.timedOut() ? "网页响应超时" : "无法连接这个网址");
  };
  try {
    let url = await checkPublicUrl(rawUrl, deps.lookup, link.signal).catch(failed);
    let res: Response | undefined;
    for (let hop = 0; ; hop++) {
      res = await deps
        .fetch(url.href, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          headers: {
            "User-Agent": USER_AGENT,
            Accept:
              "text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          },
          signal: link.signal,
        })
        .catch(failed);
      if (res.status < 300 || res.status >= 400 || res.status === 304) break;
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new WebError(`网页跳转缺少目标地址（HTTP ${res.status}）`);
      if (hop >= MAX_REDIRECTS) throw new WebError("网页跳转次数过多");
      url = await checkPublicUrl(new URL(location, url).href, deps.lookup, link.signal).catch(
        failed,
      );
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new WebError(
        res.status === 401 || res.status === 403
          ? `网页拒绝访问（HTTP ${res.status}），可能需要登录或禁止程序访问`
          : res.status === 404
            ? "网页不存在（HTTP 404）"
            : `网页返回错误（HTTP ${res.status}）`,
        false,
        res.status,
      );
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const mime = contentType.split(";")[0]?.trim() ?? "";
    const html = HTML_TYPES.test(mime) || mime === "";
    if (!html && !TEXT_TYPES.test(mime)) {
      await res.body?.cancel().catch(() => undefined);
      throw new WebError(`不支持读取这种内容（${mime}）：只能读取网页与文本`);
    }
    const { bytes, truncated } = await readLimited(res, MAX_FETCH_BYTES, "truncate").catch(failed);
    const body = decodeBody(bytes, contentType, html);
    // 没有 Content-Type 时按内容判断是不是 HTML
    const isHtml = html && (mime !== "" || /<(html|body|head|div|p)\b/i.test(body.slice(0, 2000)));
    return {
      finalUrl: url.href,
      contentType: mime || (isHtml ? "text/html" : "text/plain"),
      ...(isHtml ? { title: htmlTitle(body) } : {}),
      text: isHtml ? htmlToMarkdown(body, url.href) : body.replace(/\r\n?/g, "\n").trim(),
      truncated,
    };
  } finally {
    link.done();
  }
}

/** 一次读取：返回 details 与给模型的文本 */
export async function runFetch(
  deps: FetchDeps,
  p: NormalizedFetch,
  signal: AbortSignal | undefined,
): Promise<{ details: WebFetchDetails; text: string; isError?: boolean }> {
  const details: WebFetchDetails = { status: "failed", url: p.url };
  if (!p.url) {
    details.error = "缺少网址（url）";
    return { details, text: `[failed] ${details.error}`, isError: true };
  }
  try {
    const page = await fetchPage(deps, p.url, signal);
    const total = page.text.length;
    details.status = "done";
    details.finalUrl = page.finalUrl;
    details.contentType = page.contentType;
    details.totalChars = total;
    if (page.title) details.title = page.title;
    const head = [
      ...(page.title ? [`标题：${page.title}`] : []),
      `地址：${page.finalUrl}`,
      `类型：${page.contentType}`,
    ];
    if (total === 0) {
      details.range = [0, 0];
      return {
        details,
        text: [...head, "", "（页面没有可读的文本内容，可能需要脚本渲染或登录）"].join("\n"),
      };
    }
    if (p.find) {
      const { count, snippets } = findInText(page.text, p.find);
      details.matches = count;
      const lines = [
        ...head,
        `查找“${p.find}”：共 ${count} 处${count > snippets.length ? `，列出前 ${snippets.length} 处` : ""}`,
      ];
      for (const s of snippets) lines.push("", `--- 位置 ${s.at} ---`, s.text);
      if (count === 0)
        lines.push("", "页面里没有找到这个词。可以换个关键词，或不带 find 直接阅读。");
      else lines.push("", "需要更多上下文时，用 offset 设为上面的位置附近再读取。");
      return { details, text: lines.join("\n") };
    }
    const start = Math.min(p.offset, total);
    const end = Math.min(total, start + p.maxChars);
    details.range = [start, end];
    const lines = [
      ...head,
      `内容：第 ${start}–${end} 字，共 ${total} 字${page.truncated ? "（网页过大，只读取了前 5 MB）" : ""}`,
      "",
      page.text.slice(start, end),
    ];
    if (end < total) lines.push("", `（未完，继续阅读请用 offset=${end}，或用 find 查找关键词）`);
    return { details, text: lines.join("\n") };
  } catch (e) {
    if (signal?.aborted) {
      details.status = "cancelled";
      return { details, text: "[cancelled] 用户已停止读取网页", isError: true };
    }
    details.status = "failed";
    details.error = e instanceof WebError ? e.message : (e as Error)?.message || "读取网页失败";
    return { details, text: `[failed] 读取网页失败：${details.error}`, isError: true };
  }
}
