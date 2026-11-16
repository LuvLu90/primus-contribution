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
  2. 用户级 MCP 配置（`isUserMcpConfig`）：解析后的路径（`..` 按字面消去，与 Core 打开的路径相同）正是 `<agentDir>/mcp.json`，`mcp.json` 本身不是符号链接（`lstat`；还不存在时可以新建），且真实路径是 agentDir 真实路径下的 `mcp.json`。第一条保证除 agentDir 自身外不经过任何目录，别处指向 agentDir 的链接 / 目录联接到达的路径不算。agentDir（`PRIMUS_CODING_AGENT_DIR`）由 App 设置，属于可信配置：它自身路径里的链接（macOS 的 `/var` → `/private/var`、安装路径中的目录联接，或 agentDir 本身就是链接）是平台 / 安装层面的，允许；此时绕开它直接用真实目录的路径不算。读写按权限模式：完全访问放行，询问 / 自动编辑询问；计划模式下修改由 `decidePlan` 拒绝。`mcp.json` 本身是符号链接（可能指向 `auth.json`）或经其他链接到达时不算，按 App 数据目录处理。
  3. 已加载技能目录内的读取（`insideLoadedSkill`）：任何权限模式（含计划模式）都放行。技能目录取自每轮开始的 `before_agent_start` 事件 `systemPromptOptions.skills[].baseDir`，只读、不改提示词；`/reload` 后下一轮生效。解析后的路径须在技能目录内，真实路径须在技能目录的真实路径内，`..` 与指向外部的链接 / 目录联接逃不出去。技能目录是根目录、或包含 Core 用户目录、App 数据目录、用户主目录时不放行（配置错误的技能不能把整块数据放开；两边都按解析路径与真实路径比较，经链接 / 目录联接也能识别）。`grep` 会递归读取目录内全部文件的内容（含隐藏文件，例如技能目录里的 `.env`），只对技能目录内的单个文件放行，对目录按常规规则判断；`ls`、`find` 只返回名字。技能目录内的写入不放行。
  4. App 数据目录：写入拒绝、读取询问。数据目录按字面路径与真实路径都比较，Core 用户目录的真实路径（它自身是指向别处的链接时）也算在内：数据目录在平台 / 安装层面的链接下（macOS 的 `/var` → `/private/var`、目录联接）时，经真实路径给出的 `auth.json`、`mcp.json` 同样识别为 App 数据（`mcp.json` 的例外只认第 2 条的确切路径，真实路径别名不算）。默认对话工作区 `users\<SID>\chat` 按其在数据目录真实路径下的位置排除，不取 `chat` 自身的真实路径（它是指向 core 的链接时不能借此排除 core）。
  5. 其余按权限模式与工作区内外判断（不变）。
- 技能脚本经 PowerShell / bash 运行时按普通命令规则判断，不因位于技能目录而放行。
- MCP 工具调用（直接暴露，或经 codemode 脚本嵌套调用，Core 让嵌套调用同样经过 `tool_call`）按权限模式：完全访问放行，询问 / 自动编辑询问，计划模式询问；服务器声明 `readOnlyHint: true` 且 `openWorldHint: false` 时与其他工具同一条规则放行。参数里的 `path` 不触发内置读写工具的路径规则。

### 项目信任指纹（`apps/desktop/src-tauri/src/workspaces.rs`）

- 指纹在 `.primus/` 之后，按层级依次计入 Core 信任后会加载的每个 `.agents/skills`：从工作区起逐级往上，到含 `.git` 的目录（含该级）为止，不在仓库内时到根目录；用户级 `~/.agents/skills`（Core 总会加载）跳过。每段以 NUL 开头的分段标记与层级区分。只有确定没有技能时跳过：`.agents/skills` 不存在（上级 `.agents` 不存在，或跟随链接后是普通文件 / 没有 `skills` 的目录），或它（跟随链接后）是普通文件。其他情况——没有权限、断开的符号链接（`skills` 或上级 `.agents` 是链接而目标缺失，目标之后出现时 Core 就会加载）、其他 IO 错误——无法确认 Core 会加载什么：指纹不完整、不能信任，`workspace_inspect` 报读取错误，而不是当作“没有”。
- 遍历时每个目录的条目按文件名排序后再递归：同一目录经多个链接到达时只展开按顺序先到的一处，`read_dir` 的返回顺序不影响指纹。
- 没有任何 `.agents/skills` 时指纹与只算 `.primus/` 的旧指纹相同，升级前已信任的工作区不必重新确认。
- 文件数与字节数上限（20,000 个、512 MiB）为 `.primus/` 与各 `.agents/skills` 合计。
- `workspace_inspect` 新增 `agentsSkills`：按 Core 的发现规则（`.agents/skills` 根目录下的 `*.md` 不算，子目录里没有 `SKILL.md` 时的 `*.md` 各是一个技能）列出，带相对工作区的前缀（`.agents/skills/review`、`../.agents/skills/lint`）；信任确认弹窗单列为“.agents 技能”。

## 影响

- 不改 `agent-core/`：技能目录来自扩展 API 公开的 `before_agent_start` 事件。
- 读取技能文件不再弹确认；技能目录内的 `.env*`、`.git` 与指向外部的链接仍受保护。
- Agent 可以在完全访问下直接改 `mcp.json`，询问 / 自动编辑模式下每次确认，计划模式下拒绝修改；`mcp-auth.json`、`auth.json` 等不变。
- 已信任且含 `.agents/skills` 的工作区升级后会重新确认一次。
- 未解决：codemode 脚本本身（`codemode` 工具没有只读声明）在询问 / 自动编辑模式下会先确认一次，其中每个 MCP 调用再各自确认。
