// web_fetch 的传输（ADR 0020）：用 node:http / node:https 发请求，连接的地址就是检查过的地址（防 DNS 重绑定）。
// `checkPublicUrl` 的预检查与实际连接是两次独立的 DNS 解析，只做预检查挡不住 DNS 重绑定。
// - 直连：在建立连接时用 `guardedLookup` 解析并检查，解析到本机或内网地址就拒绝这次连接。
// - 走代理（与 Core 一样认 HTTP(S)_PROXY / NO_PROXY）：本地解析并检查后，用 CONNECT 让代理连到这个 IP，
//   再在隧道里按原域名做 TLS（SNI 与证书校验用域名），代理不再自己解析域名。只支持 http:// 代理。

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction, type Socket } from "node:net";
import { pipeline, Readable } from "node:stream";
import * as tls from "node:tls";
import * as zlib from "node:zlib";
import { isPrivateAddress, PRIVATE_ADDRESS_MESSAGE, WebError } from "./net.ts";

type Env = Record<string, string | undefined>;

const envOf = (env: Env, name: string): string =>
  (env[name] ?? env[name.toLowerCase()] ?? "").trim();

/** 主机是否命中 NO_PROXY（逗号或空白分隔；`*` 全部；`example.com` / `.example.com` 含子域名；可带端口） */
export function bypassProxy(host: string, port: string, env: Env): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  for (const raw of envOf(env, "NO_PROXY").split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const m = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(entry.replace(/^\*?\./, ""));
    const name = m?.[1] ?? m?.[2];
    if (!name || (m?.[3] && m[3] !== port)) continue;
    if (h === name || h.endsWith(`.${name}`)) return true;
  }
  return false;
}

/** 这个网址要用的代理（与 undici EnvHttpProxyAgent 一致：https 先认 HTTPS_PROXY，再退回 HTTP_PROXY）；不用代理时返回 undefined */
export function proxyFor(url: URL, env: Env): URL | undefined {
  const raw =
    url.protocol === "https:"
      ? envOf(env, "HTTPS_PROXY") || envOf(env, "HTTP_PROXY")
      : envOf(env, "HTTP_PROXY");
  if (!raw) return undefined;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (bypassProxy(url.hostname, port, env)) return undefined;
  let proxy: URL;
  try {
    proxy = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    throw new WebError("代理设置无效，无法读取网页");
  }
  if (proxy.protocol !== "http:") throw new WebError("只支持 http:// 代理，无法读取网页");
  if (proxy.username || proxy.password) {
    try {
      decodeURIComponent(proxy.username);
      decodeURIComponent(proxy.password);
    } catch {
      throw new WebError("代理设置无效，无法读取网页");
    }
  }
  return proxy;
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

/** 解析并检查一个主机，返回要连接的 IP（IP 字面量直接检查） */
function resolveChecked(host: string, blocked: (ip: string) => boolean): Promise<string> {
  const h = host.replace(/^\[|\]$/g, "");
  if (isIP(h)) {
    return blocked(h) ? Promise.reject(new WebError(PRIVATE_ADDRESS_MESSAGE)) : Promise.resolve(h);
  }
  return new Promise((resolve, reject) => {
    guardedLookup(blocked)(h, { all: false }, (err, address) => {
      if (err) reject(err);
      else resolve(address as string);
    });
  });
}

/** 经 http 代理建隧道到已检查的 IP；https 在隧道里按原域名做 TLS */
function tunnel(
  target: URL,
  proxy: URL,
  blocked: (ip: string) => boolean,
  signal: AbortSignal | undefined,
): (opts: unknown, done: (err: Error | null, socket?: Socket) => void) => undefined {
  return (_opts, done) => {
    let settled = false;
    const finish = (err: Error | null, socket?: Socket) => {
      if (settled) return;
      settled = true;
      done(err, socket);
    };
    const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));
    const secure = target.protocol === "https:";
    const port = target.port || (secure ? "443" : "80");
    resolveChecked(target.hostname, blocked)
      .then((ip) => {
        const authority = `${isIP(ip) === 6 ? `[${ip}]` : ip}:${port}`;
        const headers: Record<string, string> = { Host: authority };
        if (proxy.username || proxy.password) {
          let cred: string;
          try {
            cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
          } catch {
            finish(new WebError("代理设置无效，无法读取网页"));
            return;
          }
          headers["Proxy-Authorization"] = `Basic ${Buffer.from(cred).toString("base64")}`;
        }
        const req = http.request({
          host: proxy.hostname.replace(/^\[|\]$/g, ""),
          port: proxy.port || "80",
          method: "CONNECT",
          path: authority,
          headers,
          signal,
        });
        req.once("connect", (res, socket) => {
          if (res.statusCode !== 200) {
            socket.destroy();
            finish(new WebError(`代理拒绝了连接（HTTP ${res.statusCode}）`));
            return;
          }
          if (!secure) {
            finish(null, socket);
            return;
          }
          const host = target.hostname.replace(/^\[|\]$/g, "");
          try {
            const secured = tls.connect({
              socket,
              ...(isIP(host) ? {} : { servername: host }),
              host,
              ALPNProtocols: ["http/1.1"],
            });
            finish(null, secured);
          } catch (e) {
            socket.destroy();
            finish(asError(e));
          }
        });
        req.once("error", (e) => finish(e));
        req.end();
      })
      .catch((e: unknown) => finish(asError(e)));
    return undefined;
  };
}

/** 按 Content-Encoding 解压；不认识的编码原样返回。任何一段关闭或出错，整条流（含未读完的响应）一起销毁 */
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
  pipeline(res, z, () => undefined);
  return z;
}

/**
 * 与 `fetch` 同形的请求（只用到 web_fetch 需要的部分：method、headers、signal，不跟随跳转）。
 * `blocked` 与 `env` 供测试替换。
 */
export function createDirectFetch(
  blocked: (ip: string) => boolean = isPrivateAddress,
  env: Env = process.env,
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
      let proxy: URL | undefined;
      try {
        proxy = proxyFor(url, env);
      } catch (e) {
        reject(e);
        return;
      }
      const options: https.RequestOptions = proxy
        ? {
            method,
            headers,
            signal,
            createConnection: tunnel(url, proxy, blocked, signal) as never,
          }
        : { method, headers, signal, lookup };
      const req = mod.request(url, options, (res) => {
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

/** web_fetch 默认用的请求 */
export function pageFetch(): typeof fetch {
  return createDirectFetch();
}
