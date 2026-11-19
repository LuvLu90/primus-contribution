//! 工作区管理（第 15.1 节、附录 B 的 `workspace_open` / `workspace_list` / `workspace_trust`）
//! 与项目信任（第 17.2 节）。
//!
//! 最近打开的工作区与信任状态存在 `users/<SID>/app/workspaces.json`（约束 C2：只写数据目录）。
//! 按最近打开时间倒序，最多保留 [`MAX_RECENT`] 个；同一目录按 [`crate::platform::path_key`] 去重
//! （Windows 不区分大小写、`/` 与 `\` 等价、忽略末尾分隔符）。写入先写临时文件再改名，不会留下半个文件。
//!
//! 信任：只在首次添加工作区时确认一次（[`WorkspaceInfo::needs_trust`]）。选择“信任”后之后的改动一律沿用信任，
//! 不再比对内容；每次新会话以 `--approve` 启动（只看 [`Workspaces::approved`]），由 Core 重新加载项目里的
//! 扩展、技能（`.primus/skills`、各级 `.agents/skills`）与 MCP（`.primus/mcp.json`、工作区本级的
//! `.agents/mcp.json`，ADR 0022）。

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 最近工作区列表的上限。
pub(crate) const MAX_RECENT: usize = 30;

/// 返回给前端的工作区信息（与 `WorkspaceInfo` 对应）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceInfo {
    pub(crate) path: String,
    pub(crate) name: String,
    /// 用户选择过“信任”
    pub(crate) trusted: bool,
    /// 需要显示信任确认：从未确认过
    pub(crate) needs_trust: bool,
}

/// 信任确认展示的项目内容（`workspace_inspect`）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrustDetails {
    pub(crate) path: String,
    /// 根目录 `AGENTS.md` 的内容（超过 [`AGENTS_MD_LIMIT`] 字节时截断）；不存在为 None
    pub(crate) agents_md: Option<String>,
    pub(crate) agents_md_truncated: bool,
    /// `.primus/extensions/` 下的条目名
    pub(crate) extensions: Vec<String>,
    /// `.primus/skills/` 下的条目名
    pub(crate) skills: Vec<String>,
    /// `.primus/mcp.json` 中的服务器名；文件存在但无法解析或过大时为 `["mcp.json"]`
    pub(crate) mcp_servers: Vec<String>,
    /// 工作区本级 `.agents/mcp.json` 中的服务器名（不往上级找，与 Core 一致，ADR 0022）；
    /// 文件存在但无法解析或过大时为 `["mcp.json"]`
    pub(crate) agents_mcp_servers: Vec<String>,
    /// 工作区及上级目录（到 Git 仓库根为止）`.agents/skills` 中 Core 会加载的技能，
    /// 带相对工作区的目录前缀（如 `.agents/skills/review`、`../.agents/skills/lint`）
    pub(crate) agents_skills: Vec<String>,
}

/// 信任确认中 `AGENTS.md` 最多展示的字节数。
pub(crate) const AGENTS_MD_LIMIT: usize = 64 * 1024;
/// `.primus/mcp.json`、`.agents/mcp.json` 最多读取的字节数，超过时只显示文件名。
const MCP_JSON_LIMIT: u64 = 1024 * 1024;
/// 扩展目录中 `package.json` 最多读取的字节数，超过时报错。
const PACKAGE_JSON_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: String,
    #[serde(default)]
    trusted: bool,
    /// 用户是否已对信任确认做过选择（“信任”或“不信任”）
    #[serde(default)]
    decided: bool,
    /// 最近打开时间（Unix 毫秒）
    #[serde(default)]
    last_opened: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct StoreFile {
    #[serde(default)]
    workspaces: Vec<Entry>,
}

/// 工作区命令的错误：`message` 是界面文案。
#[derive(Debug)]
pub(crate) enum WorkspaceError {
    /// 路径不是已存在目录的绝对路径
    NotADirectory(String),
    /// 信任操作的目标不在最近工作区中
    Unknown(String),
    /// 读取项目文件失败（`workspace_inspect`）
    Read(PathBuf, io::Error),
    Io(io::Error),
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotADirectory(p) => write!(f, "文件夹不存在或不可访问：{p}"),
            Self::Unknown(p) => write!(f, "不是已打开过的工作区：{p}"),
            Self::Read(p, e) => write!(f, "读取 {} 失败：{e}", p.display()),
            Self::Io(e) => write!(f, "无法保存工作区列表：{e}"),
        }
    }
}

impl From<io::Error> for WorkspaceError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// 最近工作区存储；读写串行，避免两个命令同时改文件。
pub(crate) struct Workspaces {
    file: PathBuf,
    lock: Mutex<()>,
}

impl Workspaces {
    /// `app_dir` 为 `users/<SID>/app`。
    pub(crate) fn new(app_dir: &Path) -> Self {
        Self {
            file: app_dir.join("workspaces.json"),
            lock: Mutex::new(()),
        }
    }

    /// 打开（登记）一个工作区：必须是已存在目录的绝对路径。已登记的保留信任状态并移到最前。
    pub(crate) fn open(&self, path: &str) -> Result<WorkspaceInfo, WorkspaceError> {
        let path = normalize(path).ok_or_else(|| WorkspaceError::NotADirectory(path.to_owned()))?;
        let entry = {
            let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
            let mut store = self.load()?;
            // 信任绑定确切路径：只沿用写法完全相同的记录；只差大小写的写法视为另一个目录，单独登记为未确认（V5.3）
            let same = store.workspaces.iter().position(|e| e.path == path);
            let mut entry = match same {
                Some(i) => store.workspaces.remove(i),
                None => untrusted(path.clone()),
            };
            entry.path = path;
            entry.last_opened = now_ms();
            store.workspaces.insert(0, entry.clone());
            store.workspaces.truncate(MAX_RECENT);
            self.save(&store)?;
            entry
        };
        Ok(entry_info(&entry))
    }

