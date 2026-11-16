# ADR 0016：技能目录读取放行、用户级 mcp.json 按权限模式、`.agents/skills` 计入项目信任

- 状态：已采纳（2026-11-16）
- 修订：技术方案第 17.2 节（项目信任指纹）、第 17.4 节（受保护路径）

## 背景

- Core 的技能按需加载：系统提示词只列技能名、描述与 `SKILL.md` 的位置，模型需要时用 `read` 读取 `SKILL.md` 及其引用的文件。用户级技能在 Core 用户目录 `<安装目录>\data\users\<SID>\core\skills`，属于受保护的 App 数据目录：每次读取都弹确认，完全访问模式下也一样，技能几乎无法使用。
- 能力中心之外，用户也会让 Agent 直接修改用户级 MCP 配置 `<agentDir>/mcp.json`（例如“帮我把这个 MCP 服务器加上”）。它同样在 App 数据目录内，写入一律拒绝。而同目录的 `auth.json`、`mcp-auth.json`（OAuth 令牌）、`models.json` 等必须继续保护。
- Core 在项目被信任后除 `.primus/skills` 外，还会加载工作区及上级目录（到 Git 仓库根为止）的 `.agents/skills`。原来的信任指纹只覆盖 `.primus/`：信任后有人往 `.agents/skills` 放入新技能，不会触发重新确认。

## 决定

### primus-guard（`packages/extensions/src/guard/index.ts`）

- 受保护路径拆为两类：**机密路径**（`.env*`、`.git/` 内部、`~/.ssh`，`isSecretPath`）与 **App 数据目录**（`isAppDataPath`）。`isProtectedPath` 仍是两者之和，计划模式的命令检查与预览工具照旧使用。
- `decide()` 对 read / grep / find / ls / write / edit 的路径按以下顺序判断（解析后的路径与跟随符号链接后的真实路径都检查）：
  1. 机密路径：写入拒绝、读取询问。不论位置，技能目录内的 `.env` 也一样。
  2. 用户级 MCP 配置（`isUserMcpConfig`）：解析后的路径正是 `<agentDir>/mcp.json`，且真实路径是 agentDir 真实路径下的 `mcp.json`。读写按权限模式：完全访问放行，询问 / 自动编辑询问；计划模式下修改由 `decidePlan` 拒绝。`mcp.json` 本身是符号链接（可能指向 `auth.json`）或经其他链接到达时不算，按 App 数据目录处理。
  3. 已加载技能目录内的读取（`insideLoadedSkill`）：任何权限模式（含计划模式）都放行。技能目录取自每轮开始的 `before_agent_start` 事件 `systemPromptOptions.skills[].baseDir`，只读、不改提示词；`/reload` 后下一轮生效。解析后的路径须在技能目录内，真实路径须在技能目录的真实路径内，`..` 与指向外部的链接 / 目录联接逃不出去。技能目录是根目录、或包含 Core 用户目录、App 数据目录、用户主目录时不放行（配置错误的技能不能把整块数据放开）。技能目录内的写入不放行。
  4. App 数据目录：写入拒绝、读取询问。
  5. 其余按权限模式与工作区内外判断（不变）。
- 技能脚本经 PowerShell / bash 运行时按普通命令规则判断，不因位于技能目录而放行。
- MCP 工具调用（直接暴露，或经 codemode 脚本嵌套调用，Core 让嵌套调用同样经过 `tool_call`）按权限模式：完全访问放行，询问 / 自动编辑询问，计划模式询问；服务器声明 `readOnlyHint: true` 且 `openWorldHint: false` 时与其他工具同一条规则放行。参数里的 `path` 不触发内置读写工具的路径规则。

### 项目信任指纹（`apps/desktop/src-tauri/src/workspaces.rs`）

- 指纹在 `.primus/` 之后，按层级依次计入 Core 信任后会加载的每个 `.agents/skills`：从工作区起逐级往上，到含 `.git` 的目录（含该级）为止，不在仓库内时到根目录；用户级 `~/.agents/skills`（Core 总会加载）跳过。每段以 NUL 开头的分段标记与层级区分。读不了的目录、是文件的 `.agents/skills` Core 不加载，也不计入。
- 没有任何 `.agents/skills` 时指纹与只算 `.primus/` 的旧指纹相同，升级前已信任的工作区不必重新确认。
- 文件数与字节数上限（20,000 个、512 MiB）为 `.primus/` 与各 `.agents/skills` 合计。
- `workspace_inspect` 新增 `agentsSkills`：按 Core 的发现规则（`.agents/skills` 根目录下的 `*.md` 不算，子目录里没有 `SKILL.md` 时的 `*.md` 各是一个技能）列出，带相对工作区的前缀（`.agents/skills/review`、`../.agents/skills/lint`）；信任确认弹窗单列为“.agents 技能”。

## 影响

- 不改 `agent-core/`：技能目录来自扩展 API 公开的 `before_agent_start` 事件。
- 读取技能文件不再弹确认；技能目录内的 `.env*`、`.git` 与指向外部的链接仍受保护。
- Agent 可以在完全访问下直接改 `mcp.json`，其他模式下每次确认；`mcp-auth.json`、`auth.json` 等不变。
- 已信任且含 `.agents/skills` 的工作区升级后会重新确认一次。
- 未解决：codemode 脚本本身（`codemode` 工具没有只读声明）在询问 / 自动编辑模式下会先确认一次，其中每个 MCP 调用再各自确认。
