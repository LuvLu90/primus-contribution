# ADR 0015：Core 跟随 Windows 系统代理，语音转文字直连

- 状态：已采纳（2026-11-16）
- 修订：ADR 0013 中“语音转文字跟随系统代理”的做法

## 背景

- Core 的模型请求由内置 Node 进程发出（undici `EnvHttpProxyAgent`），只认 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 环境变量，不读 Windows 的“代理服务器”设置。用户开着系统代理（如本机代理客户端）时，浏览器能访问模型渠道，乾元的对话却直连失败（例如网络对明文 SNI 做了重置）。
- 语音转文字（`primus-asr`）原来跟随系统代理；百炼北京地域经代理（常见为境外出口）时无法正常使用。

## 决定

- 薄壳每次拉起 Core 时读一次当前用户的系统代理（`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`：`ProxyEnable`、`ProxyServer`、`ProxyOverride`），实现在 `platform/proxy.rs`：
  - 开着且 HTTPS 有代理：设置 `HTTPS_PROXY`、`HTTP_PROXY`（`host:port` 补成 `http://host:port`；`http=` / `https=` 分协议配置时各取各的；条目以 `;` 或空白分隔）与 `NO_PROXY`。
  - 关着、只有 `socks=`、或只配了 `http=`：不设置，Core 直连。只配 `http=` 时 WinINet 的 HTTPS 直连，而 undici 没有 `HTTPS_PROXY` 时会让 HTTPS 回退到 `HTTP_PROXY`，表达不了；模型请求都是 HTTPS，以 HTTPS 与系统一致为准。
  - `NO_PROXY` 由 `ProxyOverride` 转换：`<local>` → `localhost`（`NO_PROXY` 表达不了“所有不含点的主机名”，内网短名需在系统例外里逐个写出），`*.example.com` → `.example.com`，单独的 `*` → `*`（全部直连），`10.*` 这类中间带通配符的条目无法表达，跳过；回环地址（`localhost`、`127.0.0.1`、`::1`）总在列表里；用户环境已有的 `NO_PROXY` 合并保留。
  - 用户环境里已设置 `HTTP_PROXY` / `HTTPS_PROXY` 时原样保留，不被系统代理覆盖。
  - 自动配置脚本（PAC）与“自动检测设置”不支持。系统代理在运行中切换，对之后新拉起的 Core 生效。
- 语音转文字一律直连：reqwest 客户端 `no_proxy()`（不开 `system-proxy` 特性），WebSocket 直接 TCP 连接，去掉 hyper-util 的系统代理识别与 CONNECT 隧道。
- 薄壳自身的模型列表获取与自动更新不变，仍由 reqwest 跟随系统代理。

## 影响

- 不改 `agent-core/`：只通过 Core 已支持的环境变量生效。
- `primus-asr` 去掉 hyper-util 直接依赖（仍在 reqwest 依赖树中）。
- Core 里运行的工具子进程（git、pip 等）继承同一组代理变量。
