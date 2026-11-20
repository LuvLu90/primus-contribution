# agent-core 补丁清单（PATCHES.md）

`agent-core/` 是上游 earendil-works/pi monorepo 的源码副本（git subtree 方式引入，本仓库不保留 subtree 历史）。
按仓库 AGENTS.md 第 2.3 节，这里只允许三类改动：**品牌**、**两协议裁剪**、**构建入口**（经用户明确决定的功能补丁例外见 AGENTS.md 第 2.3 节与本文第四节）。本文件逐项登记每一处改动：改了什么、为什么、涉及哪些文件。路径均相对 `agent-core/`。

| 项目 | 值 |
|---|---|
| 上游版本 | **1.5.2**（tag `v1.5.2`，提交 `b4afdddf4`） |
| 上一版本 | 1.4.0（tag `v1.4.0`） |
| 内置模型目录 | `nix/model-catalog.json` 锁定的修订版（构建时由 `scripts/build-core.mjs` 下载、校验后用 `hydrate-model-catalog.ts` 离线生成） |

核对方法：用上游 tag 的纯净树与本目录做 `git diff --no-index`（排除 `node_modules/`、`dist/`、`packages/ai/src/providers/data/`、`.artifacts/`），差异应与本文件一一对应。

---

## 一、品牌

目的：Core 以“乾元（Primus）”身份运行；配置目录、环境变量、进程名、User-Agent 与系统提示不出现上游名称；不向上游服务回报、更新或上传任何东西（桌面端统一管理 Core 版本与诊断）。

### 1.1 名称与目录
- `packages/coding-agent/package.json`：`piConfig` 设为 `{ "name": "primus", "configDir": ".primus" }`。由此 `APP_NAME = "primus"`，派生的环境变量为 `PRIMUS_CODING_AGENT_DIR`、`PRIMUS_CODING_AGENT_SESSION_DIR`，项目级配置目录为 `.primus/`。
- `packages/coding-agent/src/config.ts`：`APP_NAME` / `CONFIG_DIR_NAME` 的兜底值改为 `primus` / `.primus`，`APP_TITLE` 恒等于 `APP_NAME`（缺失 package.json 时也不回退到上游名称）；`PI_PACKAGE_DIR`、`PI_SHARE_VIEWER_URL`、`PI_SELF_UPDATE_COMMAND` 改读 `PRIMUS_*`。
- `packages/coding-agent/src/cli/setup.ts`、`src/rpc-entry.ts`：`PI_CODING_AGENT` → `PRIMUS_CODING_AGENT`，`AI_AGENT` 取 `APP_NAME`。
- `packages/ai/src/utils/identity.ts`：User-Agent 产品标记 `pi` → `primus`。

### 1.2 环境变量前缀 `PI_*` → `PRIMUS_*`
运行时读取的环境变量统一改为 `PRIMUS_` 前缀（含注释、帮助文本）：