    /// 最近工作区，最近打开的在前；已不存在的目录不列出（记录保留，目录恢复后重新出现）。
    /// 文件读取失败（不是“不存在”）时返回错误，由界面提示，而不是显示成空列表。
    pub(crate) fn list(&self) -> io::Result<Vec<WorkspaceInfo>> {
        let mut items = {
            let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
            self.load()?.workspaces
        };
        items.sort_by_key(|e| std::cmp::Reverse(e.last_opened));
        Ok(items
            .iter()
            .filter(|e| Path::new(&e.path).is_dir())
            .map(entry_info)
            .collect())
    }

    /// 会话是否以 `--approve` 启动：已登记且用户选择过“信任”。
    /// 读取失败或未登记一律按未信任处理。
    /// 只认与登记记录完全相同的路径：只差大小写的路径可能是另一个目录。
    pub(crate) fn approved(&self, path: &str) -> bool {
        let Some(path) = normalize(path) else {
            return false;
        };
        let entry = {
            let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
            self.load()
                .ok()
                .and_then(|s| s.workspaces.into_iter().find(|e| e.path == path))
        };
        entry.is_some_and(|e| entry_info(&e).trusted)
    }

    /// 记录信任确认的选择；目标必须已打开过（路径完全一致）。
    pub(crate) fn trust(&self, path: &str, trusted: bool) -> Result<(), WorkspaceError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut store = self.load()?;
        let entry = store
            .workspaces
            .iter_mut()
            .find(|e| e.path == path)
            .ok_or_else(|| WorkspaceError::Unknown(path.to_owned()))?;
        entry.trusted = trusted;
        entry.decided = true;
        self.save(&store)?;
        Ok(())
    }

    /// 读文件；不存在或内容损坏时视为空列表（损坏的文件在下次保存时被覆盖）。
    /// 其他读取错误原样返回，避免 `open` / `trust` 拿空列表覆盖原有记录。
    fn load(&self) -> io::Result<StoreFile> {
        match std::fs::read(&self.file) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                eprintln!("工作区列表损坏，按空列表处理：{e}");
                StoreFile::default()
            })),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(StoreFile::default()),
            Err(e) => Err(e),
        }
    }

    fn save(&self, store: &StoreFile) -> io::Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_vec_pretty(store).map_err(io::Error::other)?;
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, &self.file).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
    }
}

/// 校验并规范路径：绝对路径、目录存在；去掉末尾分隔符（根目录除外）。
fn normalize(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let p = Path::new(trimmed);
    if !p.is_absolute() || !p.is_dir() {
        return None;
    }
    let mut s = trimmed.to_owned();
    while s.len() > 1 && (s.ends_with('/') || s.ends_with('\\')) {
        let rest = &s[..s.len() - 1];
        // 保留 `C:\` 这样的盘符根
        if rest.len() == 2 && rest.ends_with(':') {
            break;
        }
        s.pop();
    }
    Some(s)
}

fn untrusted(path: String) -> Entry {
    Entry {
        path,
        trusted: false,
        decided: false,
        last_opened: 0,
    }
}

fn entry_info(e: &Entry) -> WorkspaceInfo {
    WorkspaceInfo {
        path: e.path.clone(),
        name: display_name(&e.path),
        trusted: e.trusted && e.decided,
        needs_trust: !e.decided,
    }
}

/// 信任后 Core 会加载技能的 `.agents/skills` 目录（与 agent-core 的发现规则一致）：从工作区起逐级往上，
/// 每级一个 `<目录>/.agents/skills`，到 Git 仓库根（含 `.git` 的目录，含该级）为止；不在仓库内时一直到根目录。
/// 用户级的 `~/.agents/skills` 不论信任与否都会加载，不算项目内容，跳过。返回（层级，目录），工作区本身为 0 级。
fn agents_skill_dirs(workspace: &Path) -> Vec<(usize, PathBuf)> {
    let start = workspace.to_path_buf();
    let git_root = start.ancestors().find(|d| d.join(".git").exists());
    let user_dir = home_dir().map(|h| h.join(".agents").join("skills"));
    let user_key = user_dir
        .as_deref()
        .map(|p| crate::platform::path_key(&p.to_string_lossy()));
    let mut dirs = Vec::new();
    for (depth, dir) in start.ancestors().enumerate() {
        let skills = dir.join(".agents").join("skills");
        if user_key.as_deref()
            != Some(crate::platform::path_key(&skills.to_string_lossy()).as_str())
        {
            dirs.push((depth, skills));
        }
        if git_root == Some(dir) {
            break;
        }
    }
    dirs
}

/// 用户主目录，与 Core 一致：优先 `HOME`，Windows 上再取 `USERPROFILE`。
fn home_dir() -> Option<PathBuf> {
    let from = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
    from("HOME")
        .or_else(|| {
            if cfg!(windows) {
                from("USERPROFILE")
            } else {
                None
            }
        })
        .map(PathBuf::from)
}

