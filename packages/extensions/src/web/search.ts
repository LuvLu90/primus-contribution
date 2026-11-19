// web_search：内置联网搜索（LangSearch Web Search API，ADR 0020）。
// - 接口：POST <PRIMUS_SEARCH_BASE_URL>/web-search，Bearer 密钥；开启 summary，结果带长摘要。
// - 两把内置密钥轮流使用；一把遇到网络错误、超时、401 / 403 / 429 / 5xx 时换另一把，用户无感。
//   429 的那把冷却 60 秒，401 / 403 冷却 10 分钟；全部都在冷却时仍按顺序再试一遍。
// - 给模型的结果：编号、标题、链接、日期、摘要（单条与总量都截断，控制上下文）。

import {
  WEBSEARCH_FRESHNESS,
  WEBSEARCH_MAX_COUNT,
  type WebSearchDetails,
  type WebSearchResult,
} from "@primus/protocol";
import { linkedSignal, readLimited, siteOf, WebError } from "./net.ts";

/** 单次请求超时 */
export const SEARCH_TIMEOUT_MS = 20_000;
/** 默认结果数 */
export const DEFAULT_COUNT = 8;
/** 单条摘要最多给模型的字符数 */
export const MAX_SUMMARY_CHARS = 1200;
/** 全部结果最多给模型的字符数 */
export const MAX_RESULT_CHARS = 14_000;
/** 搜索响应体上限 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** 查询词最大长度 */
export const MAX_QUERY_CHARS = 400;
/** 冷却时长 */
const COOLDOWN_RATE_LIMIT_MS = 60_000;
const COOLDOWN_AUTH_MS = 10 * 60_000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_RANGE = /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/;

export interface SearchParams {
  query: string;
  freshness?: string;
  count?: number;
  include_domains?: string[];
  exclude_domains?: string[];
}

export interface NormalizedSearch {
  query: string;
  freshness: string;
  count: number;
  includeDomains: string[];
  excludeDomains: string[];
}

/** 域名列表：去掉协议与路径，只留主机名，最多 20 个 */
function domains(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const d of list) {
    if (typeof d !== "string") continue;
    const host = d
      .trim()
      .replace(/^[a-z]+:\/\//i, "")
      .replace(/[/?#].*$/, "")
      .toLowerCase();
    if (/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(host)) out.add(host);
    if (out.size >= 20) break;
  }
  return [...out];
}

/** 规范化参数：未知时间范围回到 noLimit，结果数夹到 1–20 */
export function normalizeSearch(p: Partial<SearchParams> | undefined): NormalizedSearch {
  const query = typeof p?.query === "string" ? p.query.trim().replace(/\s+/g, " ") : "";
  const f = typeof p?.freshness === "string" ? p.freshness.trim() : "";
  const freshness =
    (WEBSEARCH_FRESHNESS as readonly string[]).includes(f) || DATE.test(f) || DATE_RANGE.test(f)
      ? f
      : "noLimit";
  const raw = Number(p?.count);
  const count = Number.isFinite(raw)
    ? Math.min(WEBSEARCH_MAX_COUNT, Math.max(1, Math.trunc(raw)))
    : DEFAULT_COUNT;
  return {
    query,
    freshness,
    count,
    includeDomains: domains(p?.include_domains),
    excludeDomains: domains(p?.exclude_domains),
  };
}

/** LangSearch 的一条结果 */
interface ApiPage {
  name?: unknown;
  url?: unknown;
  snippet?: unknown;
  summary?: unknown;
  text?: unknown;
  datePublished?: unknown;
}

export interface SearchHit extends WebSearchResult {
  summary: string;
}

/** 错误响应里的说明，截断到 300 字符 */
function errorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { msg?: unknown; message?: unknown; error?: unknown };
    const m = [j.msg, j.message, (j.error as { message?: unknown })?.message, j.error].find(
      (v) => typeof v === "string" && v,
    );
    if (typeof m === "string") return m.slice(0, 300);
  } catch {}
  return body.trim().slice(0, 300);
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function validHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

/** 解析响应：只保留 http(s) 链接的结果，按网址去重 */
export function parseResults(body: unknown): SearchHit[] {
  const pages = (body as { data?: { webPages?: { value?: unknown } } })?.data?.webPages?.value;
  if (!Array.isArray(pages)) return [];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const p of pages as ApiPage[]) {
    const url = str(p?.url);
    const title = str(p?.name) || url;
    // 只要有主机名的 http(s) 链接，同一网址只留一条（前端按网址区分来源）
    if (!validHttpUrl(url) || seen.has(url)) continue;
    seen.add(url);
    const date = str(p?.datePublished);
    hits.push({
      title,
      url,
      site: siteOf(url),
      ...(date ? { date } : {}),
      summary: str(p?.summary) || str(p?.snippet) || str(p?.text),
    });
  }
  return hits;
}