| 变量（去掉前缀） | 文件 |
|---|---|
| `CACHE_RETENTION` | `packages/ai/src/api/anthropic-messages.ts`、`packages/ai/src/api/openai-responses.ts`、`packages/ai/src/cache-warming.ts`（1.5.2 新文件） |
| `OAUTH_CALLBACK_HOST` | `packages/ai/src/auth/oauth/anthropic.ts`、`packages/ai/src/auth/oauth/openai-chatgpt.ts` |
| `OFFLINE`、`SKIP_VERSION_CHECK`、`STARTUP_BENCHMARK` | `packages/coding-agent/src/main.ts`、`src/core/package-manager.ts`、`src/core/model-runtime.ts`、`src/utils/tools-manager.ts`、`src/modes/interactive/interactive-mode.ts`、`src/modes/interactive/bug-report.ts`、`vitest.config.ts` |
| `PACKAGE_DIR`、`TELEMETRY`、`SHARE_VIEWER_URL`、`SELF_UPDATE_COMMAND` | `packages/coding-agent/src/config.ts`、`src/cli/args.ts`、`src/core/telemetry.ts`、`src/core/settings-schema.ts`、`src/package-manager-cli.ts` |
| `MANAGED_INSTALL_ROOT`、`INSTALLER_API_BASE` | `packages/coding-agent/src/package-manager-cli.ts` |
| `EXPERIMENTAL` | `packages/coding-agent/src/core/experimental.ts`、`src/cli/startup-ui.ts`（注释） |
| `TIMING` | `packages/coding-agent/src/core/timings.ts` |
| `CLEAR_ON_SHRINK`、`HARDWARE_CURSOR` | `packages/coding-agent/src/core/settings-manager.ts` |
| `RADIUS_GATEWAY` | `packages/coding-agent/src/core/radius.ts` |
| `SESSION_ID`、`SESSION_FILE`、`PROVIDER`、`MODEL`、`REASONING_LEVEL` | `packages/coding-agent/src/core/tools/bash.ts`（bash 工具注入的会话变量）、`src/core/tools/powershell.ts`（提示文本） |
| `CODEMODE_MAX_WORKERS` | `packages/coding-agent/src/extensions/codemode/execute.ts` |
| `CLIPBOARD_OSC52` | `packages/coding-agent/src/utils/clipboard.ts` |
| `HYPERLINKS`、`IMAGE_PROTOCOL`、`TRUE_COLOR` | `packages/tui/src/terminal-image.ts` |
| `TUI_ESC_TIMEOUT`、`TUI_WRITE_LOG`、`PROGRAM_STATUS` | `packages/tui/src/terminal.ts` |
| `TUI_DEBUG`、`TUI_DEBUG_REDRAW` | `packages/tui/src/tui-main-screen.ts` |
| `CODING_AGENT_DIR`、`OFFLINE`、`TELEMETRY`、`TIMING`、`STARTUP_BENCHMARK`、`NO_LOCAL_LLM` | `scripts/coding-agent-smoke.mjs`、`scripts/profile-coding-agent-node.mjs`、`scripts/smoke-test-codemode-binary.mjs`、`test.sh` |

- `packages/coding-agent/src/core/bug-report.ts`：诊断包收集的环境变量名前缀改为 `PRIMUS_`。
- 未改：开发/发布工具（`packages/evals`、发布脚本）里的 `PI_*`，以及代码内部的常量标识符（`PI_ATTRIBUTION`、`PI_AI_VERSION`、`PI_BUNDLED_NODE` 等），它们不是用户可见的环境变量。

### 1.3 系统提示
- `packages/coding-agent/src/core/system-prompt.ts`：默认前言改为乾元（Primus）身份（亦称“小元”，通用助手）；删除上游“文档与示例”段（文档、示例不随产品分发），同时去掉 `getDocsPath/getExamplesPath/getReadmePath` 导入。
- `packages/coding-agent/src/core/tools/bash.ts`、`src/core/tools/powershell.ts`：工具提示里的 `PI_*` 改为 `PRIMUS_*`。