/// 某级 `.agents/skills` 是否要列入信任确认。只有确定没有技能时返回 false：路径不存在
/// （上级 `.agents` 不存在，或它跟随链接后是普通文件），或它（跟随链接后）是普通文件。其余情况——没有权限、
/// 断开的符号链接（链接在、目标缺失，不论是 `skills` 还是上级 `.agents`）、其他 IO 错误——都返回错误：
/// 读不到就无法确认 Core 会加载什么，不能当作“没有”。
fn agents_skill_dir_present(dir: &Path) -> io::Result<bool> {
    match std::fs::symlink_metadata(dir) {
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            // 解析 `.agents/skills` 时会跟随上级 `.agents`：它是断开的链接时同样报“不存在”，
            // 需要单独看上级，确认是真的没有，而不是读不到
            return match dir.parent() {
                Some(parent) => agents_parent_absent(parent).map(|()| false),
                None => Ok(false),
            };
        }
        Err(e) => return Err(e),
        Ok(_) => {}
    }
    let meta = match std::fs::metadata(dir) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "符号链接的目标不存在",
            ));
        }
        Err(e) => return Err(e),
    };
    if meta.is_file() {
        return Ok(false);
    }
    std::fs::read_dir(dir)?;
    Ok(true)
}

/// `.agents/skills` 不存在时检查上级 `.agents`：不存在，或（跟随链接后）存在——是文件，或是目录但其中
/// 没有 `skills`——返回 Ok；断开的链接（目标缺失）与其他读取失败返回错误。
fn agents_parent_absent(parent: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(parent) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
        Ok(m) if !m.file_type().is_symlink() => return Ok(()),
        Ok(_) => {}
    }
    match std::fs::metadata(parent) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Err(io::Error::new(
            io::ErrorKind::NotFound,
            "上级 .agents 符号链接的目标不存在",
        )),
        Err(e) => Err(e),
    }
}

/// `.agents/skills` 在信任确认里显示的前缀：相对工作区，如 `.agents/skills`、`../.agents/skills`。
fn agents_skill_label(depth: usize) -> String {
    format!("{}.agents/skills", "../".repeat(depth))
}

/// `mcp.json` 里 `mcpServers` 的服务器名：不存在为空；过大、不是 JSON 或没有 `mcpServers` 对象时只给文件名
/// `["mcp.json"]`，让信任确认仍能提示有这个文件。
fn mcp_server_names(file: &Path) -> io::Result<Vec<String>> {
    let limit = usize::try_from(MCP_JSON_LIMIT).unwrap_or(usize::MAX);
    let read = match read_prefix(file, limit) {
        // 上级（如 `.agents`）是文件：Core 同样当作没有
        Err(e) if e.kind() == io::ErrorKind::NotADirectory => return Ok(Vec::new()),
        r => r?,
    };
    Ok(match read {
        None => Vec::new(),
        Some((_, true)) => vec!["mcp.json".to_owned()],
        Some((bytes, false)) => serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|v| {
                v.get("mcpServers")
                    .and_then(|m| m.as_object())
                    .map(|m| m.keys().cloned().collect())
            })
            .unwrap_or_else(|| vec!["mcp.json".to_owned()]),
    })
}

/// 读取信任确认要展示的内容；路径必须是已存在的目录。只有“不存在”视为没有，其他读取错误返回失败，
/// 避免弹窗把读不到的内容显示成“没有”。
pub(crate) fn inspect(path: &str) -> Result<TrustDetails, WorkspaceError> {
    let path = normalize(path).ok_or_else(|| WorkspaceError::NotADirectory(path.to_owned()))?;
    let root = Path::new(&path);
    let agents = root.join("AGENTS.md");
    let (agents_md, agents_md_truncated) = match read_prefix(&agents, AGENTS_MD_LIMIT) {
        Ok(Some((bytes, truncated))) => (
            Some(String::from_utf8_lossy(&bytes).into_owned()),
            truncated,
        ),
        Ok(None) => (None, false),
        Err(e) => return Err(WorkspaceError::Read(agents, e)),
    };
    let primus = root.join(".primus");
    let mcp_file = primus.join("mcp.json");
    let mcp_servers = mcp_server_names(&mcp_file).map_err(|e| WorkspaceError::Read(mcp_file, e))?;
    let agents_mcp_file = root.join(".agents").join("mcp.json");
    let agents_mcp_servers = mcp_server_names(&agents_mcp_file)
        .map_err(|e| WorkspaceError::Read(agents_mcp_file, e))?;
    let ext_dir = primus.join("extensions");
    let extensions = list_extensions(&ext_dir).map_err(|e| WorkspaceError::Read(ext_dir, e))?;
    let skill_dir = primus.join("skills");
    let mut skills = Vec::new();
    let mut visited = std::collections::HashSet::new();
    list_skills(
        &skill_dir,
        "",
        SkillLayout::Primus,
        &mut skills,
        &mut visited,
    )
    .map_err(|e| WorkspaceError::Read(skill_dir, e))?;
    skills.sort();
    let mut agents_skills = Vec::new();
    for (depth, dir) in agents_skill_dirs(root) {
        // 只有不存在或是文件时才跳过；其他读取失败报错，不能把读不到的技能显示成“没有”
        if !agents_skill_dir_present(&dir).map_err(|e| WorkspaceError::Read(dir.clone(), e))? {
            continue;
        }
        let mut found = Vec::new();
        let mut visited = std::collections::HashSet::new();
        list_skills(&dir, "", SkillLayout::Agents, &mut found, &mut visited)
            .map_err(|e| WorkspaceError::Read(dir.clone(), e))?;
        found.sort();
        let label = agents_skill_label(depth);
        agents_skills.extend(found.into_iter().map(|s| format!("{label}/{s}")));
    }
    Ok(TrustDetails {
        agents_md,
        agents_md_truncated,
        extensions,
        skills,
        mcp_servers,
        agents_mcp_servers,
        agents_skills,
        path,
    })
}

