# ADR 0022：MCP 配置也从 `.agents/mcp.json` 读取

- 状态：已采纳（2026-11-19）

## 背景

技能已经同时读取 Core 自己的目录与各工具共用的 `.agents/skills`（ADR 0016）。MCP 配置此前只有两处：用户级 `<agentDir>/mcp.json`（开发模式下即 `.dev-data/…/core/mcp.json`，命令行版是 `~/.primus/agent/mcp.json`）与已信任项目的 `<cwd>/.primus/mcp.json`。用户在别的 Agent 工具里写好的 `~/.agents/mcp.json`、仓库里约定的 `<cwd>/.agents/mcp.json` 需要复制一份才能在乾元里用，两边还会各自漂移。

`.agents/` 是与其他工具共用的目录，乾元不应改写它：别的工具可能同时读写，也可能是用户手工维护、纳入版本控制的文件。

## 决定

### 读取位置与级别

| 级别 | 文件（同级，先读的在前） | 条件 |
|---|---|---|
| 全局（global） | `<agentDir>/mcp.json`、`~/.agents/mcp.json` | 总是读取 |
| 项目（project） | `<cwd>/.primus/mcp.json`、`<cwd>/.agents/mcp.json` | 仅已信任的项目 |

- `~` 与 Core 的包管理器一致：`HOME`，没有时取系统主目录（Windows 为 `USERPROFILE`）。`loadMcpConfig` 接受 `homeDir` 以便测试注入。
- 项目级只读工作区本级的 `.agents/mcp.json`，不往上级目录找（不同于 `.agents/skills` 到 Git 仓库根为止的查找）。工作区就是主目录时，`.agents/mcp.json` 只按全局级读一次。
- `~/.agents/mcp.json` 与 `<agentDir>/mcp.json` 同为全局级，允许 `auth`（使用 `/login` 渠道的令牌）；项目级两处都不允许 `auth`，仓库不能决定把凭证发往哪里。
- 项目级照旧覆盖全局级的同名服务器。项目级文件里只含 `enabled` / `exposure` / `toolExposure` 的条目（覆盖项）可以覆盖全局级的同名服务器。

### 同级冲突

- 同级两个文件定义同名服务器（含只差 `-` 与 `_`、共用工具命名空间的名字）时，`errors` 里记一条 `<.agents 路径>: server "x" is also defined in <.primus 路径>, which is used`（名字不同时为 `conflicts with "y" in …`），保留 `.primus` / agentDir 那一条，跳过 `.agents` 的。
- 同级两处都写了同一服务器的覆盖项时同样报冲突（`is also overridden in …`），取 `.primus` 那一条。`.agents` 里的覆盖项不能覆盖同级 `.primus` 定义的服务器（报冲突）；反过来 `.primus` 的覆盖项可以覆盖同级 `.agents` 定义的服务器，这正是写入规则需要的（见下）。
- 同级两处都设置 `autoEnableCodemode` 且值不同：报冲突，取 `.primus` / agentDir 的值。项目级的值仍覆盖全局级。
- 实现上每一级先读两个文件的完整定义（`.primus` 在前，登记命名空间），再统一处理覆盖项，所以文件顺序不影响结果。

### 写入：乾元绝不写 `.agents/`

- 每个来自 `.agents/mcp.json` 的服务器带 `overrideTarget`：项目级指向 `<cwd>/.primus/mcp.json`，全局级指向 `<agentDir>/mcp.json`。`/mcp` 对它的启用、停用与切换暴露方式写成该文件里的覆盖项（`getMcpConfigWriteTarget`）；已经有覆盖项时写回那一条。
- 为此**全局 agentDir 的 `mcp.json` 也支持覆盖项**，但只能覆盖 `~/.agents/mcp.json` 的服务器（这是最小的扩展：全局级之下没有别的级别可覆盖；没有可覆盖对象时报 `needs "command" or "url", or a server in ~/.agents/mcp.json to override`）。`~/.agents/mcp.json` 里的覆盖项没有可覆盖的对象，同样报错。
- `/mcp` 菜单里“在本项目中启用 / 停用”对全局服务器（包括已有全局覆盖项的 `~/.agents` 服务器）照常提供，写进 `.primus/mcp.json`。来源显示为 `global, global override` / `global, project override`。
- `primus mcp add` / `remove` 仍只写 `<agentDir>/mcp.json` 或（`--local`）`.primus/mcp.json`：
  - `add` 的名字同级 `.agents/mcp.json` 里也有时，提示“`.agents` 里也定义了，以刚写入的为准，`.agents` 不改”。
  - `remove` 的服务器只在 `.agents/mcp.json` 里时报错并说明：乾元不编辑这个文件，请到那里删除，或用 `/mcp` 停用（写成覆盖项）。删掉的是覆盖项而 `.agents` 里仍有定义时也提示。
