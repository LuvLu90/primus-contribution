// web_fetch 的直连传输（ADR 0020）：用 node:http / node:https 发请求，在建立连接时检查域名解析出的地址，
// 解析到本机或内网地址的连接直接拒绝。`checkPublicUrl` 的预检查与实际连接用的是两次独立的 DNS 解析，
// 只做预检查挡不住 DNS 重绑定；这里让“检查的地址”就是“连接的地址”。
// 配了代理（HTTP(S)_PROXY / ALL_PROXY）时由代理解析与连接，改用 Core 的全局 fetch（随 Core 的代理设置）。

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import * as zlib from "node:zlib";
import { isPrivateAddress, PRIVATE_ADDRESS_MESSAGE, WebError } from "./net.ts";

const PROXY_VARS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];

/** 环境里是否配了代理 */
export function hasProxy(env: Record<string, string | undefined>): boolean {
  return PROXY_VARS.some((k) => (env[k] ?? "").trim() !== "");
}

/** 连接时用的 DNS 解析：任何一个地址落在 `blocked` 里就拒绝这次连接 */
export function guardedLookup(blocked: (ip: string) => boolean = isPrivateAddress): LookupFunction {
  return ((hostname, options, callback) => {
    dnsLookup(hostname, options, (err, address, family) => {
      if (err) return callback(err, address as string, family);
      const list = Array.isArray(address)
        ? (address as LookupAddress[]).map((a) => a.address)
        : [address as string];
      if (list.some(blocked))
        return callback(new WebError(PRIVATE_ADDRESS_MESSAGE), address as string, family);
      callback(null, address as string, family);
    });
  }) as LookupFunction;
}

/** 按 Content-Encoding 解压；不认识的编码原样返回 */
function decoded(res: http.IncomingMessage): Readable {
  const enc = String(res.headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  const z =
    enc === "gzip" || enc === "x-gzip"
      ? zlib.createGunzip()
      : enc === "deflate"
        ? zlib.createInflate()
        : enc === "br"
          ? zlib.createBrotliDecompress()
          : undefined;
  if (!z) return res;
  res.on("error", (e) => z.destroy(e));
  return res.pipe(z);
}

/**
 * 与 `fetch` 同形的直连请求（只用到 web_fetch 需要的部分：method、headers、signal，不跟随跳转）。
 * `blocked` 供测试替换。
 */
export function createDirectFetch(
  blocked: (ip: string) => boolean = isPrivateAddress,
): typeof fetch {
  const lookup = guardedLookup(blocked);
  return ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const mod = url.protocol === "https:" ? https : http;
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      "Accept-Encoding": "gzip, deflate, br",
    };
    const signal = init.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const req = mod.request(url, { method, headers, lookup, signal }, (res) => {
        const status = res.statusCode ?? 0;
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          if (Array.isArray(v)) for (const x of v) h.append(k, x);
          else h.set(k, String(v));
        }
        const noBody = status === 204 || status === 304 || method === "HEAD";
        let body: ReadableStream | null = null;
        if (noBody) res.resume();
        else {
          const stream = decoded(res);
          if (stream !== res) {
            h.delete("content-encoding");
            h.delete("content-length");
          }
          body = Readable.toWeb(stream) as ReadableStream;
        }
        try {
          resolve(new Response(body, { status, statusText: res.statusMessage ?? "", headers: h }));
        } catch (e) {
          res.destroy();
          reject(e);
        }
      });
      req.on("error", reject);
      req.end();
    });
  }) as typeof fetch;
}

/** web_fetch 默认用的请求：配了代理时走 Core 的全局 fetch，否则直连并在连接时检查地址 */
export function pageFetch(env: Record<string, string | undefined> = process.env): typeof fetch {
  const direct = createDirectFetch();
  return ((input: string | URL | Request, init?: RequestInit) =>
    hasProxy(env) ? fetch(input, init) : direct(input, init)) as typeof fetch;
}
