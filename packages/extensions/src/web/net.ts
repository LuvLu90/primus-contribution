// primus-web 的网络工具：地址检查、带超时与取消的请求、限量读取响应体（ADR 0020）。

import { isIP } from "node:net";

/** 联网工具的失败：retry 表示换一把密钥 / 再试可能成功（搜索用），message 直接给模型与用户看 */
export class WebError extends Error {
  constructor(
    message: string,
    readonly retry = false,
    /** 按 HTTP 状态分类时的状态码 */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** 超时与用户停止合并成一个信号；返回清理函数 */
export function linkedSignal(
  user: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const ctl = new AbortController();
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    ctl.abort();
  }, ms);
  timer.unref?.();
  const onAbort = () => ctl.abort();
  if (user?.aborted) ctl.abort();
  else user?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ctl.signal,
    timedOut: () => timeout,
    done: () => {
      clearTimeout(timer);
      user?.removeEventListener("abort", onAbort);
    },
  };
}

/** 边读边累计字节，超过 limit 时按 `truncate` 截断或报错（不先把整个响应缓冲进内存） */
export async function readLimited(
  res: Response,
  limit: number,
  onTooLarge: "truncate" | "error",
  tooLargeMessage = "响应内容过大",
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength <= limit) return { bytes: buf, truncated: false };
    if (onTooLarge === "error") throw new WebError(tooLargeMessage);
    return { bytes: buf.slice(0, limit), truncated: true };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      await reader.cancel().catch(() => undefined);
      if (onTooLarge === "error") throw new WebError(tooLargeMessage);
      chunks.push(value.slice(0, limit - total));
      total = limit;
      truncated = true;
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return { bytes: out, truncated };
}

/** IPv4 是否是本机、内网、链路本地、保留等不该从网页读取工具访问的地址 */
function privateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  const [a = 0, b = 0] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** IP 地址（v4 / v6）是否是本机或内网地址 */
export function isPrivateAddress(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const kind = isIP(host);
  if (kind === 4) return privateV4(host);
  if (kind !== 6) return false;
  if (host === "::" || host === "::1") return true;
  // IPv4 映射 / 兼容地址：按其中的 IPv4 判断
  const mapped = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
  if (mapped) return privateV4(mapped);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hex) {
    const hi = Number.parseInt(hex[1] ?? "0", 16);
    const lo = Number.parseInt(hex[2] ?? "0", 16);
    return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = Number.parseInt(host.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 唯一本地
    (first & 0xffc0) === 0xfe80 || // fe80::/10 链路本地
    (first & 0xff00) === 0xff00 // ff00::/8 组播
  );
}

/** 本机主机名（不经 DNS 也能判断） */
const LOCAL_HOST =
  /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$|\.(localhost|local|internal|home\.arpa)$/i;

/**
 * 检查网页读取的地址：只允许 http / https、不带用户名密码、不指向本机或内网（含解析后的地址）。
 * 域名解析不到地址时直接拒绝（无法确认目标不在内网）。解析受 `signal` 控制：取消或超时后不再等待。
 * 返回规范化后的 URL。
 */
export async function checkPublicUrl(
  raw: string,
  lookup: (host: string) => Promise<string[]>,
  signal?: AbortSignal,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebError(`不是有效的网址：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new WebError(`只支持 http / https 网址：${raw}`);
  if (url.username || url.password) throw new WebError("网址里不能带用户名或密码");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || LOCAL_HOST.test(host) || isPrivateAddress(host))
    throw new WebError("不能读取本机或内网地址；本机文件请用 read，本机服务请用命令行");
  if (isIP(host) === 0) {
    let addrs: string[] = [];
    try {
      addrs = await untilAborted(lookup(host), signal);
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    if (addrs.length === 0) throw new WebError(`无法解析这个域名：${host}`);
    if (addrs.some(isPrivateAddress))
      throw new WebError("不能读取本机或内网地址；本机文件请用 read，本机服务请用命令行");
  }
  url.hash = "";
  return url;
}

/** 从 URL 取域名（`www.example.com`）；无效时返回空串 */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** 等待 `p`，`signal` 中止时立即以中止原因拒绝（迟到的结果被忽略） */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
