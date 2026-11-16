//! 能力中心·技能（ADR 0017）：列出、安装（GitHub 链接 / 本地 zip / 本地文件夹）、删除、启用与停用。
//!
//! - 列出：Core 的用户级技能目录 `<Core 用户目录>/skills` 与总会加载的 `~/.agents/skills`，按 agent-core 的发现规则
//!   （含 `SKILL.md` 的目录是一个技能且不再往下找；跳过 `.` 开头与 `node_modules`；跟随链接；`skills/` 根目录下
//!   直接的 `*.md` 各是一个技能，`.agents/skills` 反过来只认子目录里的 `*.md`）。技能文件内容交给前端解析 frontmatter。
//! - 安装：来源先解到暂存目录 `<数据目录>/tmp/skill-stage/<编号>`（zip 经 [`crate::skill_archive`]；文件夹逐个复制，
//!   不跟随、不复制链接；同样的数量与大小上限），列出其中的技能供选择，再整目录改名进 `<Core 用户目录>/skills/<名称>`。
//!   同名目录已存在时返回 [`SkillError::Exists`]，用户确认后覆盖（旧目录先移走，新目录就位后再删除）。
//! - 删除：只删 `<Core 用户目录>/skills` 的直接子项；是链接 / 目录联接时只删链接本身，不动目标。
//! - 启停：Core 设置 `settings.json` 的 `skills` 中的 `-<技能文件绝对路径>`（与 Core 的精确模式一致，
//!   路径用 `/`）；启用即删掉指向该技能的 `-` 精确模式。`!` 通配排除不改写，只按精确模式判断。

use std::collections::HashSet;
use std::fmt;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::skill_archive::{self, ArchiveError, MAX_ENTRIES, MAX_FILE_BYTES, MAX_TOTAL_BYTES};

/// 技能文件读给前端的最多字节数（frontmatter 在开头，足够解析）。
const SKILL_FILE_LIMIT: u64 = 64 * 1024;
/// 一次暂存最多列出的候选技能数。
const MAX_CANDIDATES: usize = 200;
/// 暂存目录保留时长：超过的在下次暂存时清理。
const STAGE_TTL: Duration = Duration::from_secs(60 * 60);
/// 暂存目录里选定的根目录名（zip 解压后去掉顶层目录、按链接取子目录后的位置）。
const STAGE_ROOT: &str = "root";
/// 技能目录名（安装时的目标名）最长的字符数。
const MAX_DIR_NAME: usize = 64;

/// 技能操作错误；`code` 供界面区分处理（覆盖确认），文案可直接显示。
#[derive(Debug)]
pub(crate) enum SkillError {
    /// 同名技能目录已存在，需要用户确认覆盖
    Exists(String),
    /// 参数不合法（名称、路径、暂存编号）
    Invalid(String),
    Archive(ArchiveError),
    Io(io::Error),
}

impl SkillError {
    pub(crate) fn code(&self) -> Option<&'static str> {
        matches!(self, Self::Exists(_)).then_some("exists")
    }
}

impl fmt::Display for SkillError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Exists(name) => write!(f, "已有同名技能“{name}”"),
            Self::Invalid(m) => f.write_str(m),
            Self::Archive(e) => e.fmt(f),
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

impl From<io::Error> for SkillError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<ArchiveError> for SkillError {
    fn from(e: ArchiveError) -> Self {
        Self::Archive(e)
    }
}

fn invalid(m: impl Into<String>) -> SkillError {
    SkillError::Invalid(m.into())
}

/// 技能的来源目录。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SkillScope {
    /// `<Core 用户目录>/skills`：能力中心安装的位置，可删除
    User,
    /// `~/.agents/skills`：其他工具共用的目录，只能启停
    Agents,
}

/// 列表中的一个技能。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillInfo {
    /// 技能文件所在目录的名字；frontmatter 没写 name 时 Core 用它
    pub(crate) dir_name: String,
    /// 技能文件（`SKILL.md` 或单个 `*.md`）的绝对路径
    pub(crate) file: String,
    /// 技能所在目录（Core 的 baseDir）
    pub(crate) dir: String,
    pub(crate) scope: SkillScope,
    /// 技能文件开头（最多 64 KiB），前端解析 frontmatter；读不了时为 None
    pub(crate) content: Option<String>,
    pub(crate) enabled: bool,
    /// 能否删除：用户目录下的直接子项
    pub(crate) deletable: bool,
    /// 目录（或单文件）本身是链接 / 目录联接
    pub(crate) link: bool,
}

/// 暂存目录里找到的一个候选技能。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillCandidate {
    /// 相对暂存根目录的路径（`/` 分隔）；根目录本身是技能时为空串
    pub(crate) path: String,
    /// 目录名（根目录为来源名，例如仓库名或压缩包名）
    pub(crate) dir_name: String,
    /// `SKILL.md` 开头（最多 64 KiB）
    pub(crate) content: String,
}

