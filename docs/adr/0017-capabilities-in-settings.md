# ADR 0017：能力中心并入设置，管理技能与用户级 MCP

- 状态：已采纳（2026-11-16）
- 修订：技术方案第 2.4 节（版本基线）、第 13.2、13.4 节、第 16 章（路由与界面清单）、第 18 章、附录 B

## 背景

- 原方案的能力中心是独立页面 `/capabilities/`，管理扩展、技能、提示模板与 MCP，并带技能编辑器。实际只做了占位页。
- 用户最常见的两件事是：把别人分享的技能（GitHub 仓库、zip、本地文件夹）装进来，和把其他客户端（Claude Desktop、VS Code）里的 MCP 配置搬过来。扩展、提示模板与技能编辑器的需求不急。
- Core 已经有完整的技能发现规则、`mcp.json` 校验与 `mcp list` / `login` / `logout` 命令行；不改 `agent-core/`，薄壳与前端只做文件管理与界面。
- 技术方案第 13.4 节写的 MCP 默认暴露方式“延迟加载”与 Core 不符：Core 默认是 `codemode`。

## 决定

### 入口

- 能力中心成为设置的一个分组：`/settings/?group=capabilities`，分“技能”“MCP”两个页签。左栏设置菜单的“能力中心”打开这里，旧地址 `/capabilities/` 跳转过来。
- 不做市场、不做在线搜索；扩展与提示模板的管理、技能编辑器暂不提供。

### 技能

- 发现规则与 Core 相同：薄壳 `skill_discovery.rs` 逐条移植 `agent-core/packages/coding-agent/src/core/package-manager.ts` 的 `collectSkillEntries` / `addIgnoreRules` / `prefixIgnorePattern`（`core/skills.ts` 的 `loadSkillsFromDirInternal` 同一套规则）：名字正是 `SKILL.md` 的文件所在目录即一个技能且不再往下找；跳过 `.` 开头的项与 `node_modules`；跟随链接；`skills/` 根目录下直接的 `*.md` 各是一个技能（`.agents/skills` 反过来只认子目录里的）；每进入一个目录读 `.gitignore`、`.ignore`、`.fdignore`，按 Core 的方式加前缀累积，匹配语义与 Core 用的 npm `ignore` 包（7.x，不区分大小写）一致（与该包做过 10 万例差分核对）。Core 的发现函数没有导出、也没有列出技能的命令行，薄壳与界面又只用 Core 的 RPC 与扩展 API（AGENTS.md 第 2.3 节），所以只能移植，不能直接调用。
- 列表：Core 用户目录 `skills/`（能力中心安装的位置，标“Primus”）与 `~/.agents/skills`（与其他工具共用，标“~/.agents”）。技能不是 `skills/` 的直接子项时标出所在的顶层文件夹（一次安装的仓库 / 压缩包 / 文件夹）。项目级技能（`.primus/skills`、`.agents/skills`）不在这里管理，仍由项目信任控制（ADR 0016）。
- 安装不加 Core 之外的限制：先把来源解到暂存目录 `<数据目录>/tmp/skill-stage/<编号>`（1 小时后清理），按 Core 加载 `skills/<目录名>/` 的方式列出其中的全部技能（Core 是否加载、告警、与已安装技能同名时 Core 只加载其中一个）；用户确认目录名后，整个来源移进 `skills/<目录名>`，其中有几个技能 Core 就加载几个，与用户自己把文件夹放进 `skills/` 相同。一个 Core 能加载的技能都没有时不能安装。同名目录已存在时返回 `exists`，用户确认后替换（旧目录先移走，新目录就位后再删）。
  - GitHub：分支 / 标签沿用 Core 安装 git 来源的写法（`agent-core/packages/coding-agent/src/utils/git.ts` 的 `parseGitUrl`，基于 hosted-git-info）：`https://github.com/<owner>/<repo>[.git]` 后接 `#<ref>` 或 `@<ref>`、`git:github.com/<owner>/<repo>[@<ref>]`、`git:git@github.com:<owner>/<repo>`，以及 `http(s)`、`ssh`、`git` 协议；另外接受网页上复制的 `tree/<ref>/<路径>`、`blob/<ref>/<路径>`（取所在目录）。与 hosted-git-info 一样 `tree/` 后的 ref 只取一段，含 `/` 的分支写成 `…/<repo>#feature/x`（这时装整个仓库）。Core 对 git 来源是 `git clone` 整个仓库，要求用户装有 Git、且不认 `tree/` 子目录，所以不调用它：从 `https://codeload.github.com/<owner>/<repo>/zip/<ref>`（缺省 `HEAD`）下载，只走 https，重定向只允许留在 `codeload.github.com`，120 秒超时。
  - zip：薄壳自带的读取器（基于已在依赖树中的 `flate2`），拒绝绝对路径、`..`、盘符、设备名等危险条目名，校验 CRC，跳过符号链接；压缩包最大 64 MiB、最多 5,000 个条目、单个文件 32 MiB、合计 256 MiB。
  - 本地文件夹：逐个复制，不跟随也不复制链接，跳过 `.git`，上限同 zip。