### 1.4 不联系上游服务
- `packages/coding-agent/src/core/client-identity.ts`：不发送上游归属（attribution）请求头，`attribution: null`。
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`：`reportInstallTelemetry` 置空（不向上游上报安装）；去掉随之不再使用的导入。
- `packages/coding-agent/src/utils/version-check.ts`：`getLatestPiRelease` 恒返回 `undefined`（不请求上游版本接口）。
- `packages/coding-agent/src/package-manager-cli.ts`：**自更新禁用**——`getSelfUpdatePlan` 直接抛错（Core 随桌面端一起更新，1.5.2 新增的 `selfUpdateCommand` 设置与 `PRIMUS_SELF_UPDATE_COMMAND` 也因此不会执行）；托管安装器下载 `fetchInstallerArtifact` 抛错；删除迁移到上游安装脚本的提示；`update` 帮助文本注明自更新已禁用；`update primus` 视同 `update self`。
- `packages/coding-agent/src/cli/args.ts`：帮助文本同步（`update [source|self]`，去掉 `PI_SELF_UPDATE_COMMAND`、`PI_SHARE_VIEWER_URL` 行）。
- `packages/coding-agent/src/core/bug-report-upload.ts`：缺陷报告上传禁用（抛错）。
- `packages/coding-agent/src/modes/interactive/session-share.ts`：`/share` 会话分享禁用（不上传到上游分享服务或 gist）；`src/core/slash-commands.ts` 中 `/share` 的说明改为“disabled in this build”。

---

## 二、两协议裁剪

目的：硬约束 C1——模型端点的 `api` 只允许 `anthropic-messages` 与 `openai-responses`，内置供应商只保留 `anthropic` 与 `openai`；不引入 Google、AWS Bedrock、Mistral 等其他供应商 SDK。

### 2.1 删除的文件（按目录归类）
- `packages/ai/src/api/`：除 `anthropic-messages*`、`openai-responses*` 及其共享文件（`lazy.ts`、`transform-messages.ts`、`simple-options.ts`、`openai-prompt-cache.ts`、`constrained-sampling.ts`、`strict-tool-limits.ts`、`github-copilot-headers.ts`）外的全部协议适配器——azure-openai-*、bedrock-converse-stream*、cloudflare*、google-*、llama-cpp-classify*、mistral-conversations*、openai-codex-responses*、openai-completions*、openai-decisions*、openrouter-images*、pi-messages*、typesafe-system-one*、classifier-shared、system-one-shared。
- `packages/ai/src/providers/`：除 `anthropic.*`、`openai.*`、`all.ts`、`faux.ts`、`compat-schema.ts`、`model-schema.ts`、`schema-builders.ts`、`radius-config.ts`、`data-json.d.ts` 外的全部供应商定义及其 `*.models.ts`（含 1.5.2 新增的 `qwen-token-plan-individual-cn.*`）、`cloudflare-*`、`opencode-headers.ts`、`openrouter-api.ts`、`images/register-builtins.ts`。
- `packages/ai/src/auth/oauth/`：device-code、github-copilot、kimi-coding、meta、openai-codex、openrouter、radius、xai。
- `packages/ai/src/bedrock-provider.ts`、`packages/ai/src/lazy-bedrock-provider.ts`（1.5.2 新增）。
- `packages/ai/catalog/`（1.5.2 新增的目录生成器，取代 `scripts/generate-models.ts`）：除 `anthropic.ts`、`openai.ts`、`index.ts` 外的全部 `providers/*.ts`；`families/deepseek.ts`、`families/google.ts`、`families/kimi.ts`；`sources/openrouter.ts`、`sources/vercel-ai-gateway.ts`。
- `packages/coding-agent/src/extensions/llama/`（llama.cpp 本地模型扩展，走 openai-completions 协议）。
- 上游的 `packages/ai/scripts/generate-models.ts` 在 1.5.2 已移入 `catalog/`，本副本同样不再保留。

### 2.2 修改的文件
- `packages/ai/src/types.ts`：`KnownApi` 只保留两协议；`KnownImageApi`、`KnownClassifierApi` 为 `never`；`KnownProvider` 只保留 `anthropic | openai`；`ApiOptionsMap` 与 `Model.compat` 条件类型同步收窄。
- `packages/ai/src/compat.ts`、`src/index.ts`、`src/legacy-api-aliases.ts`、`src/images.ts`：去掉已删协议/图像注册的导出与注册；`BUILTIN_APIS` 只注册两协议；去掉 Cloudflare 专用分支。
- `packages/ai/src/providers/all.ts`：`builtinProviders()` 只返回 anthropic、openai。
- `packages/ai/src/providers/openai.ts`：去掉 OpenAI Decisions 分类器模型与 API。
- `packages/ai/src/models.generated.ts`：只聚合 anthropic、openai 两个分片（文件头按 1.5.2 改为 `catalog/generate.ts` 生成）。
- `packages/ai/src/auth/oauth/load.ts`、`src/bun-oauth.ts`、`src/lazy-oauth.ts`（1.5.2 新增）：OAuth 流程只保留 anthropic 与 openaiChatGPT。
- `packages/ai/package.json`：删除依赖 `@aws-sdk/client-bedrock-runtime`、`@google/genai`、`@smithy/node-http-handler`；删除导出 `./bedrock-provider`（1.4.0）/ `./lazy-bedrock-provider`（1.5.2）与 sideEffects 中的 `providers/images/register-builtins.js`；关键字去掉 gemini、bedrock。
- `packages/ai/scripts/hydrate-model-catalog.ts`：只接收 `openai-responses` / `anthropic-messages` 条目（锁定目录里 openai 的 `openai-decisions` 分类器等被丢弃），某供应商过滤后为空则报错。
- `packages/ai/catalog/providers/index.ts`：`PROVIDERS` 只含 anthropic、openai。`catalog/providers/openai.ts`：不生成 Decisions 分类器模型。`catalog/build.ts`：去掉 DeepSeek（openai-completions）家族规则。`catalog/sources/index.ts`：只抓取 models.dev（不再抓 OpenRouter、Vercel AI Gateway、NVIDIA、Radius）。
- `packages/coding-agent/src/core/model-resolver.ts`：`defaultModelPerProvider` 只保留 anthropic、openai（默认模型取上游 1.5.2 的值：`claude-opus-5-5`、`gpt-6.1-sol`）。
- `packages/coding-agent/src/core/model-runtime.ts`：内置供应商直接用构建时的目录（不包远程目录 / OpenRouter 个性化目录）；不再按配置生成 Radius 网关供应商。
- `packages/coding-agent/src/bun/runtime-setup.ts`：去掉 Bedrock 模块注册。
- `packages/coding-agent/src/extensions/index.ts`：去掉内置 llama.cpp 扩展。
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`：登录后选默认模型时去掉 Radius 特例。
- `package-lock.json`：随上述依赖删除同步裁剪（`npm install --package-lock-only`，不改动其余包的版本）。

说明：交互式 TUI 里与 Radius 相关的界面代码（`src/core/radius.ts`、`radius-mcp.ts`、`preferred-providers.ts`、`components/provider-brand.ts`、`radius-login-selector.ts` 等）原样保留——没有 Radius 供应商时这些分支不会触发，且 RPC 模式不经过它们。

---

## 三、构建入口

- `scripts/build-coding-agent-bundle.mjs`：去掉 Bedrock 懒加载入口与相关断言，懒加载产物的输出目录改以 OAuth 加载器（`auth/oauth/load.js`）为锚点；懒加载入口只保留 anthropic、openai-chatgpt、image-resize-worker。
- `packages/coding-agent/src/rpc-entry.ts`：上游自带的 RPC 入口，只做了 1.1 节的品牌改动；桌面端经 `scripts/build-core.mjs` 生成的根目录转发入口启动它。
- `package.json`（根）：工作区去掉 1.5.2 新增的 `packages/chord/test/examples/61-tutorial`（测试目录不随附，见附录）。

---

## 四、功能补丁（经用户决定的例外）

以下改动不属于上面三类，是用户明确要求、且无法放进第一方扩展（Core 内置 MCP 扩展的配置读取没有扩展钩子）的功能补丁，按 AGENTS.md 第 2.3 节的例外条款登记。升级上游时需要重放。

### 4.1 MCP 配置也从 `.agents/mcp.json` 读取（ADR 0022，2026-11-19）
- `packages/coding-agent/src/extensions/mcp/config.ts`：
  - 全局级读 `<agentDir>/mcp.json` 与 `~/.agents/mcp.json`（同级，都允许 `auth`），已信任项目读 `<cwd>/.primus/mcp.json` 与 `<cwd>/.agents/mcp.json`（同级，不允许 `auth`，不往上级找；工作区就是主目录时 `.agents/mcp.json` 只按全局级读）。`loadMcpConfig` 新增可选 `homeDir`（默认 `HOME`，没有时取 `os.homedir()`，与 `package-manager.ts` 的 `getHomeDir` 一致）。
  - 同级同名（含只差 `-` / `_`）、同级两处覆盖同一服务器、`autoEnableCodemode` 不一致时报 `errors`，取 `.primus` / agentDir 一侧；项目级仍覆盖全局级。
  - 全局 agentDir 的 `mcp.json` 可以写只含 `enabled` / `exposure` / `toolExposure` 的覆盖项，覆盖 `~/.agents/mcp.json` 的服务器；`.primus/mcp.json` 的覆盖项也可作用于同级 `.agents/mcp.json` 的服务器。
  - `McpServerEntry.overrideTarget`、`getMcpConfigWriteTarget`：`.agents` 来源的服务器写成覆盖项；`AGENTS_DIR_NAME`、`getAgentsMcpConfigPath`、`isAgentsMcpConfig`、`getMcpHomeDir`、`definesMcpServer` 辅助函数；`editMcpServers` 拒绝写 `.agents/mcp.json`。
  - 头注释更正（原注释写的是上游的项目目录名）。
- `packages/coding-agent/src/extensions/mcp/index.ts`：`/mcp` 的保存经 `getMcpConfigWriteTarget`（`.agents` 来源写 `overrideTarget`）；来源显示区分全局 / 项目覆盖项；“在本项目中启用 / 停用”对有全局覆盖项的服务器也提供；空列表提示里的目录名改用 `CONFIG_DIR_NAME`。
- `packages/coding-agent/src/extensions/mcp/cli.ts`：帮助文本列出 `.agents/mcp.json`；`McpCommandOptions.homeDir`；未信任提示同时列出被忽略的 `.agents/mcp.json`；`add` 在同级 `.agents` 有同名时提示；`remove` 对只在 `.agents` 里的服务器给出“不编辑该文件、请到原处删除或用 /mcp 停用”的提示，删掉覆盖项后 `.agents` 仍有定义时也提示；`list` 的覆盖项行改为 `override:`；空列表提示里的目录名改用 `CONFIG_DIR_NAME`。
- `packages/coding-agent/src/core/radius-mcp.ts`：任一全局服务器已用同一登录指向 Radius 时不再提议；只复用 `<agentDir>/mcp.json` 里的 Radius 服务器（不改写 `~/.agents` 的），新条目避开所有全局服务器的名字。
- 测试在仓库根 `scripts/core-mcp-config.test.ts`（本副本不随附测试，见附录）；根 `vitest.config.mts` 的 node 项目沿用本目录 `vitest.base.ts` 的包映射，把 Core 的工作区包指到源码。

---

## 附：不随附的非运行时文件

以下文件与 Core 运行无关，不随本副本分发（删除不改变任何运行时行为）：
- 全部测试：各包 `test/` 目录、`packages/durable/test-workers/`、`scripts/*.test.*`。
- 全部 Markdown 文档：各包 `README.md`、`CHANGELOG.md`、`docs/`（含图片与 HTML）、示例目录中的 `.md`、仓库根的 AGENTS/CONTRIBUTING/README/SECURITY。例外：`packages/coding-agent/README.md`、`CHANGELOG.md` 与 `docs/docs.json` 保留（`config.ts` 按包目录定位 README/CHANGELOG，打包脚本也会复制它们）。
- `.pi/prompts/`、`.pi/skills/`（上游仓库自用的提示与技能）。
- `apps/`（1.5.2 新增的独立应用 p2/p3 及其文档，依赖 discord.js、React UI 包与 Radius 插件，不属于 Core），以及只为它服务的 `.github/workflows/p2-cloud-bundle.yml`。
- `scripts/issues/`（上游 issue 分拣工具；1.5.2 已删除）。

---

## 升级记录

### 1.4.0 → 1.5.2
- 方法：在 1.4.0 上把全部 Primus 改动做成一个提交，cherry-pick 到 `v1.5.2`，逐个解决冲突，保留上游 1.5.2 逻辑并重放上述三类改动。
- 新增登记：`packages/ai/src/cache-warming.ts`（`PRIMUS_CACHE_RETENTION`，从 `coding-agent/src/core/cache-warmer.ts` 移来）；`PRIMUS_SELF_UPDATE_COMMAND` 与 `settings-schema.ts` 文案；`package-manager-cli.ts` 中 `PRIMUS_PACKAGE_DIR`；`lazy-oauth.ts` 裁剪；`lazy-bedrock-provider.ts` 与 `qwen-token-plan-individual-cn.*` 删除；`packages/ai/catalog/` 裁剪；根 `package.json` 去掉 chord 教程工作区；删除 `apps/`。
- 新增包 `packages/schema`（`@earendil-works/pi-schema`，pi-ai 的新依赖）原样保留，仅删除其测试与 Markdown。