/// 一次暂存的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillStage {
    pub(crate) stage_id: String,
    pub(crate) candidates: Vec<SkillCandidate>,
    /// 跳过的符号链接数
    pub(crate) skipped_links: usize,
    /// 候选超过上限时只列出前 [`MAX_CANDIDATES`] 个
    pub(crate) truncated: bool,
}

/// Core 的发现方式（与 agent-core 的 `collectSkillEntries` 一致）。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// `skills/`：根目录下直接的 `*.md` 各是一个技能
    Core,
    /// `.agents/skills`：根目录下的 `*.md` 不算，子目录里（没有 `SKILL.md` 时）的 `*.md` 各是一个技能
    Agents,
}

/// 按 Core 的规则找出 `root` 下的技能文件（`SKILL.md` 或单个 `*.md`）。
fn discover(root: &Path, mode: Mode) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut visited = HashSet::new();
    walk(root, root, mode, &mut out, &mut visited);
    out
}

fn walk(dir: &Path, root: &Path, mode: Mode, out: &mut Vec<PathBuf>, visited: &mut HashSet<PathBuf>) {
    if let Ok(real) = dir.canonicalize()
        && !visited.insert(real)
    {
        return;
    }
    let skill = dir.join("SKILL.md");
    if skill.is_file() {
        out.push(skill);
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = read.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        // 跟随链接（Core 也跟随）；断开的链接跳过
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let md_counts = match mode {
            Mode::Core => dir == root,
            Mode::Agents => dir != root,
        };
        if meta.is_file() && md_counts && name.ends_with(".md") {
            out.push(path);
        } else if meta.is_dir() {
            walk(&path, root, mode, out, visited);
        }
    }
}