- `config.ts` 的写入入口（`updateMcpServerConfig` / `addMcpServerConfig` / `removeMcpServerConfig`）对 `.agents/mcp.json` 路径一律抛错，作为最后一道保护。
- Radius 登录后的“配置 Radius MCP”只复用 `<agentDir>/mcp.json` 里的服务器；`~/.agents/mcp.json` 里已有同一登录的 Radius 服务器时不再提议，已有但未用此登录的不改写它，新条目避开它的名字（同名会与它冲突）。

### 桌面端

- 信任确认（`workspace_inspect`）新增 `agentsMcpServers`：工作区本级 `.agents/mcp.json` 的服务器名，上限与 `.primus/mcp.json` 相同（1 MiB），过大或解析失败时显示文件名 `mcp.json`；`.agents` 是文件时视为没有。弹窗单列“.agents MCP 服务器”。
- `mcp_config_read` 返回值新增只读的 `agents: { path, text, error } | null`（`~/.agents/mcp.json`；读不出时 `error` 给原因，不影响用户级文件的编辑）。`mcp_config_write` 不变，薄壳从不写 `~/.agents/mcp.json`。
- 能力中心·MCP 在用户级列表下方只读展示“与其他工具共用的 MCP 服务器”：名称、传输方式、暴露方式、说明与测试结果，HTTP 服务器可登录 / 退出；没有编辑、删除，启停开关写成用户级 `mcp.json` 里的覆盖项：停用写 `enabled: false`；启用时若 `~/.agents/mcp.json` 里的定义本身是 `enabled: false` 就写 `enabled: true`，否则删掉 `enabled`（覆盖项变空时整条删除），保证开关的结果与 Core 合并后的状态一致。用户级列表不单独列出 Core 会套用的覆盖项（只含 `enabled` / `exposure` / `toolExposure`），含其他键、套用不了的照常列出并标出错误（此时共享服务器的开关报错，请先修正该覆盖项）；覆盖项的值不合法时与 Core 一样报错并按原定义显示；用户级文件已完整定义同名服务器时这一行标为冲突、不能启停。
- “+”菜单的 MCP 列表按同样规则合并同级两处：全局读用户级 `mcp.json` 与 `~/.agents/mcp.json`，项目读 `.primus/mcp.json` 与 `.agents/mcp.json`（由 `agentsMcpServers` 是否为空决定是否读取），套用主文件的覆盖项，冲突取主文件，项目级 `.agents` 里带 `auth` 的不列出。

### Agent Core 改动

本需求要改 Core 的 MCP 配置读取（`extensions/mcp/config.ts`、`cli.ts`、`index.ts`、`core/radius-mcp.ts`），不属于 AGENTS.md 第 2.3 节允许的三类改动，也无法放进第一方扩展（MCP 扩展是 Core 内置的，配置读取没有扩展钩子）。按用户决定作为功能补丁登记在 `agent-core/PATCHES.md` 第四节，升级上游时需重放；AGENTS.md 第 2.3 节同步写明这类经用户明确决定的例外。顺带把 `config.ts` 头注释与 `/mcp` 提示里残留的上游项目目录名改为 `.primus`。

## 后果

- 其他工具写的 MCP 配置无需复制即可使用；仓库可以只提交 `.agents/mcp.json` 供多种工具共用。
- 乾元对共用文件只读，界面与 `/mcp` 的改动都落在乾元自己的文件里，不会意外改动其他工具的配置；代价是同一服务器的状态可能分散在两个文件里（定义在 `.agents`，启停在 `.primus` / agentDir），`/mcp` 详情与 `primus mcp list` 会同时列出来源与覆盖项文件。
- 同级同名不再静默覆盖：用户能在 `/mcp` 与 `primus mcp list` 的配置错误里看到被跳过的条目。
- `primus-guard` 对 `.agents/mcp.json` 不做特殊处理，按其所在位置的通用规则判断（ADR 0016 的用户级 MCP 配置例外只认 `<agentDir>/mcp.json`）。
- 约束 C2 不受影响：读取主目录下的 `~/.agents/mcp.json` 不写任何数据，覆盖项只写进数据目录内的 `<agentDir>/mcp.json`。
- 未验证：Rust 单测（`workspaces.rs`、`mcp_config.rs` 新增用例）在当前开发环境无法编译运行，需在 CI / Windows 上跑 `cargo nextest`。
