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

- 列表：Core 用户目录 `skills/`（能力中心安装的位置，标“Primus”）与 `~/.agents/skills`（与其他工具共用，标“~/.agents”），按 Core 的发现规则：含 `SKILL.md` 的目录即一个技能且不再往下找，跳过 `.` 开头的目录与 `node_modules`，跟随链接。项目级技能（`.primus/skills`、`.agents/skills`）不在这里管理，仍由项目信任控制（ADR 0016）。
- 安装分两步：先把来源解到暂存目录 `<数据目录>/tmp/skill-stage/<编号>`（1 小时后清理），列出其中的技能；用户选一个、确认目录名后整目录移进 `skills/<目录名>`。同名目录已存在时返回 `exists`，用户确认后替换（旧目录先移走，新目录就位后再删）。
  - GitHub：接受仓库、`tree/<ref>/<路径>`、`blob/<ref>/<路径>`（取所在目录）链接，从 `https://codeload.github.com/<owner>/<repo>/zip/<ref>`（缺省 `HEAD`）下载，只走 https，重定向只允许留在 `codeload.github.com`，120 秒超时。
  - zip：薄壳自带的读取器（基于已在依赖树中的 `flate2`），拒绝绝对路径、`..`、盘符、设备名等危险条目名，校验 CRC，跳过符号链接；压缩包最大 64 MiB、最多 5,000 个条目、单个文件 32 MiB、合计 256 MiB。
  - 本地文件夹：逐个复制，不跟随也不复制链接，跳过 `.git`，上限同 zip。
- frontmatter 按 Core 的做法解析：取法照搬 `agent-core/packages/coding-agent/src/utils/frontmatter.ts`，YAML 用 Core 同一个解析器（`yaml` 包，版本与 agent-core 锁定的一致，`pnpm check:versions` 核对）；校验照搬 `core/skills.ts` 的 `loadSkillFromFile`：缺少 `description` 或 YAML 无效的技能 Core 不加载，界面标出；名称与长度问题 Core 只告警，这里也只提示。
- 启停写 Core `settings.json` 的 `skills` 数组：停用加入 `-<技能文件绝对路径>`（与 Core 的精确排除一致），启用删掉指向它的精确排除；通配写法不改写。新会话生效。
- 删除只限 `skills/` 的直接子项；是链接 / 目录联接时只删链接本身。`~/.agents/skills` 的技能只能启停。

### MCP

- 只编辑用户级 `<Core 用户目录>/mcp.json`。薄壳 `mcp_config_read` 返回原文与版本（内容的 SHA-256），`mcp_config_write` 只在版本未变时原子替换（否则 `conflict`，界面重新读取后请用户再操作一次），且只检查是 1 MiB 以内、`mcpServers` 为对象的 JSON 对象。
- 条目的校验在前端，与 Core 一致：名字为字母、数字、`_`、`-`，只差 `-` 与 `_` 的名字冲突；stdio（`command` / `args` / `env` / `cwd`）或 Streamable HTTP（`url` / `headers` / `oauth`），拒绝 `sse`；`exposure` / `toolExposure` 取 `codemode` / `deferred` / `direct` / `hidden`；`auth` 要求 https 或回环地址。修改只动目标条目，其余内容与不认识的字段保留，按原文缩进重写。启用删掉 `enabled` 键，停用写 `enabled: false`；暴露方式为默认的 `codemode` 时不写。
- 添加：表单（类型、命令行或地址、环境变量 / 请求头、描述、暴露方式），或粘贴 JSON：Claude Desktop / Core 的 `{"mcpServers": …}`、VS Code 的 `{"servers": …}` 与 settings.json 的 `{"mcp": {"servers": …}}`（去掉 `type: stdio/http` 与 Core 不支持的字段，提示 `${input:…}` 变量）、单条 `{"名字": {…}}` 或不带名字的单个条目。同名的服务器被替换。编辑可用表单或直接改该条目的 JSON。
- 测试连接：薄壳以 `run_cli` 运行 Core 命令行 `mcp list --json`（60 秒），界面显示每个服务器的状态、工具数与错误，以及配置错误。
- OAuth：`mcp login --timeout 300 -- <名字>`，由 Core 打开系统浏览器并等待回调（薄壳最多等 330 秒）；`mcp logout -- <名字>`。令牌由 Core 写入 `mcp-auth.json`，界面不接触。
- `run_cli` 与会话进程使用同一套 Core 环境（`apply_core_env`：Core 用户目录、会话目录、临时目录、Python、系统代理等），放在独立的 Job Object 中，超时即结束整棵进程树，输出最多保留 4 MiB。

### 默认暴露方式

- 与 Core 一致，MCP 工具默认 `codemode`：工具只在 codemode 脚本中可用，模型的工具列表里只出现命名空间，脚本用 `searchTools()` 查找。技术方案第 13.4 节据此更正。

## 影响

- 新增 11 个薄壳命令（附录 B）：`skills_list`、`skill_stage`、`skill_install`、`skill_discard`、`skill_delete`、`skill_set_enabled`、`mcp_config_read`、`mcp_config_write`、`mcp_list`、`mcp_login`、`mcp_logout`。新增直接依赖 `flate2`（`rust_backend`，与依赖树中已有的版本一致）。
- 不改 `agent-core/`；Core 原生的技能与 MCP 行为不变。
- 已知取舍：
  - 启停只认精确排除，用户手写的通配规则不改写，界面显示的启用状态只按精确规则判断。
  - `mcp.json` 的 `env` / `headers` 明文保存，界面提示改用 `${环境变量}` 引用。
  - 一次暂存只安装一个技能，同一仓库的多个技能需各读取一次。