/// 读文件开头最多 `limit` 字节（按 UTF-8 宽松解码）。
fn read_head(path: &Path, limit: u64) -> Option<String> {
    let mut buf = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(limit)
        .read_to_end(&mut buf)
        .ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Core 比较精确模式用的路径形式：分隔符统一为 `/`。
fn posix(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// 技能的停用模式（写进 `settings.json` 的 `skills`）：`-<技能文件绝对路径>`。
pub(crate) fn disable_pattern(file: &Path) -> String {
    format!("-{}", posix(file))
}

/// `pattern`（去掉前缀后的精确模式）是否指向这个技能：与 Core 的 `matchesAnyExactPattern` 一致，
/// 相对 baseDir 的路径或绝对路径，`SKILL.md` 的技能也可写其目录。
fn matches_exact(pattern: &str, file: &Path, base_dir: &Path) -> bool {
    let p = pattern
        .strip_prefix("./")
        .or_else(|| pattern.strip_prefix(".\\"))
        .unwrap_or(pattern)
        .replace('\\', "/");
    let p = p.trim_end_matches('/');
    let rel = |x: &Path| x.strip_prefix(base_dir).ok().map(posix);
    let eq = |a: &str, b: &str| {
        if cfg!(windows) {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    let mut forms = vec![posix(file)];
    forms.extend(rel(file));
    if file.file_name().is_some_and(|n| n == "SKILL.md")
        && let Some(parent) = file.parent()
    {
        forms.push(posix(parent));
        forms.extend(rel(parent));
    }
    forms.iter().any(|f| eq(f, p))
}

/// `settings.json` 的 `skills` 里有没有停用这个技能的 `-` 精确模式。
fn is_disabled(settings: &Map<String, Value>, file: &Path, base_dir: &Path) -> bool {
    skill_patterns(settings).iter().any(|p| {
        p.strip_prefix('-')
            .is_some_and(|rest| matches_exact(rest, file, base_dir))
    })
}

fn skill_patterns(settings: &Map<String, Value>) -> Vec<String> {
    settings
        .get("skills")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// 改写 `settings` 的 `skills`：去掉指向该技能的 `-` 精确模式，停用时再加上 [`disable_pattern`]。返回是否有变化。
pub(crate) fn apply_enabled(
    settings: &mut Map<String, Value>,
    file: &Path,
    base_dir: &Path,
    enabled: bool,
) -> Result<bool, SkillError> {
    let original = settings.get("skills").cloned();
    let mut list = match settings.get("skills") {
        None => Vec::new(),
        Some(Value::Array(a)) => a.clone(),
        Some(_) => return Err(invalid("settings.json 的 skills 不是数组，未修改")),
    };
    list.retain(|v| {
        !v.as_str().is_some_and(|p| {
            p.strip_prefix('-')
                .is_some_and(|rest| matches_exact(rest, file, base_dir))
        })
    });
    if !enabled {
        list.push(Value::String(disable_pattern(file)));
    }
    if list.is_empty() && original.is_none() {
        return Ok(false);
    }
    let next = Value::Array(list);
    if original.as_ref() == Some(&next) {
        return Ok(false);
    }
    settings.insert("skills".into(), next);
    Ok(true)
}

/// Core 的用户主目录：与 Core 一致，优先 `HOME`，Windows 上再取 `USERPROFILE`。
pub(crate) fn home_dir() -> Option<PathBuf> {
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

/// 用户级技能目录。
pub(crate) fn user_skills_dir(core_dir: &Path) -> PathBuf {
    core_dir.join("skills")
}

fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| {
        m.file_type().is_symlink() || {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                // 目录联接（reparse point）
                m.file_attributes() & 0x400 != 0
            }
            #[cfg(not(windows))]
            {
                false
            }
        }
    })
}

/// 列出技能：用户级目录在前，`~/.agents/skills` 在后（与 Core 加载顺序一致）。
pub(crate) fn list(
    core_dir: &Path,
    home: Option<&Path>,
    settings: &Map<String, Value>,
) -> Vec<SkillInfo> {
    let user_root = user_skills_dir(core_dir);
    let mut roots = vec![(user_root.clone(), Mode::Core, SkillScope::User, core_dir.to_path_buf())];
    if let Some(home) = home {
        let agents = home.join(".agents");
        roots.push((agents.join("skills"), Mode::Agents, SkillScope::Agents, agents));
    }
    let mut out = Vec::new();
    for (root, mode, scope, base) in roots {
        for file in discover(&root, mode) {
            let is_skill_md = file.file_name().is_some_and(|n| n == "SKILL.md");
            let dir = if is_skill_md {
                file.parent().unwrap_or(&root).to_path_buf()
            } else {
                root.clone()
            };
            // 删除对象：用户目录下的直接子项（技能目录或单文件技能）
            let top = if is_skill_md { dir.clone() } else { file.clone() };
            let deletable = scope == SkillScope::User && top.parent() == Some(user_root.as_path());
            // frontmatter 没写 name 时 Core 用技能文件所在目录的名字
            let dir_name = file
                .parent()
                .and_then(Path::file_name)
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push(SkillInfo {
                dir_name,
                enabled: !is_disabled(settings, &file, &base),
                content: read_head(&file, SKILL_FILE_LIMIT),
                file: file.to_string_lossy().into_owned(),
                dir: dir.to_string_lossy().into_owned(),
                scope,
                deletable,
                link: is_link(&top),
            });
        }
    }
    out
}

/// 定位列表中的技能：`file` 必须是 [`list`] 会列出的技能文件之一。返回（技能文件，Core 的 baseDir，
/// 删除对象，范围）。
pub(crate) fn locate(
    core_dir: &Path,
    home: Option<&Path>,
    file: &str,
) -> Result<(PathBuf, PathBuf, PathBuf, SkillScope), SkillError> {
    let skills = list(core_dir, home, &Map::new());
    let found = skills
        .into_iter()
        .find(|s| s.file == file)
        .ok_or_else(|| invalid("找不到这个技能，可能已被删除"))?;
    let path = PathBuf::from(&found.file);
    let base = match found.scope {
        SkillScope::User => core_dir.to_path_buf(),
        SkillScope::Agents => home.map(|h| h.join(".agents")).unwrap_or_default(),
    };
    let top = if path.file_name().is_some_and(|n| n == "SKILL.md") {
        PathBuf::from(&found.dir)
    } else {
        path.clone()
    };
    Ok((path, base, top, found.scope))
}

/// 删除用户目录下的技能（目录或单文件）。链接 / 目录联接只删链接本身。
pub(crate) fn delete(core_dir: &Path, home: Option<&Path>, file: &str) -> Result<(), SkillError> {
    let (_, _, top, scope) = locate(core_dir, home, file)?;
    let root = user_skills_dir(core_dir);
    if scope != SkillScope::User || top.parent() != Some(root.as_path()) {
        return Err(invalid("只能删除能力中心安装的技能"));
    }
    remove_entry(&top)?;
    Ok(())
}

/// 删除一个目录项：链接 / 目录联接只删链接，普通目录整个删除（`remove_dir_all` 不跟随里面的链接）。
fn remove_entry(path: &Path) -> io::Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    if is_link(path) {
        // 指向目录的链接在 Windows 上要用 remove_dir 删，其他情况 remove_file
        return std::fs::remove_file(path).or_else(|_| std::fs::remove_dir(path));
    }
    if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

/// 暂存目录的根：`<数据目录>/tmp/skill-stage`。
pub(crate) fn stage_root(tmp_dir: &Path) -> PathBuf {
    tmp_dir.join("skill-stage")
}

fn new_stage(tmp_dir: &Path) -> io::Result<(String, PathBuf)> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let root = stage_root(tmp_dir);
    std::fs::create_dir_all(&root)?;
    // 清理过期的暂存（上次安装被取消或程序中途退出）
    if let Ok(read) = std::fs::read_dir(&root) {
        for e in read.flatten() {
            let old = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > STAGE_TTL);
            if old {
                let _ = remove_entry(&e.path());
            }
        }
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let id = format!(
        "{}-{nanos:x}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let dir = root.join(&id);
    std::fs::create_dir(&dir)?;
    Ok((id, dir))
}

/// 暂存编号只能是 [`new_stage`] 生成的形式，防止拼出其他路径。
fn stage_dir(tmp_dir: &Path, id: &str) -> Result<PathBuf, SkillError> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !ok {
        return Err(invalid("暂存编号无效"));
    }
    let dir = stage_root(tmp_dir).join(id);
    if !dir.is_dir() {
        return Err(invalid("暂存的内容已过期，请重新选择来源"));
    }
    Ok(dir)
}

/// 放弃一次暂存。
pub(crate) fn discard(tmp_dir: &Path, id: &str) -> Result<(), SkillError> {
    let dir = stage_dir(tmp_dir, id)?;
    remove_entry(&dir)?;
    Ok(())
}

/// 暂存 zip 数据：解到新暂存目录的 `content/`，`label` 为来源名（仓库名或压缩包文件名），`subdir` 为只取的子目录
/// （GitHub 链接里的 tree / blob 路径，相对去掉顶层目录后的根）。
pub(crate) fn stage_zip(
    tmp_dir: &Path,
    data: &[u8],
    label: &str,
    subdir: Option<&str>,
) -> Result<SkillStage, SkillError> {
    let (id, dir) = new_stage(tmp_dir)?;
    let content = dir.join("content");
    let result = (|| {
        std::fs::create_dir(&content)?;
        let extracted = skill_archive::extract_zip(data, &content)?;
        let root = single_top_dir(&content).unwrap_or_else(|| content.clone());
        let root = match subdir.filter(|s| !s.is_empty()) {
            Some(sub) => {
                let parts = skill_archive::safe_parts(sub)
                    .ok_or_else(|| invalid("链接中的目录路径无效"))?;
                let mut p = root.clone();
                p.extend(parts);
                if !p.is_dir() {
                    return Err(invalid(format!("仓库中没有目录 {sub}")));
                }
                p
            }
            None => root,
        };
        // 选定的根目录移到 <暂存>/root：安装时从这里按候选路径取
        let staged = dir.join(STAGE_ROOT);
        std::fs::rename(&root, &staged)?;
        // 链接指定了子目录时，根目录就是技能的话以子目录名作默认名称
        let label = subdir
            .and_then(|s| s.rsplit('/').find(|p| !p.is_empty()))
            .unwrap_or(label);
        finish_stage(&id, &staged, label, extracted.skipped_links)
    })();
    if result.is_err() {
        let _ = remove_entry(&dir);
    }
    result
}

/// 暂存本地 zip 文件。
pub(crate) fn stage_zip_file(tmp_dir: &Path, path: &Path) -> Result<SkillStage, SkillError> {
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(invalid("请选择一个 .zip 文件"));
    }
    if meta.len() > skill_archive::MAX_ARCHIVE_BYTES {
        return Err(SkillError::Archive(ArchiveError::TooLarge(format!(
            "压缩包超过 {} MiB",
            skill_archive::MAX_ARCHIVE_BYTES / 1024 / 1024
        ))));
    }
    let data = std::fs::read(path)?;
    let label = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    stage_zip(tmp_dir, &data, &label, None)
}

/// 暂存本地文件夹：逐个复制普通文件（不跟随、不复制链接），跳过 `.git`；数量与大小上限同 zip。
pub(crate) fn stage_folder(tmp_dir: &Path, src: &Path) -> Result<SkillStage, SkillError> {
    if !std::fs::metadata(src)?.is_dir() {
        return Err(invalid("请选择一个文件夹"));
    }
    let (id, dir) = new_stage(tmp_dir)?;
    let content = dir.join(STAGE_ROOT);
    let result = (|| {
        let mut budget = Budget::default();
        copy_tree(src, &content, &mut budget)?;
        let label = src
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        finish_stage(&id, &content, &label, budget.skipped_links)
    })();
    if result.is_err() {
        let _ = remove_entry(&dir);
    }
    result
}

#[derive(Default)]
struct Budget {
    entries: usize,
    bytes: u64,
    skipped_links: usize,
}

fn too_large(m: String) -> SkillError {
    SkillError::Archive(ArchiveError::TooLarge(m))
}

fn copy_tree(src: &Path, dest: &Path, budget: &mut Budget) -> Result<(), SkillError> {
    std::fs::create_dir(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        budget.entries += 1;
        if budget.entries > MAX_ENTRIES {
            return Err(too_large(format!("文件超过 {MAX_ENTRIES} 个")));
        }
        let path = entry.path();
        let target = dest.join(&name);
        if is_link(&path) {
            budget.skipped_links += 1;
            continue;
        }
        let meta = std::fs::symlink_metadata(&path)?;
        if meta.is_dir() {
            copy_tree(&path, &target, budget)?;
        } else if meta.is_file() {
            if meta.len() > MAX_FILE_BYTES {
                return Err(too_large(format!(
                    "{} 超过 {} MiB",
                    name.to_string_lossy(),
                    MAX_FILE_BYTES / 1024 / 1024
                )));
            }
            budget.bytes += meta.len();
            if budget.bytes > MAX_TOTAL_BYTES {
                return Err(too_large(format!(
                    "合计超过 {} MiB",
                    MAX_TOTAL_BYTES / 1024 / 1024
                )));
            }
            let mut from = std::fs::File::open(&path)?;
            let mut to = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)?;
            io::copy(&mut from, &mut to)?;
        }
    }
    Ok(())
}