- frontmatter 按 Core 的做法解析：取法照搬 `agent-core/packages/coding-agent/src/utils/frontmatter.ts`，YAML 用 Core 同一个解析器（`yaml` 包，版本与 agent-core 锁定的一致，`pnpm check:versions` 核对）；校验照搬 `core/skills.ts` 的 `loadSkillFromFile`：缺少 `description` 或 YAML 无效的技能 Core 不加载，界面标出；名称与长度问题 Core 只告警，这里也只提示。
- 启停写 Core `settings.json` 的 `skills` 数组：停用加入 `-<技能文件绝对路径>`（与 Core 的精确排除一致），启用删掉指向它的精确排除；通配写法不改写。新会话生效。
- 删除只限 `skills/` 里的技能：删技能目录（单个 `*.md` 的技能删文件）；是链接 / 目录联接时只删链接本身；路径中间经过链接的不能删（会删到链接目标里）。删掉的是所在顶层文件夹里最后一个技能时，顶层文件夹一并删除。`~/.agents/skills` 的技能只能启停。

### MCP

- 只编辑用户级 `<Core 用户目录>/mcp.json`。薄壳 `mcp_config_read` 返回原文与版本（内容的 SHA-256），`mcp_config_write` 只在版本未变时原子替换（否则 `conflict`，界面重新读取后请用户再操作一次），且只检查是 1 MiB 以内、`mcpServers` 为对象的 JSON 对象。
- 条目的校验在前端，与 Core 一致：名字为字母、数字、`_`、`-`，只差 `-` 与 `_` 的名字冲突；stdio（`command` / `args` / `env` / `cwd`）或 Streamable HTTP（`url` / `headers` / `oauth`），拒绝 `sse`；`exposure` / `toolExposure` 取 `codemode` / `deferred` / `direct` / `hidden`；`auth` 要求 https 或回环地址。修改只动目标条目，其余内容与不认识的字段保留，按原文缩进重写。启用删掉 `enabled` 键，停用写 `enabled: false`；暴露方式为默认的 `codemode` 时不写。
- 添加：表单（类型、命令行或地址、环境变量 / 请求头、描述、暴露方式），或粘贴 JSON：Claude Desktop / Core 的 `{"mcpServers": …}`、VS Code 的 `{"servers": …}` 与 settings.json 的 `{"mcp": {"servers": …}}`（去掉 `type: stdio/http` 与 Core 不支持的字段；`env`、`headers`、`oauth.clientSecret` 里的 `${env:名称}` 换成 Core 的 `${名称}`，其他字段里的变量与 `${input:…}` 只提示）、单条 `{"名字": {…}}` 或不带名字的单个条目。同名的服务器被替换。编辑可用表单或直接改该条目的 JSON。
- `env`、`headers` 的值按 Core 的格式原样（明文）写入 `mcp.json`，与 Core 自己的 `mcp add` 一样。Core 连接时展开 `$名称` / `${名称}`（环境变量）与以 `!` 开头的命令（取输出），`$$`、`$!` 表示字面的 `$`、`!`（`core/resolve-config-value.ts`，用于 `env`、`headers` 与 `oauth.clientSecret`）；界面照此说明。
- 测试连接：薄壳以 `run_cli` 运行 Core 命令行 `mcp list --json`（60 秒），界面显示每个服务器的状态、工具数与错误，以及配置错误。
- OAuth：`mcp login --timeout 300 -- <名字>`，由 Core 打开系统浏览器并等待回调（薄壳最多等 330 秒）；`mcp logout -- <名字>`。令牌由 Core 写入 `mcp-auth.json`，界面不接触。
- `run_cli` 与会话进程使用同一套 Core 环境（`apply_core_env`：Core 用户目录、会话目录、临时目录、Python、系统代理等），放在独立的 Job Object 中，超时即结束整棵进程树，输出最多保留 4 MiB。

### 默认暴露方式

- 与 Core 一致，MCP 工具默认 `codemode`：工具只在 codemode 脚本中可用，模型的工具列表里只出现命名空间，脚本用 `searchTools()` 查找。技术方案第 13.4 节据此更正。

## 影响

- 新增 11 个薄壳命令（附录 B）：`skills_list`、`skill_stage`、`skill_install`、`skill_discard`、`skill_delete`、`skill_set_enabled`、`mcp_config_read`、`mcp_config_write`、`mcp_list`、`mcp_login`、`mcp_logout`。新增直接依赖 `flate2`（`rust_backend`，与依赖树中已有的版本一致）与前端依赖 `yaml`（与 agent-core 锁定的版本一致，跟随 Core 升级）。
- 不改 `agent-core/`；Core 原生的技能与 MCP 行为不变。
- 已知取舍：
  - 启停只认精确排除，用户手写的通配规则不改写，界面显示的启用状态只按精确规则判断。
  - `mcp.json` 的 `env` / `headers` 与 Core 一样明文保存；需要保密的值写成 `${环境变量}` 或 `!命令` 由 Core 在连接时取。
  - 整个来源装进一个文件夹：仓库里与技能无关的文件也一并装入（上限同 zip）；不想要的技能可以单独删除或停用。
  - 发现规则是移植而非调用：Core 升级改了发现规则时要同步 `skill_discovery.rs`（第 6.1 节的升级检查项）。