/// 以不阻塞的方式打开并确认是普通文件（跟随符号链接）。先查类型再打开有竞争窗口：
/// 期间被换成 FIFO 时普通的打开会一直阻塞，所以 Unix 上以 `O_NONBLOCK` 打开，再按已打开的句柄判断类型。
fn open_regular(path: &Path) -> io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("不是普通文件"));
    }
    Ok(file)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
const O_NONBLOCK: i32 = 0o4000;
#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
const O_NONBLOCK: i32 = 0x0004;

/// 最多读 `limit` 字节（多读 1 字节判断是否截断）；文件不存在为 None，不是普通文件为错误。
fn read_prefix(path: &Path, limit: usize) -> io::Result<Option<(Vec<u8>, bool)>> {
    let file = match open_regular(path) {
        Ok(f) => f,
        // 只有路径本身不存在才算“没有”；断开的符号链接（链接在、目标缺失）要报错，不能显示成“没有”
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return match std::fs::symlink_metadata(path) {
                Err(m) if m.kind() == io::ErrorKind::NotFound => Ok(None),
                Ok(_) => Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "符号链接的目标不存在",
                )),
                Err(m) => Err(m),
            };
        }
        Err(e) => return Err(e),
    };
    let mut bytes = Vec::new();
    io::Read::read_to_end(&mut io::Read::take(file, limit as u64 + 1), &mut bytes)?;
    let truncated = bytes.len() > limit;
    bytes.truncate(limit);
    Ok(Some((bytes, truncated)))
}