/// 解压后只有一个顶层目录（GitHub 的 `<仓库>-<分支>/`）时返回它。
fn single_top_dir(dir: &Path) -> Option<PathBuf> {
    let mut entries = std::fs::read_dir(dir).ok()?.flatten();
    let first = entries.next()?;
    if entries.next().is_some() || !first.file_type().ok()?.is_dir() {
        return None;
    }
    Some(first.path())
}

/// 在暂存根目录里找技能，组成暂存结果；一个都没有时报错（暂存目录由调用方删除）。
fn finish_stage(
    id: &str,
    root: &Path,
    label: &str,
    skipped_links: usize,
) -> Result<SkillStage, SkillError> {
    // 安装的是整个技能目录：只认带 SKILL.md 的目录（单个 *.md 技能没有目录可装）
    let mut candidates = Vec::new();
    let mut truncated = false;
    for file in discover(root, Mode::Agents) {
        if file.file_name().is_none_or(|n| n != "SKILL.md") {
            continue;
        }
        let Some(dir) = file.parent() else { continue };
        if candidates.len() >= MAX_CANDIDATES {
            truncated = true;
            break;
        }
        let rel = dir
            .strip_prefix(root)
            .map(posix)
            .unwrap_or_default();
        let dir_name = if rel.is_empty() {
            label.to_owned()
        } else {
            dir.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        };
        candidates.push(SkillCandidate {
            path: rel,
            dir_name,
            content: read_head(&file, SKILL_FILE_LIMIT).unwrap_or_default(),
        });
    }
    if candidates.is_empty() {
        return Err(invalid("没有找到技能：需要包含 SKILL.md 的文件夹"));
    }
    Ok(SkillStage {
        stage_id: id.to_owned(),
        candidates,
        skipped_links,
        truncated,
    })
}