/** 一次请求：成功返回结果；失败抛 WebError（retry 表示可换密钥），用户停止时抛 AbortError */
export async function requestSearch(
  fetchImpl: typeof fetch,
  opts: {
    baseUrl: string;
    apiKey: string;
    search: NormalizedSearch;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<SearchHit[]> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const s = opts.search;
  const link = linkedSignal(opts.signal, opts.timeoutMs ?? SEARCH_TIMEOUT_MS);
  const failed = (e: unknown): never => {
    if (opts.signal?.aborted || e instanceof WebError) throw e;
    throw new WebError(link.timedOut() ? "搜索服务响应超时" : "无法连接搜索服务", true);
  };
  try {
    const res = await fetchImpl(`${base}/web-search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: s.query,
        count: s.count,
        freshness: s.freshness,
        summary: true,
        ...(s.includeDomains.length ? { includeDomains: s.includeDomains } : {}),
        ...(s.excludeDomains.length ? { excludeDomains: s.excludeDomains } : {}),
      }),
      signal: link.signal,
    }).catch(failed);
    const classify = (status: number, message: string): never => {
      const retry = status === 401 || status === 403 || status === 429 || status >= 500;
      throw new WebError(
        retry ? `搜索服务暂不可用（HTTP ${status}）` : `搜索服务拒绝了这次请求：${message}`,
        retry,
        status,
      );
    };
    if (!res.ok) {
      // 先按状态分类；错误说明只读前一部分（过大的错误响应不影响换密钥）
      const { bytes } = await readLimited(res, 64 * 1024, "truncate").catch(() => ({
        bytes: new Uint8Array(),
      }));
      classify(res.status, errorMessage(new TextDecoder().decode(bytes)) || `HTTP ${res.status}`);
    }
    const { bytes } = await readLimited(res, MAX_RESPONSE_BYTES, "error").catch(failed);
    const text = new TextDecoder().decode(bytes);
    let body: { code?: unknown };
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw 0;
      body = parsed as { code?: unknown };
    } catch {
      throw new WebError("搜索服务返回的内容无法解析", true);
    }
    // 业务码不是 200 时按 HTTP 状态同样处理（服务有时 HTTP 200 + 业务错误码）
    if (typeof body.code === "number" && body.code !== 200)
      classify(body.code, errorMessage(text) || `code ${body.code}`);
    return parseResults(body);
  } finally {
    link.done();
  }
}

const MAX_FIELD_CHARS = 500;

const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;

/** 给模型的搜索结果文本 */
export function formatResults(query: string, hits: SearchHit[]): string {
  if (hits.length === 0)
    return `搜索“${query}”没有找到结果。可以换个说法、换语言或放宽时间范围再试。`;
  const head = `搜索“${query}”的结果（${hits.length} 条）：`;
  const parts: string[] = [head];
  // 预留分隔符与末尾两行提示的长度
  let used = head.length + 120;
  let shown = 0;
  for (const [i, h] of hits.entries()) {
    const summary =
      h.summary.length > MAX_SUMMARY_CHARS
        ? `${h.summary.slice(0, MAX_SUMMARY_CHARS)}…`
        : h.summary;
    let block = [
      `[${i + 1}] ${clip(h.title, MAX_FIELD_CHARS)}`,
      `链接：${clip(h.url, MAX_FIELD_CHARS)}`,
      ...(h.date ? [`日期：${clip(h.date, 64)}`] : []),
      ...(summary ? [`摘要：${summary}`] : []),
    ].join("\n");
    const room = MAX_RESULT_CHARS - used - 2;
    if (block.length > room) {
      if (shown > 0 || room <= 0) break;
      block = clip(block, room);
    }
    parts.push(block);
    used += block.length + 2;
    shown++;
  }
  if (shown < hits.length) parts.push(`（还有 ${hits.length - shown} 条结果因长度限制未列出）`);
  parts.push("摘要可能不完整；需要细节时用 web_fetch 打开最相关的链接。");
  return parts.join("\n\n");
}

/** 多把密钥轮流使用与故障切换 */
export class KeyPool {
  private next = 0;
  private readonly cooldown = new Map<number, number>();
  /** 每把密钥的冷却版本：成功只清除本次尝试开始前就存在的冷却，不清除期间新写入的 */
  private readonly version = new Map<number, number>();

  constructor(
    private readonly keys: readonly string[],
    private readonly now: () => number,
  ) {}

  get size(): number {
    return this.keys.length;
  }

  /** 本次请求尝试密钥的顺序：从轮到的那把开始，不在冷却的在前，冷却中的在后 */
  order(): { index: number; key: string }[] {
    const n = this.keys.length;
    if (n === 0) return [];
    const start = this.next % n;
    this.next = (start + 1) % n;
    const all = Array.from({ length: n }, (_, i) => (start + i) % n).map((index) => ({
      index,
      key: this.keys[index] as string,
    }));
    const t = this.now();
    const ready = all.filter((k) => (this.cooldown.get(k.index) ?? 0) <= t);
    const cooling = all.filter((k) => (this.cooldown.get(k.index) ?? 0) > t);
    return [...ready, ...cooling];
  }

  /** 记录一次失败：限流冷却 60 秒，鉴权失败冷却 10 分钟 */
  fail(index: number, status?: number): void {
    const ms =
      status === 429
        ? COOLDOWN_RATE_LIMIT_MS
        : status === 401 || status === 403
          ? COOLDOWN_AUTH_MS
          : undefined;
    if (ms === undefined) return;
    this.cooldown.set(index, this.now() + ms);
    this.version.set(index, this.stamp(index) + 1);
  }

  /** 开始一次尝试时记下的版本，成功后交给 `ok` */
  stamp(index: number): number {
    return this.version.get(index) ?? 0;
  }

  ok(index: number, stamp = this.stamp(index)): void {
    if (this.stamp(index) === stamp) this.cooldown.delete(index);
  }
}

/** 一次搜索（含换密钥）；返回 details 与给模型的文本 */
export async function runSearch(
  fetchImpl: typeof fetch,
  pool: KeyPool,
  baseUrl: string,
  search: NormalizedSearch,
  signal: AbortSignal | undefined,
): Promise<{ details: WebSearchDetails; text: string; isError?: boolean }> {
  const details: WebSearchDetails = { status: "failed", query: search.query, results: [] };
  let lastError = "搜索服务暂不可用";
  for (const { index, key } of pool.order()) {
    if (signal?.aborted) break;
    const stamp = pool.stamp(index);
    try {
      const hits = await requestSearch(fetchImpl, { baseUrl, apiKey: key, search, signal });
      pool.ok(index, stamp);
      details.status = "done";
      details.results = hits.map(({ summary: _s, ...r }) => r);
      return { details, text: formatResults(search.query, hits) };
    } catch (e) {
      if (signal?.aborted) break;
      if (e instanceof WebError) {
        lastError = e.message;
        pool.fail(index, e.status);
        if (e.retry) continue;
        break;
      }
      lastError = (e as Error)?.message || lastError;
      break;
    }
  }
  if (signal?.aborted) {
    details.status = "cancelled";
    return { details, text: "[cancelled] 用户已停止搜索", isError: true };
  }
  details.error = lastError;
  return { details, text: `[failed] 搜索失败：${lastError}`, isError: true };
}