/// 读目录项；目录不存在为空。
fn read_entries(dir: &Path) -> io::Result<Vec<std::fs::DirEntry>> {
    match std::fs::read_dir(dir) {
        Ok(r) => r.collect(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

/// Core 会加载的扩展（与 agent-core 的发现规则一致，只看一层）：直接的 `*.ts` / `*.js`，
/// 以及含 `package.json`（`pi.extensions`）或 `index.ts` / `index.js` 的子目录。均跟随符号链接。
fn list_extensions(dir: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in read_entries(dir)? {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            // 断开的链接：Core 同样加载不到
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        let loads = if meta.is_dir() {
            path.join("index.ts").exists()
                || path.join("index.js").exists()
                || has_pi_extensions(&path.join("package.json"))?
        } else {
            name.ends_with(".ts") || name.ends_with(".js")
        };
        if loads {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

/// `package.json` 是否声明了 `pi.extensions`。不存在或无法解析为 false（Core 同样不加载）；
/// 读取失败或超过上限时返回错误，不能猜测为“没有扩展”。
fn has_pi_extensions(manifest: &Path) -> io::Result<bool> {
    let dir = manifest.parent().unwrap_or(Path::new("."));
    let Some((bytes, truncated)) = read_prefix(manifest, PACKAGE_JSON_LIMIT)? else {
        return Ok(false);
    };
    if truncated {
        return Err(io::Error::other(format!(
            "{} 超过 {} 字节，无法确认其中声明的扩展",
            manifest.display(),
            PACKAGE_JSON_LIMIT
        )));
    }
    Ok(serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| {
            // 与 Core 一致：只有至少一个声明的入口存在时才加载
            v.get("pi")?.get("extensions")?.as_array().map(|a| {
                a.iter()
                    .filter_map(|p| p.as_str())
                    .any(|p| dir.join(p).exists())
            })
        })
        .unwrap_or(false))
}

/// 技能目录的布局：`.primus/skills` 中根目录下直接的 `*.md` 各是一个技能；`.agents/skills` 中反过来，
/// 根目录下的 `*.md` 不算，子目录里（没有 `SKILL.md` 时）的 `*.md` 各是一个技能。
#[derive(Clone, Copy)]
enum SkillLayout {
    Primus,
    Agents,
}

/// Core 会加载的技能（与 agent-core 的发现规则一致）：含 `SKILL.md` 的目录是一个技能且不再往下找；
/// 否则按 [`SkillLayout`] 计入 `*.md`，并递归子目录（跳过隐藏项与 `node_modules`，跟随符号链接）。
fn list_skills(
    dir: &Path,
    rel: &str,
    layout: SkillLayout,
    out: &mut Vec<String>,
    visited: &mut std::collections::HashSet<PathBuf>,
) -> io::Result<()> {
    if let Ok(canonical) = std::fs::canonicalize(dir)
        && !visited.insert(canonical)
    {
        return Ok(());
    }
    let entries = read_entries(dir)?;
    if entries
        .iter()
        .any(|e| e.file_name() == "SKILL.md" && e.path().is_file())
    {
        out.push(if rel.is_empty() {
            "SKILL.md".to_owned()
        } else {
            rel.to_owned()
        });
        return Ok(());
    }
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            // 断开的链接：Core 同样加载不到
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        let child = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let md_counts = match layout {
            SkillLayout::Primus => rel.is_empty(),
            SkillLayout::Agents => !rel.is_empty(),
        };
        if meta.is_dir() {
            list_skills(&path, &child, layout, out, visited)?;
        } else if md_counts && name.ends_with(".md") {
            out.push(child);
        }
    }
    Ok(())
}

/// 显示名：路径最后一段（兼容 `\` 与 `/`）；根目录用路径本身。
fn display_name(path: &str) -> String {
    path.split(['\\', '/'])
        .rfind(|s| !s.is_empty())
        .filter(|s| !s.ends_with(':'))
        .map(str::to_owned)
        .unwrap_or_else(|| path.to_owned())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 等同用户在弹窗中点“信任”。
    fn trust_now(ws: &Workspaces, path: &str) {
        ws.trust(path, true).unwrap();
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "primus-ws-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn open_registers_and_lists_most_recent_first() {
        let root = temp_dir("order");
        let a = root.join("a");
        let b = root.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let ws = Workspaces::new(&root.join("app"));
        let first = ws.open(a.to_str().unwrap()).unwrap();
        assert_eq!(first.name, "a");
        assert!(!first.trusted);
        std::thread::sleep(std::time::Duration::from_millis(2));
        ws.open(b.to_str().unwrap()).unwrap();
        let names: Vec<_> = ws.list().unwrap().into_iter().map(|w| w.name).collect();
        assert_eq!(names, ["b", "a"]);
        // 再次打开 a：去重并移到最前
        std::thread::sleep(std::time::Duration::from_millis(2));
        ws.open(&format!("{}/", a.to_str().unwrap())).unwrap();
        let names: Vec<_> = ws.list().unwrap().into_iter().map(|w| w.name).collect();
        assert_eq!(names, ["a", "b"]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn open_rejects_missing_or_relative_paths() {
        let root = temp_dir("reject");
        let ws = Workspaces::new(&root.join("app"));
        assert!(matches!(
            ws.open(root.join("missing").to_str().unwrap()),
            Err(WorkspaceError::NotADirectory(_))
        ));
        assert!(matches!(
            ws.open("relative/dir"),
            Err(WorkspaceError::NotADirectory(_))
        ));
        assert!(matches!(
            ws.open("  "),
            Err(WorkspaceError::NotADirectory(_))
        ));
        // 文件不是目录
        let file = root.join("f.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(ws.open(file.to_str().unwrap()).is_err());
        assert!(ws.list().unwrap().is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn unreadable_store_is_reported_not_overwritten() {
        let root = temp_dir("unreadable");
        let a = root.join("proj");
        std::fs::create_dir_all(&a).unwrap();
        let app = root.join("app");
        // workspaces.json 位置被目录占用：读取失败（不是“不存在”），不能当空列表写回
        std::fs::create_dir_all(app.join("workspaces.json")).unwrap();
        let ws = Workspaces::new(&app);
        assert!(ws.open(a.to_str().unwrap()).is_err());
        assert!(ws.trust(a.to_str().unwrap(), false).is_err());
        assert!(ws.list().is_err());
        assert!(app.join("workspaces.json").is_dir());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn trust_persists_and_survives_reopen() {
        let root = temp_dir("trust");
        let a = root.join("proj");
        std::fs::create_dir_all(&a).unwrap();
        let app = root.join("app");
        let ws = Workspaces::new(&app);
        let path = ws.open(a.to_str().unwrap()).unwrap().path;
        assert!(matches!(
            ws.trust(root.join("other").to_str().unwrap(), false),
            Err(WorkspaceError::Unknown(_))
        ));
        trust_now(&ws, &path);
        // 新实例读同一文件
        let again = Workspaces::new(&app);
        assert!(again.list().unwrap()[0].trusted);
        assert!(again.open(&path).unwrap().trusted);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn first_open_needs_trust_until_a_choice_is_made() {
        let root = temp_dir("needs");
        let path = root.join("proj").to_string_lossy().into_owned();
        std::fs::create_dir_all(&path).unwrap();
        let ws = Workspaces::new(&root.join("app"));

        let first = ws.open(&path).unwrap();
        assert!(first.needs_trust && !first.trusted);
        assert!(!ws.approved(&path));

        // “不信任”同样记为已确认，之后不再询问，会话以 --no-approve 启动
        ws.trust(&path, false).unwrap();
        let again = ws.open(&path).unwrap();
        assert!(!again.needs_trust && !again.trusted);
        assert!(!ws.approved(&path));

        trust_now(&ws, &path);
        let trusted = ws.open(&path).unwrap();
        assert!(!trusted.needs_trust && trusted.trusted);
        assert!(ws.approved(&path));
        assert!(!ws.approved(&root.join("other").to_string_lossy()));
    }

    #[test]
    fn later_changes_keep_trust() {
        // 只在首次添加时确认；之后改动 .primus/ 或 .agents/skills 都沿用信任，新会话由 Core 重新加载
        let root = temp_dir("rehash");
        let proj = root.join("proj");
        std::fs::create_dir_all(proj.join(".primus/extensions")).unwrap();
        std::fs::write(proj.join(".primus/extensions/a.js"), "one").unwrap();
        let path = proj.to_string_lossy().into_owned();
        let ws = Workspaces::new(&root.join("app"));
        ws.open(&path).unwrap();
        trust_now(&ws, &path);
        assert!(ws.approved(&path));

        std::fs::write(proj.join(".primus/extensions/a.js"), "two").unwrap();
        std::fs::create_dir_all(proj.join(".primus/skills/s")).unwrap();
        std::fs::write(proj.join(".primus/skills/s/SKILL.md"), "x").unwrap();
        std::fs::write(proj.join(".primus/mcp.json"), r#"{"mcpServers":{}}"#).unwrap();
        std::fs::create_dir_all(proj.join(".agents/skills/new")).unwrap();
        std::fs::write(proj.join(".agents/skills/new/SKILL.md"), "n").unwrap();
        let info = ws.open(&path).unwrap();
        assert!(!info.needs_trust && info.trusted);
        assert!(ws.approved(&path));
    }

    #[test]
    fn agents_skills_up_to_git_root_are_listed() {
        let root = temp_dir("agents");
        let repo = root.join("repo");
        let proj = repo.join("sub");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(proj.join(".agents/skills/review")).unwrap();
        std::fs::create_dir_all(proj.join(".agents/skills/group")).unwrap();
        std::fs::create_dir_all(repo.join(".agents/skills/lint")).unwrap();
        std::fs::create_dir_all(root.join(".agents/skills/outside")).unwrap();
        std::fs::write(proj.join(".agents/skills/review/SKILL.md"), "r").unwrap();
        // .agents/skills 根目录下的 *.md 不是技能，子目录里的才是
        std::fs::write(proj.join(".agents/skills/notes.md"), "n").unwrap();
        std::fs::write(proj.join(".agents/skills/group/x.md"), "x").unwrap();
        std::fs::write(repo.join(".agents/skills/lint/SKILL.md"), "l").unwrap();
        std::fs::write(root.join(".agents/skills/outside/SKILL.md"), "o").unwrap();
        let path = proj.to_string_lossy().into_owned();

        let d = inspect(&path).unwrap();
        assert_eq!(
            d.agents_skills,
            vec![
                ".agents/skills/group/x.md",
                ".agents/skills/review",
                "../.agents/skills/lint",
            ]
        );
        assert!(d.skills.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_agents_skills_is_a_read_error() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_dir("agents-noread");
        let proj = root.join("proj");
        std::fs::create_dir_all(proj.join(".git")).unwrap();
        let skills = proj.join(".agents/skills");
        std::fs::create_dir_all(skills.join("review")).unwrap();
        std::fs::write(skills.join("review/SKILL.md"), "r").unwrap();
        let path = proj.to_string_lossy().into_owned();
        std::fs::set_permissions(&skills, std::fs::Permissions::from_mode(0o000)).unwrap();
        // 以 root 运行时权限不起作用，跳过
        if std::fs::read_dir(&skills).is_ok() {
            std::fs::set_permissions(&skills, std::fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }
        let details = inspect(&path);
        std::fs::set_permissions(&skills, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(details, Err(WorkspaceError::Read(p, _)) if p == skills));
    }

    #[cfg(unix)]
    #[test]
    fn broken_agents_skills_link_is_a_read_error() {
        let root = temp_dir("agents-broken");
        let proj = root.join("proj");
        std::fs::create_dir_all(proj.join(".git")).unwrap();
        std::fs::create_dir_all(proj.join(".agents")).unwrap();
        let path = proj.to_string_lossy().into_owned();
        let skills = proj.join(".agents/skills");
        std::os::unix::fs::symlink(root.join("missing"), &skills).unwrap();
        assert!(matches!(inspect(&path), Err(WorkspaceError::Read(p, _)) if p == skills));

        // 指向文件的链接与普通文件一样，Core 不加载，跳过
        std::fs::write(root.join("missing"), "file").unwrap();
        assert!(inspect(&path).unwrap().agents_skills.is_empty());
        // 上级 .agents 是文件：.agents/skills 不可能存在，跳过
        std::fs::remove_file(&skills).unwrap();
        std::fs::remove_dir(proj.join(".agents")).unwrap();
        std::fs::write(proj.join(".agents"), "file").unwrap();
        assert!(inspect(&path).unwrap().agents_skills.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn broken_agents_parent_link_is_a_read_error() {
        let root = temp_dir("agents-parent-broken");
        let proj = root.join("proj");
        std::fs::create_dir_all(proj.join(".git")).unwrap();
        let path = proj.to_string_lossy().into_owned();
        let agents = proj.join(".agents");
        let skills = agents.join("skills");
        std::os::unix::fs::symlink(root.join("target"), &agents).unwrap();
        assert!(matches!(inspect(&path), Err(WorkspaceError::Read(p, _)) if p == skills));

        // 链接指向文件：.agents/skills 不可能存在，跳过
        std::fs::write(root.join("target"), "file").unwrap();
        assert!(inspect(&path).unwrap().agents_skills.is_empty());
        // 链接指向没有 skills 的目录：跳过；之后出现技能时列出
        std::fs::remove_file(root.join("target")).unwrap();
        std::fs::create_dir(root.join("target")).unwrap();
        assert!(inspect(&path).unwrap().agents_skills.is_empty());
        std::fs::create_dir_all(root.join("target/skills/review")).unwrap();
        std::fs::write(root.join("target/skills/review/SKILL.md"), "r").unwrap();
        assert_eq!(inspect(&path).unwrap().agents_skills.len(), 1);
    }

    #[test]
    fn inspect_lists_agents_mcp_servers() {
        let root = temp_dir("agents-mcp");
        let proj = root.join("proj");
        std::fs::create_dir_all(proj.join(".agents")).unwrap();
        std::fs::create_dir_all(proj.join(".primus")).unwrap();
        std::fs::write(
            proj.join(".primus/mcp.json"),
            r#"{"mcpServers":{"github":{}}}"#,
        )
        .unwrap();
        std::fs::write(
            proj.join(".agents/mcp.json"),
            r#"{"mcpServers":{"docs":{"url":"https://example.com/mcp"},"db":{}}}"#,
        )
        .unwrap();
        // 上级目录的 .agents/mcp.json 不读（Core 只读工作区本级）
        std::fs::create_dir_all(root.join(".agents")).unwrap();
        std::fs::write(
            root.join(".agents/mcp.json"),
            r#"{"mcpServers":{"parent":{}}}"#,
        )
        .unwrap();

        let d = inspect(&proj.to_string_lossy()).unwrap();
        assert_eq!(d.mcp_servers, vec!["github"]);
        let mut agents = d.agents_mcp_servers.clone();
        agents.sort();
        assert_eq!(agents, vec!["db", "docs"]);

        // 解析失败、过大：只显示文件名
        let path = proj.to_string_lossy().into_owned();
        std::fs::write(proj.join(".agents/mcp.json"), "not json").unwrap();
        let d = inspect(&path).unwrap();
        assert_eq!(d.agents_mcp_servers, vec!["mcp.json"]);
        let pad = "a".repeat(usize::try_from(MCP_JSON_LIMIT).unwrap());
        let big = format!(r#"{{"mcpServers":{{}},"pad":"{pad}"}}"#);
        std::fs::write(proj.join(".agents/mcp.json"), big).unwrap();
        let d = inspect(&path).unwrap();
        assert_eq!(d.agents_mcp_servers, vec!["mcp.json"]);

        // 不存在，或 .agents 是文件：没有
        std::fs::remove_file(proj.join(".agents/mcp.json")).unwrap();
        let d = inspect(&path).unwrap();
        assert!(d.agents_mcp_servers.is_empty());
        std::fs::remove_dir_all(proj.join(".agents")).unwrap();
        std::fs::write(proj.join(".agents"), "file").unwrap();
        let d = inspect(&path).unwrap();
        assert!(d.agents_mcp_servers.is_empty());
    }

    #[test]
    fn inspect_lists_project_resources() {
        let root = temp_dir("inspect");
        let proj = root.join("proj");
        std::fs::create_dir_all(proj.join(".primus/extensions")).unwrap();
        std::fs::create_dir_all(proj.join(".primus/skills/review")).unwrap();
        std::fs::write(proj.join(".primus/extensions/guard.js"), "").unwrap();
        std::fs::write(proj.join(".primus/extensions/.hidden"), "").unwrap();
        std::fs::write(proj.join(".primus/skills/review/SKILL.md"), "").unwrap();
        std::fs::write(
            proj.join(".primus/mcp.json"),
            r#"{"mcpServers":{"github":{},"db":{}}}"#,
        )
        .unwrap();
        std::fs::write(proj.join("AGENTS.md"), "# 规则").unwrap();

        let d = inspect(&proj.to_string_lossy()).unwrap();
        assert_eq!(d.agents_md.as_deref(), Some("# 规则"));
        assert!(!d.agents_md_truncated);
        assert_eq!(d.extensions, vec!["guard.js"]);
        assert_eq!(d.skills, vec!["review"]);
        let mut mcp = d.mcp_servers.clone();
        mcp.sort();
        assert_eq!(mcp, vec!["db", "github"]);

        std::fs::write(proj.join(".primus/mcp.json"), "not json").unwrap();
        std::fs::write(proj.join("AGENTS.md"), "a".repeat(AGENTS_MD_LIMIT + 10)).unwrap();
        let d = inspect(&proj.to_string_lossy()).unwrap();
        assert_eq!(d.mcp_servers, vec!["mcp.json"]);
        assert!(d.agents_md_truncated);
        assert_eq!(d.agents_md.unwrap().len(), AGENTS_MD_LIMIT);

        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let d = inspect(&empty.to_string_lossy()).unwrap();
        assert_eq!(d.agents_md, None);
        assert!(d.extensions.is_empty() && d.skills.is_empty() && d.mcp_servers.is_empty());
        assert!(d.agents_mcp_servers.is_empty());
        assert!(inspect("relative/path").is_err());

        // AGENTS.md 是断开的符号链接：报错，不显示成“没有”
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(empty.join("missing.md"), empty.join("AGENTS.md")).unwrap();
            assert!(inspect(&empty.to_string_lossy()).is_err());
        }
    }

    #[test]
    fn trust_binds_to_the_exact_path() {
        let root = temp_dir("exact");
        let proj = root.join("Proj");
        std::fs::create_dir_all(&proj).unwrap();
        let path = proj.to_string_lossy().into_owned();
        let ws = Workspaces::new(&root.join("app"));
        ws.open(&path).unwrap();
        trust_now(&ws, &path);
        assert!(ws.approved(&path));
        // 末尾分隔符经规范化后仍是同一路径
        assert!(ws.approved(&format!("{path}/")));

        // 只差大小写的路径（在区分大小写的目录里是另一个目录）不沿用信任
        let other = root.join("proj");
        std::fs::create_dir_all(&other).unwrap();
        let other = other.to_string_lossy().into_owned();
        assert!(!ws.approved(&other));
        assert!(matches!(
            ws.trust(&other, false),
            Err(WorkspaceError::Unknown(_))
        ));
        // 打开它：无论是否同一个目录（不区分大小写的文件系统），都单独登记为未确认，原记录与信任保留
        ws.open(&other).unwrap();
        assert!(ws.approved(&path));
        assert!(!ws.approved(&other));
        assert_eq!(ws.list().unwrap().len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn special_files_do_not_block() {
        let root = temp_dir("fifo");
        let proj = root.join("proj");
        std::fs::create_dir_all(proj.join(".primus")).unwrap();
        let fifo = proj.join(".primus/pipe");
        let made = std::process::Command::new("mkfifo").arg(&fifo).status();
        if !made.is_ok_and(|s| s.success()) {
            return;
        }
        let path = proj.to_string_lossy().into_owned();
        assert!(inspect(&path).is_ok());

        std::fs::remove_file(&fifo).unwrap();
        let agents = proj.join("AGENTS.md");
        std::process::Command::new("mkfifo")
            .arg(&agents)
            .status()
            .unwrap();
        assert!(matches!(inspect(&path), Err(WorkspaceError::Read(..))));
    }

    #[test]
    fn oversized_manifest_is_an_error_and_deep_skills_are_listed() {
        let root = temp_dir("big");
        let proj = root.join("proj");
        let pkg = proj.join(".primus/extensions/huge");
        std::fs::create_dir_all(&pkg).unwrap();
        let mut deep = proj.join(".primus/skills");
        for i in 0..20 {
            deep = deep.join(format!("d{i}"));
        }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("SKILL.md"), "").unwrap();
        let path = proj.to_string_lossy().into_owned();
        assert_eq!(inspect(&path).unwrap().skills.len(), 1);

        std::fs::write(pkg.join("package.json"), vec![b' '; PACKAGE_JSON_LIMIT + 1]).unwrap();
        assert!(matches!(inspect(&path), Err(WorkspaceError::Read(..))));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_extensions_are_listed_without_looping() {
        let root = temp_dir("link");
        let proj = root.join("proj");
        let outside = root.join("outside");
        std::fs::create_dir_all(proj.join(".primus/extensions")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("index.js"), "one").unwrap();
        std::os::unix::fs::symlink(&outside, proj.join(".primus/extensions/ext")).unwrap();
        // 指回自身的链接不会无限递归
        std::os::unix::fs::symlink(proj.join(".primus"), proj.join(".primus/loop")).unwrap();
        let path = proj.to_string_lossy().into_owned();
        assert_eq!(inspect(&path).unwrap().extensions, vec!["ext"]);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_project_files_are_errors_not_absent() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_dir("noread");
        let proj = root.join("proj");
        std::fs::create_dir_all(proj.join(".primus/skills")).unwrap();
        let agents = proj.join("AGENTS.md");
        std::fs::write(&agents, "x").unwrap();
        std::fs::set_permissions(&agents, std::fs::Permissions::from_mode(0o000)).unwrap();
        // 以 root 运行时权限不起作用，跳过
        if std::fs::read(&agents).is_ok() {
            return;
        }
        assert!(matches!(
            inspect(&proj.to_string_lossy()),
            Err(WorkspaceError::Read(..))
        ));
        std::fs::set_permissions(&agents, std::fs::Permissions::from_mode(0o644)).unwrap();
        let skills = proj.join(".primus/skills");
        std::fs::set_permissions(&skills, std::fs::Permissions::from_mode(0o000)).unwrap();
        let d = inspect(&proj.to_string_lossy());
        std::fs::set_permissions(&skills, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(d, Err(WorkspaceError::Read(..))));
    }

    #[test]
    fn lists_only_what_core_loads() {
        let root = temp_dir("loads");
        let p = root.join("proj/.primus");
        let ext = p.join("extensions");
        std::fs::create_dir_all(ext.join("with-index")).unwrap();
        std::fs::create_dir_all(ext.join("with-pkg")).unwrap();
        std::fs::create_dir_all(ext.join("missing-entry")).unwrap();
        std::fs::write(ext.join("with-pkg/main.ts"), "").unwrap();
        std::fs::write(
            ext.join("missing-entry/package.json"),
            r#"{"pi":{"extensions":["./gone.ts"]}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(ext.join("empty-pkg")).unwrap();
        std::fs::create_dir_all(ext.join("plain-dir")).unwrap();
        std::fs::write(ext.join("a.ts"), "").unwrap();
        std::fs::write(ext.join("notes.txt"), "").unwrap();
        std::fs::write(ext.join("with-index/index.js"), "").unwrap();
        std::fs::write(
            ext.join("with-pkg/package.json"),
            r#"{"pi":{"extensions":["./main.ts"]}}"#,
        )
        .unwrap();
        std::fs::write(ext.join("empty-pkg/package.json"), r#"{"name":"x"}"#).unwrap();

        let sk = p.join("skills");
        std::fs::create_dir_all(sk.join("review")).unwrap();
        std::fs::create_dir_all(sk.join("group/deep/inner")).unwrap();
        std::fs::create_dir_all(sk.join("nothing")).unwrap();
        std::fs::create_dir_all(sk.join("node_modules/pkg")).unwrap();
        std::fs::write(sk.join("review/SKILL.md"), "").unwrap();
        std::fs::write(sk.join("review/extra.md"), "").unwrap();
        std::fs::write(sk.join("group/deep/inner/SKILL.md"), "").unwrap();
        std::fs::write(sk.join("group/readme.md"), "").unwrap();
        std::fs::write(sk.join("nothing/x.txt"), "").unwrap();
        std::fs::write(sk.join("node_modules/pkg/SKILL.md"), "").unwrap();
        std::fs::write(sk.join("top.md"), "").unwrap();
        std::fs::write(sk.join("data.json"), "").unwrap();

        let d = inspect(&root.join("proj").to_string_lossy()).unwrap();
        assert_eq!(d.extensions, vec!["a.ts", "with-index", "with-pkg"]);
        assert_eq!(d.skills, vec!["group/deep/inner", "review", "top.md"]);
    }

    #[test]
    fn missing_directories_are_hidden_and_corrupt_file_is_empty() {
        let root = temp_dir("hidden");
        let a = root.join("gone");
        std::fs::create_dir_all(&a).unwrap();
        let app = root.join("app");
        let ws = Workspaces::new(&app);
        ws.open(a.to_str().unwrap()).unwrap();
        std::fs::remove_dir_all(&a).unwrap();
        assert!(ws.list().unwrap().is_empty());
        std::fs::write(app.join("workspaces.json"), "{not json").unwrap();
        assert!(ws.list().unwrap().is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn recent_list_is_capped() {
        let root = temp_dir("cap");
        let ws = Workspaces::new(&root.join("app"));
        for i in 0..MAX_RECENT + 5 {
            let d = root.join(format!("d{i}"));
            std::fs::create_dir_all(&d).unwrap();
            ws.open(d.to_str().unwrap()).unwrap();
        }
        assert_eq!(ws.list().unwrap().len(), MAX_RECENT);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn display_name_handles_separators_and_roots() {
        assert_eq!(display_name(r"C:\Work\Proj"), "Proj");
        assert_eq!(display_name("/home/a/proj"), "proj");
        assert_eq!(display_name(r"C:\"), r"C:\");
        assert_eq!(display_name("/"), "/");
    }
}