/// 安装后的目录名：字母、数字、`-`、`_`、`.`，不以 `.` 开头，最长 64 个字符，不是 Windows 保留名。
pub(crate) fn valid_dir_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_DIR_NAME
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && skill_archive::safe_parts(name).is_some_and(|p| p.len() == 1)
}

/// 把暂存里的候选技能装进用户目录 `<Core 用户目录>/skills/<name>`。`overwrite` 为假且目标已存在时返回
/// [`SkillError::Exists`]。成功后删除这次暂存，返回技能文件路径。
pub(crate) fn install(
    core_dir: &Path,
    tmp_dir: &Path,
    stage_id: &str,
    path: &str,
    name: &str,
    overwrite: bool,
) -> Result<PathBuf, SkillError> {
    if !valid_dir_name(name) {
        return Err(invalid("技能名称只能包含字母、数字、-、_ 和 .，且不超过 64 个字符"));
    }
    let stage = stage_dir(tmp_dir, stage_id)?;
    let base = stage.join(STAGE_ROOT);
    // 候选路径必须是 finish_stage 列出的：在暂存根目录内、带 SKILL.md
    let source = if path.is_empty() {
        base.clone()
    } else {
        let parts = skill_archive::safe_parts(path).ok_or_else(|| invalid("技能路径无效"))?;
        let mut p = base.clone();
        p.extend(parts);
        p
    };
    if is_link(&source) || !source.join("SKILL.md").is_file() {
        return Err(invalid("暂存中没有这个技能"));
    }
    let root = user_skills_dir(core_dir);
    std::fs::create_dir_all(&root)?;
    let target = root.join(name);
    let exists = std::fs::symlink_metadata(&target).is_ok();
    if exists && !overwrite {
        return Err(SkillError::Exists(name.to_owned()));
    }
    // 先把新目录移到用户目录旁的临时名，再换下旧目录，失败时尽量还原
    let incoming = root.join(format!(".{name}.installing-{stage_id}"));
    move_dir(&source, &incoming)?;
    let old = root.join(format!(".{name}.replaced-{stage_id}"));
    if exists && let Err(e) = std::fs::rename(&target, &old) {
        let _ = remove_entry(&incoming);
        return Err(e.into());
    }
    if let Err(e) = std::fs::rename(&incoming, &target) {
        if exists {
            let _ = std::fs::rename(&old, &target);
        }
        let _ = remove_entry(&incoming);
        return Err(e.into());
    }
    if exists {
        let _ = remove_entry(&old);
    }
    let _ = remove_entry(&stage);
    Ok(target.join("SKILL.md"))
}

/// 移动目录：同一卷上直接改名，否则复制后删除源目录。
fn move_dir(from: &Path, to: &Path) -> Result<(), SkillError> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    let mut budget = Budget::default();
    copy_tree(from, to, &mut budget)?;
    let _ = remove_entry(from);
    Ok(())
}

/// 解析 GitHub 链接：`https://github.com/<owner>/<repo>[.git]`、`…/tree/<ref>/<目录>`、`…/blob/<ref>/<目录>/SKILL.md`。
/// 返回（owner，repo，ref，子目录）。ref 只取一段（含 `/` 的分支名请用链接里能区分的写法，见 ADR 0017）。
pub(crate) fn parse_github_url(
    url: &str,
) -> Result<(String, String, Option<String>, Option<String>), SkillError> {
    let bad = || invalid("请输入 GitHub 仓库链接，例如 https://github.com/owner/repo");
    let rest = url
        .trim()
        .strip_prefix("https://github.com/")
        .or_else(|| url.trim().strip_prefix("https://www.github.com/"))
        .ok_or_else(bad)?;
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
    let segment_ok = |s: &str| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    let (owner, repo) = match parts.as_slice() {
        [o, r, ..] => (*o, r.strip_suffix(".git").unwrap_or(r)),
        _ => return Err(bad()),
    };
    if !segment_ok(owner) || !segment_ok(repo) {
        return Err(bad());
    }
    let (reference, sub) = match parts.get(2..) {
        None | Some([]) => (None, None),
        Some([kind, r, tail @ ..]) if *kind == "tree" || *kind == "blob" => {
            let mut tail: Vec<&str> = tail.to_vec();
            if *kind == "blob" {
                // 指向文件（通常是 SKILL.md）：取它所在的目录
                tail.pop();
            }
            let decoded: Vec<String> = tail.iter().map(|s| percent_decode(s)).collect();
            let sub = (!decoded.is_empty()).then(|| decoded.join("/"));
            if let Some(s) = &sub
                && skill_archive::safe_parts(s).is_none()
            {
                return Err(bad());
            }
            let r = percent_decode(r);
            if r.is_empty() || r.chars().any(|c| c.is_control() || c == '\\' || c == ' ') {
                return Err(bad());
            }
            (Some(r), sub)
        }
        _ => return Err(bad()),
    };
    Ok((owner.to_owned(), repo.to_owned(), reference, sub))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(h), Some(l)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            )
        {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// GitHub 仓库压缩包的下载地址（codeload，ref 缺省为默认分支 `HEAD`）。
pub(crate) fn codeload_url(owner: &str, repo: &str, reference: Option<&str>) -> String {
    let r = reference.unwrap_or("HEAD");
    let enc: String = r
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("https://codeload.github.com/{owner}/{repo}/zip/{enc}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill_archive::tests::{ZipBuilder, temp};

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    const SKILL: &str = "---\nname: demo\ndescription: d\n---\nbody";

    #[test]
    fn lists_user_and_agents_skills_by_core_rules() {
        let root = temp("list");
        let core = root.join("core");
        let home = root.join("home");
        write(&core.join("skills/review/SKILL.md"), SKILL);
        write(&core.join("skills/review/nested/SKILL.md"), SKILL);
        write(&core.join("skills/single.md"), SKILL);
        write(&core.join("skills/group/inner/SKILL.md"), SKILL);
        write(&core.join("skills/group/notes.md"), "not a skill");
        write(&core.join("skills/.hidden/SKILL.md"), SKILL);
        write(&core.join("skills/node_modules/x/SKILL.md"), SKILL);
        write(&home.join(".agents/skills/lint/SKILL.md"), SKILL);
        write(&home.join(".agents/skills/root.md"), "not a skill");
        write(&home.join(".agents/skills/sub/extra.md"), SKILL);
        let mut settings = Map::new();
        settings.insert(
            "skills".into(),
            serde_json::json!([disable_pattern(&core.join("skills/single.md"))]),
        );
        let list = list(&core, Some(&home), &settings);
        let names: Vec<_> = list
            .iter()
            .map(|s| (s.dir_name.as_str(), s.scope, s.enabled, s.deletable))
            .collect();
        assert_eq!(
            names,
            vec![
                ("inner", SkillScope::User, true, false),
                ("review", SkillScope::User, true, true),
                ("skills", SkillScope::User, false, true),
                ("lint", SkillScope::Agents, true, false),
                ("sub", SkillScope::Agents, true, false),
            ]
        );
        assert_eq!(list[1].content.as_deref(), Some(SKILL));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn enable_disable_patterns_follow_core_exact_matching() {
        let core = PathBuf::from("/data/core");
        let file = core.join("skills/review/SKILL.md");
        let mut s = Map::new();
        assert!(apply_enabled(&mut s, &file, &core, false).unwrap());
        assert_eq!(s["skills"], serde_json::json!(["-/data/core/skills/review/SKILL.md"]));
        assert!(is_disabled(&s, &file, &core));
        assert!(!apply_enabled(&mut s, &file, &core, false).unwrap());
        // 其他写法（相对路径、目录）也认，启用时一并删掉；其他条目保留
        s.insert(
            "skills".into(),
            serde_json::json!(["-skills/review", "./extra", "-./skills/review/SKILL.md", "!x/*"]),
        );
        assert!(is_disabled(&s, &file, &core));
        assert!(apply_enabled(&mut s, &file, &core, true).unwrap());
        assert_eq!(s["skills"], serde_json::json!(["./extra", "!x/*"]));
        assert!(!is_disabled(&s, &file, &core));
        // 别的技能的模式不影响
        let other = core.join("skills/reviewer/SKILL.md");
        s.insert("skills".into(), serde_json::json!(["-skills/reviewer"]));
        assert!(!is_disabled(&s, &file, &core));
        assert!(is_disabled(&s, &other, &core));
        // skills 不是数组：不改
        s.insert("skills".into(), serde_json::json!("x"));
        assert!(apply_enabled(&mut s, &file, &core, false).is_err());
    }

    #[test]
    fn installs_from_zip_with_conflict_confirmation() {
        let root = temp("install");
        let core = root.join("core");
        let tmp = root.join("tmp");
        let zip = ZipBuilder::new()
            .file("skills-main/README.md", "readme")
            .file("skills-main/a/SKILL.md", SKILL)
            .file("skills-main/a/scripts/run.ps1", "x")
            .file("skills-main/b/c/SKILL.md", SKILL)
            .finish();
        let stage = stage_zip(&tmp, &zip, "skills", None).unwrap();
        let paths: Vec<_> = stage.candidates.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, ["a", "b/c"]);
        assert_eq!(stage.candidates[1].dir_name, "c");
        let file = install(&core, &tmp, &stage.stage_id, "a", "demo", false).unwrap();
        assert_eq!(file, core.join("skills/demo/SKILL.md"));
        assert!(core.join("skills/demo/scripts/run.ps1").is_file());
        // 安装后暂存删除
        assert!(install(&core, &tmp, &stage.stage_id, "b/c", "c", false).is_err());

        let stage = stage_zip(&tmp, &zip, "skills", None).unwrap();
        let err = install(&core, &tmp, &stage.stage_id, "b/c", "demo", false).unwrap_err();
        assert_eq!(err.code(), Some("exists"));
        install(&core, &tmp, &stage.stage_id, "b/c", "demo", true).unwrap();
        assert!(!core.join("skills/demo/scripts").exists(), "覆盖后是新内容");
        let leftovers: Vec<_> = std::fs::read_dir(core.join("skills"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(leftovers, ["demo"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn github_subdirectory_and_root_skill() {
        let root = temp("gh");
        let tmp = root.join("tmp");
        let zip = ZipBuilder::new()
            .file("repo-main/skills/pdf/SKILL.md", SKILL)
            .file("repo-main/skills/doc/SKILL.md", SKILL)
            .finish();
        let stage = stage_zip(&tmp, &zip, "repo", Some("skills/pdf")).unwrap();
        assert_eq!(stage.candidates.len(), 1);
        assert_eq!(stage.candidates[0].path, "");
        assert_eq!(stage.candidates[0].dir_name, "pdf");
        discard(&tmp, &stage.stage_id).unwrap();
        assert!(discard(&tmp, &stage.stage_id).is_err());
        assert!(discard(&tmp, "../x").is_err());
        assert!(stage_zip(&tmp, &zip, "repo", Some("skills/none")).is_err());
        let single = ZipBuilder::new().file("x-main/SKILL.md", SKILL).finish();
        let stage = stage_zip(&tmp, &single, "x", None).unwrap();
        assert_eq!(stage.candidates[0].path, "");
        let core = root.join("core");
        install(&core, &tmp, &stage.stage_id, "", "x", false).unwrap();
        assert!(core.join("skills/x/SKILL.md").is_file());
        // 没有技能：报错并删除暂存
        let none = ZipBuilder::new().file("a/readme.md", "x").finish();
        assert!(stage_zip(&tmp, &none, "a", None).is_err());
        let left = std::fs::read_dir(stage_root(&tmp)).unwrap().count();
        assert_eq!(left, 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_copy_skips_links_and_git() {
        let root = temp("folder");
        let src = root.join("src");
        write(&src.join("SKILL.md"), SKILL);
        write(&src.join(".git/config"), "x");
        write(&src.join("ref/a.md"), "a");
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", src.join("etc-link")).unwrap();
        let tmp = root.join("tmp");
        let stage = stage_folder(&tmp, &src).unwrap();
        assert_eq!(stage.candidates[0].dir_name, "src");
        let staged = stage_root(&tmp).join(&stage.stage_id).join(STAGE_ROOT);
        assert!(staged.join("ref/a.md").is_file());
        assert!(!staged.join(".git").exists());
        assert!(std::fs::symlink_metadata(staged.join("etc-link")).is_err());
        if cfg!(unix) {
            assert_eq!(stage.skipped_links, 1);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_only_user_skills_and_links_not_targets() {
        let root = temp("delete");
        let core = root.join("core");
        let home = root.join("home");
        write(&core.join("skills/a/SKILL.md"), SKILL);
        write(&core.join("skills/g/inner/SKILL.md"), SKILL);
        write(&home.join(".agents/skills/b/SKILL.md"), SKILL);
        let target = root.join("elsewhere");
        write(&target.join("SKILL.md"), SKILL);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, core.join("skills/linked")).unwrap();
        let file = |p: &Path| p.to_string_lossy().into_owned();
        assert!(delete(&core, Some(&home), &file(&home.join(".agents/skills/b/SKILL.md"))).is_err());
        assert!(delete(&core, Some(&home), &file(&core.join("skills/g/inner/SKILL.md"))).is_err());
        assert!(delete(&core, Some(&home), &file(&core.join("skills/../x/SKILL.md"))).is_err());
        delete(&core, Some(&home), &file(&core.join("skills/a/SKILL.md"))).unwrap();
        assert!(!core.join("skills/a").exists());
        #[cfg(unix)]
        {
            delete(&core, Some(&home), &file(&core.join("skills/linked/SKILL.md"))).unwrap();
            assert!(target.join("SKILL.md").is_file(), "只删链接，不动目标");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn github_urls() {
        let p = |u: &str| parse_github_url(u).ok();
        assert_eq!(
            p("https://github.com/o/r"),
            Some(("o".into(), "r".into(), None, None))
        );
        assert_eq!(
            p("https://github.com/o/r.git"),
            Some(("o".into(), "r".into(), None, None))
        );
        assert_eq!(
            p("https://github.com/o/r/tree/main/skills/pdf"),
            Some(("o".into(), "r".into(), Some("main".into()), Some("skills/pdf".into())))
        );
        assert_eq!(
            p("https://github.com/o/r/blob/v1/skills/pdf/SKILL.md?plain=1"),
            Some(("o".into(), "r".into(), Some("v1".into()), Some("skills/pdf".into())))
        );
        for bad in [
            "http://github.com/o/r",
            "https://gitlab.com/o/r",
            "https://github.com/o",
            "https://github.com/o/r/issues/1",
            "https://github.com/o/r/tree/main/../x",
            "https://github.com/../r",
            "https://github.com.evil.com/o/r",
        ] {
            assert_eq!(p(bad), None, "{bad}");
        }
        assert_eq!(
            codeload_url("o", "r", None),
            "https://codeload.github.com/o/r/zip/HEAD"
        );
        assert_eq!(
            codeload_url("o", "r", Some("feat x")),
            "https://codeload.github.com/o/r/zip/feat%20x"
        );
    }

    #[test]
    fn dir_names() {
        for ok in ["pdf", "my-skill_2", "a.b"] {
            assert!(valid_dir_name(ok), "{ok}");
        }
        for bad in ["", ".hidden", "a/b", "a\\b", "..", "con", "名字", "a b", &"x".repeat(65)] {
            assert!(!valid_dir_name(bad), "{bad}");
        }
    }
}
