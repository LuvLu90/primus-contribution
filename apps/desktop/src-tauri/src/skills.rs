//! 能力中心·技能（ADR 0017）：列出、安装（GitHub 链接 / 本地 zip / 本地文件夹）、删除、启用与停用。
//!
//! - 发现规则与 Core 相同，见 [`crate::skill_discovery`]（含 `SKILL.md` 的目录是一个技能且不再往下找；跳过 `.` 开头
//!   与 `node_modules`；跟随链接；读 `.gitignore` / `.ignore` / `.fdignore`；`skills/` 根目录下直接的 `*.md` 各是
//!   一个技能，`.agents/skills` 反过来只认子目录里的 `*.md`）。技能文件内容交给前端解析 frontmatter。
//! - 安装：来源先解到暂存目录 `<数据目录>/tmp/skill-stage/<编号>`（zip 经 [`crate::skill_archive`]；文件夹逐个复制，
//!   不跟随、不复制链接；同样的数量与大小上限），按 Core 加载 `skills/<名称>/` 的方式列出其中的全部技能，再把整个
//!   来源目录改名进 `<Core 用户目录>/skills/<名称>`：一个仓库 / 压缩包 / 文件夹里有几个技能，Core 就加载几个，
//!   与把它直接放进 `skills/` 相同。同名目录已存在时返回 [`SkillError::Exists`]，用户确认后覆盖（旧目录先移走，
//!   新目录就位后再删除）。
//! - 删除：只删 `<Core 用户目录>/skills` 里的技能（技能目录，或根目录下的单个 `*.md`）；是链接 / 目录联接时只删
//!   链接本身，不动目标；路径中间经过链接的不能删。删掉的是它所在顶层目录里最后一个技能时，顶层目录一并删除。
//! - 启停：Core 设置 `settings.json` 的 `skills` 中的 `-<技能文件绝对路径>`（与 Core 的精确模式一致，
//!   路径用 `/`）；启用即删掉指向该技能的 `-` 精确模式。`!` 通配排除不改写，只按精确模式判断。

use std::collections::HashSet;
use std::fmt;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::skill_archive::{self, ArchiveError, MAX_ENTRIES, MAX_FILE_BYTES, MAX_TOTAL_BYTES};
use crate::skill_discovery::{self, Mode};

/// 技能文件读给前端的最多字节数（frontmatter 在开头，足够解析）。
const SKILL_FILE_LIMIT: u64 = 64 * 1024;
/// 一次暂存最多列出的候选技能数。
const MAX_CANDIDATES: usize = 200;
/// 暂存目录保留时长：超过的在下次暂存时清理。
const STAGE_TTL: Duration = Duration::from_secs(60 * 60);
/// 暂存目录里选定的根目录名（zip 解压后去掉顶层目录、按链接取子目录后的位置）。
const STAGE_ROOT: &str = "root";
/// 暂存目录里的作废标记：替换失败后新来源没能完整放回暂存，这次暂存不能再用来安装。
const STAGE_BROKEN: &str = "broken";
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
    /// 能否删除：用户目录里的技能，且路径中间没有经过链接
    pub(crate) deletable: bool,
    /// 技能目录（或单文件）本身是链接 / 目录联接
    pub(crate) link: bool,
    /// 技能不是用户目录的直接子项时，它所在的顶层目录名（一次安装的仓库 / 压缩包 / 文件夹）
    pub(crate) package: Option<String>,
}

/// 暂存目录里找到的一个技能（安装时与其余技能一起装入）。
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
    /// 来源名（仓库名、链接里的子目录名、压缩包或文件夹名），界面据此建议安装目录名
    pub(crate) label: String,
    pub(crate) candidates: Vec<SkillCandidate>,
    /// 跳过的符号链接数
    pub(crate) skipped_links: usize,
    /// 候选超过上限时只列出前 [`MAX_CANDIDATES`] 个
    pub(crate) truncated: bool,
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

/// 技能的删除对象：`SKILL.md` 的技能是它所在的目录，单个 `*.md` 的技能是文件本身。
fn skill_target(file: &Path) -> PathBuf {
    if file.file_name().is_some_and(|n| n == "SKILL.md") {
        file.parent().unwrap_or(file).to_path_buf()
    } else {
        file.to_path_buf()
    }
}

/// `target` 在 `root` 里的位置：返回（顶层目录项，中间是否经过链接）。`target` 不在 `root` 里或就是 `root` 时为 None。
fn placement(root: &Path, target: &Path) -> Option<(PathBuf, bool)> {
    let rel = target.strip_prefix(root).ok()?;
    let mut parts = rel.components();
    let top = root.join(parts.next()?);
    // 顶层与目标之间的各级（不含目标本身）
    let mut cur = top.clone();
    let mut through_link = false;
    let rest: Vec<_> = parts.collect();
    if !rest.is_empty() {
        through_link |= is_link(&cur);
        for c in &rest[..rest.len() - 1] {
            cur.push(c);
            through_link |= is_link(&cur);
        }
    }
    Some((top, through_link))
}

/// 列出技能：用户级目录在前，`~/.agents/skills` 在后（与 Core 加载顺序一致）。
pub(crate) fn list(
    core_dir: &Path,
    home: Option<&Path>,
    settings: &Map<String, Value>,
) -> Vec<SkillInfo> {
    let user_root = user_skills_dir(core_dir);
    let mut roots = vec![(
        user_root.clone(),
        Mode::Core,
        SkillScope::User,
        core_dir.to_path_buf(),
    )];
    if let Some(home) = home {
        let agents = home.join(".agents");
        roots.push((
            agents.join("skills"),
            Mode::Agents,
            SkillScope::Agents,
            agents,
        ));
    }
    let mut out = Vec::new();
    // 同一个文件（经链接从多处找到）只列第一次找到的那一处，启停也按那一处算，与 Core 一致：Core 给每条发现路径
    // 各算启停（`addResource`），随后 `toResolvedPaths` 按真实路径去重——保留先登记的、不看启停——之后才
    // `filter((r) => r.enabled)`（`resource-loader.ts`）。所以先登记的路径被停用时，同一文件的其他路径也不会加载；
    // 列表若把其他路径显示为“已启用”，反而与 Core 实际加载的不符
    let mut seen = std::collections::HashSet::new();
    for (root, mode, scope, base) in roots {
        for file in skill_discovery::collect(&root, mode) {
            if let Ok(real) = file.canonicalize()
                && !seen.insert(real)
            {
                continue;
            }
            // Core 的 baseDir：技能文件所在目录
            let dir = file.parent().unwrap_or(&root).to_path_buf();
            let target = skill_target(&file);
            let placed = placement(&root, &target);
            let deletable =
                scope == SkillScope::User && placed.as_ref().is_some_and(|(_, link)| !link);
            let package = placed
                .as_ref()
                .filter(|(top, _)| scope == SkillScope::User && *top != target)
                .and_then(|(top, _)| top.file_name())
                .map(|n| n.to_string_lossy().into_owned());
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
                link: is_link(&target),
                package,
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
        // 按路径比较而不是按字符串：Windows 上 `/` 与 `\` 同为分隔符，界面或调用方拼出的路径分隔符可能与列表不同
        .find(|s| Path::new(&s.file) == Path::new(file))
        .ok_or_else(|| invalid("找不到这个技能，可能已被删除"))?;
    let path = PathBuf::from(&found.file);
    let base = match found.scope {
        SkillScope::User => core_dir.to_path_buf(),
        SkillScope::Agents => home.map(|h| h.join(".agents")).unwrap_or_default(),
    };
    let target = skill_target(&path);
    Ok((path, base, target, found.scope))
}

/// 删除用户目录里的技能（技能目录或单文件）。链接 / 目录联接只删链接本身；路径中间经过链接的不删。
/// 删掉的是所在顶层目录里最后一个技能时，顶层目录一并删除（安装时整个装进来的仓库 / 压缩包 / 文件夹）。
pub(crate) fn delete(core_dir: &Path, home: Option<&Path>, file: &str) -> Result<(), SkillError> {
    let (_, _, target, scope) = locate(core_dir, home, file)?;
    let root = user_skills_dir(core_dir);
    let placed = placement(&root, &target);
    let Some((top, false)) = placed.filter(|_| scope == SkillScope::User) else {
        return Err(invalid("只能删除能力中心技能目录里的技能"));
    };
    remove_entry(&target)?;
    if top != target && top.is_dir() && !is_link(&top) {
        // 扫描须完整：读不全时不能断定“没有剩余技能”，保留顶层目录。按发现规则逐条路径看（不按真实路径去重），
        // 别处经链接指向这里的技能不会让这里的技能被漏看
        let remaining = skill_discovery::collect_complete(&root, Mode::Core)
            .map(|files| files.iter().any(|f| f.starts_with(&top)))
            .unwrap_or(true);
        if !remaining {
            remove_entry(&top)?;
        }
    }
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

/// 本进程内已作废的暂存编号。作废以它为准：只靠暂存目录里的 `broken` 标记时，标记没写成、复制了一半的
/// 暂存又没删掉，后续安装就可能拿不完整的暂存再装一次。标记只是给日志和排查看的辅助。
static RETIRED_STAGES: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

fn retire_stage(id: &str) {
    RETIRED_STAGES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(id.to_owned());
}

fn stage_retired(id: &str) -> bool {
    RETIRED_STAGES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(id)
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

/// 按 Core 加载 `skills/<名称>/` 的方式在暂存根目录里找技能，组成暂存结果；一个都没有时报错（暂存目录由调用方删除）。
fn finish_stage(
    id: &str,
    root: &Path,
    label: &str,
    skipped_links: usize,
) -> Result<SkillStage, SkillError> {
    let mut candidates = Vec::new();
    let mut truncated = false;
    for file in skill_discovery::collect_as_installed(root) {
        let Some(dir) = file.parent() else { continue };
        if candidates.len() >= MAX_CANDIDATES {
            truncated = true;
            break;
        }
        let rel = dir.strip_prefix(root).map(posix).unwrap_or_default();
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
        label: label.to_owned(),
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

/// 把暂存的整个来源目录装进用户目录 `<Core 用户目录>/skills/<name>`：其中的技能 Core 全部按自己的规则加载。
/// `overwrite` 为假且目标已存在时返回 [`SkillError::Exists`]。成功后删除这次暂存，返回安装后的目录。
pub(crate) fn install(
    core_dir: &Path,
    tmp_dir: &Path,
    stage_id: &str,
    name: &str,
    overwrite: bool,
) -> Result<PathBuf, SkillError> {
    if !valid_dir_name(name) {
        return Err(invalid(
            "技能名称只能包含字母、数字、-、_ 和 .，且不超过 64 个字符",
        ));
    }
    // 先查进程内的作废记录，不依赖任何文件操作是否成功
    if stage_retired(stage_id) {
        return Err(invalid("这次暂存已不完整，不能再安装，请重新选择来源"));
    }
    let stage = stage_dir(tmp_dir, stage_id)?;
    if stage.join(STAGE_BROKEN).exists() {
        return Err(invalid("这次暂存已不完整，不能再安装，请重新选择来源"));
    }
    let source = stage.join(STAGE_ROOT);
    if is_link(&source) || skill_discovery::collect_as_installed(&source).is_empty() {
        return Err(invalid("暂存中没有技能"));
    }
    let root = user_skills_dir(core_dir);
    std::fs::create_dir_all(&root)?;
    let target = root.join(name);
    let exists = std::fs::symlink_metadata(&target).is_ok();
    if exists && !overwrite {
        return Err(SkillError::Exists(name.to_owned()));
    }
    // 先把新目录移到用户目录里的临时名（`.` 开头，Core 不加载），再换下旧目录，失败时尽量还原
    let incoming = root.join(format!(".{name}.installing-{stage_id}"));
    move_dir(&source, &incoming)?;
    let old = root.join(format!(".{name}.replaced-{stage_id}"));
    // 替换失败时把新来源放回暂存，同一个 stage_id 可以在解除占用后重试。放不回去时（如跨卷复制中途出错）不删
    // `incoming`——那是新来源唯一完整的一份——并把这次暂存标为作废（进程内记录为准，另写 `broken` 标记），
    // 不会拿不完整的暂存再装一次
    let restore = |e: io::Error| -> SkillError {
        if move_dir(&incoming, &source).is_ok() {
            return e.into();
        }
        retire_stage(stage_id);
        let marker = stage.join(STAGE_BROKEN);
        let marked = tests_hook::fault(Fault::WriteMarker, &marker)
            .and_then(|()| std::fs::write(&marker, b""));
        let mut message = format!(
            "安装失败（{e}），新内容也没能放回暂存，已原样保留在 {}；请处理后重新选择来源",
            incoming.display()
        );
        if let Err(me) = marked {
            eprintln!(
                "[skills] 暂存 {stage_id} 的作废标记写入失败（{}）：{me}；本次运行内仍拒绝用它安装",
                marker.display()
            );
            message.push_str(&format!("（暂存作废标记也没写成：{me}；请放弃这次暂存）"));
        }
        invalid(message)
    };
    if exists && let Err(e) = std::fs::rename(&target, &old) {
        return Err(restore(e));
    }
    if let Err(e) = std::fs::rename(&incoming, &target) {
        if exists {
            let _ = std::fs::rename(&old, &target);
        }
        return Err(restore(e));
    }
    if exists {
        let _ = remove_entry(&old);
    }
    let _ = remove_entry(&stage);
    Ok(target)
}

/// 移动目录：同一卷上直接改名，否则复制后删除源目录。复制失败时删掉复制了一半的目标，源目录不动。
fn move_dir(from: &Path, to: &Path) -> Result<(), SkillError> {
    let fault = tests_hook::fault(Fault::CopyTo, to).is_err();
    if !fault && std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    let mut budget = Budget::default();
    let copied = copy_tree(from, to, &mut budget).and_then(|()| {
        if fault {
            Err(io::Error::other("注入的故障：复制中途失败").into())
        } else {
            Ok(())
        }
    });
    if let Err(e) = copied {
        // 删不掉复制了一半的目标时只能留下它：记下来；调用方据返回的错误把它当作不完整处理
        if let Err(ce) = tests_hook::fault(Fault::Cleanup, to).and_then(|()| remove_entry(to)) {
            eprintln!(
                "[skills] 复制中途失败后清理不完整的目标失败（{}）：{ce}",
                to.display()
            );
        }
        return Err(e);
    }
    if let Err(ce) = remove_entry(from) {
        eprintln!(
            "[skills] 复制完成后删除源目录失败（{}）：{ce}",
            from.display()
        );
    }
    Ok(())
}

/// [`tests_hook`] 可注入的文件操作故障。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Fault {
    /// [`move_dir`] 移到该目标时走复制，且复制后报错（模拟跨卷复制中途失败）
    CopyTo,
    /// [`move_dir`] 复制失败后删除该目标失败
    Cleanup,
    /// 写该作废标记失败
    WriteMarker,
}

/// 测试用的故障注入：按（操作，路径）登记，非测试构建里永远不出错。
mod tests_hook {
    use super::Fault;
    use std::io;
    use std::path::Path;

    #[cfg(test)]
    thread_local! {
        static FAULTS: std::cell::RefCell<Vec<(Fault, std::path::PathBuf)>> =
            const { std::cell::RefCell::new(Vec::new()) };
    }

    #[cfg(test)]
    pub(super) fn inject(op: Fault, path: &Path) {
        FAULTS.with(|f| f.borrow_mut().push((op, path.to_path_buf())));
    }

    #[cfg(test)]
    pub(super) fn clear() {
        FAULTS.with(|f| f.borrow_mut().clear());
    }

    /// 登记了（`op`，`path`）时返回注入的错误。
    pub(super) fn fault(op: Fault, path: &Path) -> io::Result<()> {
        #[cfg(test)]
        {
            if FAULTS.with(|f| f.borrow().iter().any(|(o, p)| *o == op && p == path)) {
                return Err(io::Error::other(format!("注入的故障：{op:?}")));
            }
        }
        let _ = (op, path);
        Ok(())
    }
}

/// 解析 GitHub 链接，返回（owner，repo，ref，子目录）。
///
/// 分支 / 标签的写法与 Core 安装 git 来源时一致（agent-core `packages/coding-agent/src/utils/git.ts` 的 `parseGitUrl`，
/// 基于 hosted-git-info）：`https://github.com/<owner>/<repo>[.git]` 后接 `#<ref>` 或 `@<ref>`（ref 可以含 `/`，
/// 如 `#feature/x`），`git:` 前缀的 `git:github.com/<owner>/<repo>[@<ref>]` 与 `git:git@github.com:<owner>/<repo>`，
/// 以及 `http(s)://`、`ssh://`、`git://` 协议。Core 只会整库 `git clone`；这里另外接受网页上复制的
/// `…/tree/<ref>/<目录>` 与 `…/blob/<ref>/<目录>/SKILL.md`（取所在目录），与 hosted-git-info 一样 ref 只取一段，
/// 含 `/` 的分支请用 `#<ref>` 写法（这时没有子目录）。
pub(crate) fn parse_github_url(
    url: &str,
) -> Result<(String, String, Option<String>, Option<String>), SkillError> {
    let bad = || invalid("请输入 GitHub 仓库链接，例如 https://github.com/owner/repo");
    let raw = url.trim();
    let (has_git_prefix, raw) = match raw.strip_prefix("git:") {
        Some(rest) => (true, rest.trim()),
        None => (false, raw),
    };
    // 去掉协议与主机，只留 `<owner>/<repo>…`
    let lower = raw.to_ascii_lowercase();
    let mut rest = None;
    for scheme in [
        "https://",
        "http://",
        "ssh://",
        "git://",
        "git+ssh://",
        "git+https://",
    ] {
        if lower.starts_with(scheme) {
            let after = &raw[scheme.len()..];
            let after = after.strip_prefix("git@").unwrap_or(after);
            let (host, path) = after.split_once('/').ok_or_else(bad)?;
            if !matches!(
                host.to_ascii_lowercase().as_str(),
                "github.com" | "www.github.com"
            ) {
                return Err(bad());
            }
            // Core 不带 git: 前缀时只认 http(s) / ssh / git 协议
            if !has_git_prefix && scheme.starts_with("git+") {
                return Err(bad());
            }
            rest = Some(path);
            break;
        }
    }
    let rest = match rest {
        Some(r) => r,
        // 不带协议的写法只在 git: 前缀后接受（与 Core 一致）
        None if has_git_prefix => {
            if let Some(r) = raw.strip_prefix("git@github.com:") {
                r
            } else {
                let (host, path) = raw.split_once('/').ok_or_else(bad)?;
                if !host.eq_ignore_ascii_case("github.com") {
                    return Err(bad());
                }
                path
            }
        }
        None => return Err(bad()),
    };
    // `#<ref>`（hosted-git-info 的 committish）与查询串
    let (rest, hash_ref) = match rest.split_once('#') {
        Some((r, h)) => (r, Some(h)),
        None => (rest, None),
    };
    let rest = rest.split('?').next().unwrap_or("");
    let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
    let segment_ok = |s: &str| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    let ref_ok = |r: &str| {
        !r.is_empty()
            && !r.starts_with('/')
            && !r.split('/').any(|p| p.is_empty() || p == "..")
            && !r.chars().any(|c| c.is_control() || c == '\\' || c == ' ')
    };
    let (owner, repo_part) = match parts.as_slice() {
        [o, r, ..] => (*o, *r),
        _ => return Err(bad()),
    };
    // `@<ref>`（Core 的 splitRef）：仓库名后第一个 `@` 之后都是 ref，可以含 `/`
    // （只认仓库名那一段里的 `@`，`tree/…/a@b` 这类路径里的不算）
    let at = repo_part.contains('@').then(|| rest.find('@')).flatten();
    let (repo_part, at_ref) = match at {
        Some(i) => {
            let repo = repo_part.split('@').next().unwrap_or("");
            (repo, Some(&rest[i + 1..]))
        }
        None => (repo_part, None),
    };
    let repo = repo_part.strip_suffix(".git").unwrap_or(repo_part);
    if !segment_ok(owner) || !segment_ok(repo) {
        return Err(bad());
    }
    let named_ref = match (hash_ref, at_ref) {
        (Some(_), Some(_)) => return Err(bad()),
        (Some(r), None) | (None, Some(r)) => {
            let r = percent_decode(r);
            if !ref_ok(&r) {
                return Err(bad());
            }
            Some(r)
        }
        (None, None) => None,
    };
    if let Some(r) = named_ref {
        // `@ref` / `#ref` 写法后面不能再有路径
        if at.is_none() && parts.len() > 2 {
            return Err(bad());
        }
        return Ok((owner.to_owned(), repo.to_owned(), Some(r), None));
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
            if !ref_ok(&r) {
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
        write(&core.join("skills/group/build/copy/SKILL.md"), SKILL);
        write(&core.join("skills/group/.gitignore"), "build/\n");
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
            .map(|s| {
                (
                    s.dir_name.as_str(),
                    s.scope,
                    s.enabled,
                    s.deletable,
                    s.package.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            names,
            vec![
                ("inner", SkillScope::User, true, true, Some("group")),
                ("review", SkillScope::User, true, true, None),
                ("skills", SkillScope::User, false, true, None),
                ("lint", SkillScope::Agents, true, false, None),
                ("sub", SkillScope::Agents, true, false, None),
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
        assert_eq!(
            s["skills"],
            serde_json::json!(["-/data/core/skills/review/SKILL.md"])
        );
        assert!(is_disabled(&s, &file, &core));
        assert!(!apply_enabled(&mut s, &file, &core, false).unwrap());
        // 其他写法（相对路径、目录）也认，启用时一并删掉；其他条目保留
        s.insert(
            "skills".into(),
            serde_json::json!([
                "-skills/review",
                "./extra",
                "-./skills/review/SKILL.md",
                "!x/*"
            ]),
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
    fn installs_every_skill_of_a_zip_with_conflict_confirmation() {
        let root = temp("install");
        let core = root.join("core");
        let tmp = root.join("tmp");
        let zip = ZipBuilder::new()
            .file("skills-main/README.md", "readme")
            .file("skills-main/.gitignore", "fixtures/\n")
            .file("skills-main/a/SKILL.md", SKILL)
            .file("skills-main/a/scripts/run.ps1", "x")
            .file("skills-main/b/c/SKILL.md", SKILL)
            .file("skills-main/fixtures/f/SKILL.md", SKILL)
            .finish();
        let stage = stage_zip(&tmp, &zip, "skills", None).unwrap();
        assert_eq!(stage.label, "skills");
        let paths: Vec<_> = stage.candidates.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, ["a", "b/c"], "被 .gitignore 忽略的与 Core 一样不算");
        assert_eq!(stage.candidates[1].dir_name, "c");
        let dir = install(&core, &tmp, &stage.stage_id, "demo", false).unwrap();
        assert_eq!(dir, core.join("skills/demo"));
        assert!(core.join("skills/demo/a/scripts/run.ps1").is_file());
        // 装进去的技能与 Core 从 skills/ 加载到的一致
        let loaded: Vec<_> = list(&core, None, &Map::new())
            .into_iter()
            .map(|s| (s.dir_name, s.package))
            .collect();
        assert_eq!(
            loaded,
            [
                ("a".to_owned(), Some("demo".to_owned())),
                ("c".to_owned(), Some("demo".to_owned()))
            ]
        );
        // 安装后暂存删除
        assert!(install(&core, &tmp, &stage.stage_id, "other", false).is_err());

        let single = ZipBuilder::new().file("x-main/SKILL.md", SKILL).finish();
        let stage = stage_zip(&tmp, &single, "x", None).unwrap();
        let err = install(&core, &tmp, &stage.stage_id, "demo", false).unwrap_err();
        assert_eq!(err.code(), Some("exists"));
        install(&core, &tmp, &stage.stage_id, "demo", true).unwrap();
        assert!(
            core.join("skills/demo/SKILL.md").is_file(),
            "覆盖后是新内容"
        );
        assert!(!core.join("skills/demo/a").exists());
        let leftovers: Vec<_> = std::fs::read_dir(core.join("skills"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(leftovers, ["demo"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_replace_keeps_the_stage_for_a_retry() {
        let root = temp("retry");
        let core = root.join("core");
        let tmp = root.join("tmp");
        write(&core.join("skills/demo/SKILL.md"), SKILL);
        let zip = ZipBuilder::new()
            .file("x-main/SKILL.md", SKILL)
            .file("x-main/new.md", "new")
            .finish();
        let stage = stage_zip(&tmp, &zip, "x", None).unwrap();
        // 旧目录换不下来（换下的临时名被一个非空目录占着）：安装失败，新来源回到暂存
        let blocker = core.join(format!("skills/.demo.replaced-{}", stage.stage_id));
        write(&blocker.join("busy"), "x");
        assert!(install(&core, &tmp, &stage.stage_id, "demo", true).is_err());
        assert!(!core.join("skills/demo/new.md").exists(), "旧目录原样保留");
        assert!(core.join("skills/demo/SKILL.md").is_file());
        assert!(
            stage_root(&tmp)
                .join(&stage.stage_id)
                .join(STAGE_ROOT)
                .join("new.md")
                .is_file(),
            "新来源放回暂存"
        );
        // 解除占用后用同一个 stage_id 重试
        std::fs::remove_dir_all(&blocker).unwrap();
        install(&core, &tmp, &stage.stage_id, "demo", true).unwrap();
        assert!(core.join("skills/demo/new.md").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_restore_keeps_incoming_and_retires_the_stage() {
        let root = temp("restore-fails");
        let core = root.join("core");
        let tmp = root.join("tmp");
        write(&core.join("skills/demo/SKILL.md"), SKILL);
        let zip = ZipBuilder::new()
            .file("x-main/SKILL.md", SKILL)
            .file("x-main/new.md", "new")
            .finish();
        let stage = stage_zip(&tmp, &zip, "x", None).unwrap();
        let stage_dir = stage_root(&tmp).join(&stage.stage_id);
        // 旧目录换不下来；新来源放回暂存时跨卷复制中途失败
        let blocker = core.join(format!("skills/.demo.replaced-{}", stage.stage_id));
        write(&blocker.join("busy"), "x");
        struct Clear;
        impl Drop for Clear {
            fn drop(&mut self) {
                tests_hook::clear();
            }
        }
        let _clear = Clear;
        tests_hook::inject(Fault::CopyTo, &stage_dir.join(STAGE_ROOT));
        let err = install(&core, &tmp, &stage.stage_id, "demo", true).unwrap_err();
        // 与 install 拼路径的方式一致（Windows 上错误信息里的分隔符才对得上）
        let incoming = user_skills_dir(&core).join(format!(".demo.installing-{}", stage.stage_id));
        assert!(
            err.to_string().contains(&incoming.display().to_string()),
            "{err}"
        );
        // 旧目录原样；新来源完整保留在 incoming，不删
        assert!(core.join("skills/demo/SKILL.md").is_file());
        assert!(!core.join("skills/demo/new.md").exists());
        assert!(incoming.join("new.md").is_file());
        assert!(incoming.join("SKILL.md").is_file());
        // 复制了一半的暂存已删掉，这次暂存作废：解除占用后也不能再用它安装
        assert!(!stage_dir.join(STAGE_ROOT).exists());
        std::fs::remove_dir_all(&blocker).unwrap();
        let again = install(&core, &tmp, &stage.stage_id, "demo", true).unwrap_err();
        assert!(again.to_string().contains("不完整"), "{again}");
        assert!(!core.join("skills/demo/new.md").exists());
        // 作废的暂存仍可放弃
        discard(&tmp, &stage.stage_id).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retired_stage_is_refused_even_when_marker_and_cleanup_both_fail() {
        let root = temp("retire-no-fs");
        let core = root.join("core");
        let tmp = root.join("tmp");
        write(&core.join("skills/demo/SKILL.md"), SKILL);
        let zip = ZipBuilder::new()
            .file("x-main/SKILL.md", SKILL)
            .file("x-main/new.md", "new")
            .finish();
        let stage = stage_zip(&tmp, &zip, "x", None).unwrap();
        let stage_dir = stage_root(&tmp).join(&stage.stage_id);
        let blocker = core.join(format!("skills/.demo.replaced-{}", stage.stage_id));
        write(&blocker.join("busy"), "x");
        struct Clear;
        impl Drop for Clear {
            fn drop(&mut self) {
                tests_hook::clear();
            }
        }
        let _clear = Clear;
        // 放回暂存时复制中途失败，复制了一半的暂存删不掉，作废标记也写不进去
        tests_hook::inject(Fault::CopyTo, &stage_dir.join(STAGE_ROOT));
        tests_hook::inject(Fault::Cleanup, &stage_dir.join(STAGE_ROOT));
        tests_hook::inject(Fault::WriteMarker, &stage_dir.join(STAGE_BROKEN));
        let err = install(&core, &tmp, &stage.stage_id, "demo", true).unwrap_err();
        assert!(
            err.to_string().contains("作废标记"),
            "写入失败要上报：{err}"
        );
        // 文件层面看不出作废：没有标记，暂存里留着一份看起来能装的内容
        assert!(!stage_dir.join(STAGE_BROKEN).exists());
        assert!(stage_dir.join(STAGE_ROOT).join("SKILL.md").is_file());
        // 解除占用后，同一个 stage_id 仍被拒绝，旧目录不动
        std::fs::remove_dir_all(&blocker).unwrap();
        tests_hook::clear();
        let again = install(&core, &tmp, &stage.stage_id, "demo", true).unwrap_err();
        assert!(again.to_string().contains("不完整"), "{again}");
        assert!(core.join("skills/demo/SKILL.md").is_file());
        assert!(!core.join("skills/demo/new.md").exists());
        discard(&tmp, &stage.stage_id).unwrap();
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
        assert_eq!(stage.label, "pdf");
        discard(&tmp, &stage.stage_id).unwrap();
        assert!(discard(&tmp, &stage.stage_id).is_err());
        assert!(discard(&tmp, "../x").is_err());
        assert!(stage_zip(&tmp, &zip, "repo", Some("skills/none")).is_err());
        let stage = stage_zip(&tmp, &zip, "repo", Some("skills")).unwrap();
        assert_eq!(stage.candidates.len(), 2);
        let single = ZipBuilder::new().file("x-main/SKILL.md", SKILL).finish();
        let stage = stage_zip(&tmp, &single, "x", None).unwrap();
        assert_eq!(stage.candidates[0].path, "");
        let core = root.join("core");
        install(&core, &tmp, &stage.stage_id, "x", false).unwrap();
        assert!(core.join("skills/x/SKILL.md").is_file());
        // 没有技能：报错并删除暂存
        let none = ZipBuilder::new().file("a/readme.md", "x").finish();
        assert!(stage_zip(&tmp, &none, "a", None).is_err());
        let left = std::fs::read_dir(stage_root(&tmp)).unwrap().count();
        assert_eq!(left, 1, "只剩下没安装的 skills 暂存");
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
        write(&core.join("skills/g/other/SKILL.md"), SKILL);
        write(&core.join("skills/g/README.md"), "readme");
        write(&home.join(".agents/skills/b/SKILL.md"), SKILL);
        let target = root.join("elsewhere");
        write(&target.join("SKILL.md"), SKILL);
        write(&target.join("deep/x/SKILL.md"), SKILL);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, core.join("skills/linked")).unwrap();
        let file = |p: &Path| p.to_string_lossy().into_owned();
        assert!(
            delete(
                &core,
                Some(&home),
                &file(&home.join(".agents/skills/b/SKILL.md"))
            )
            .is_err()
        );
        assert!(
            delete(
                &core,
                Some(&home),
                &file(&core.join("skills/../x/SKILL.md"))
            )
            .is_err()
        );
        delete(&core, Some(&home), &file(&core.join("skills/a/SKILL.md"))).unwrap();
        assert!(!core.join("skills/a").exists());
        // 一次安装里的某个技能：只删它的目录；删掉最后一个时整个顶层目录一起删
        delete(
            &core,
            Some(&home),
            &file(&core.join("skills/g/inner/SKILL.md")),
        )
        .unwrap();
        assert!(!core.join("skills/g/inner").exists());
        assert!(core.join("skills/g/README.md").is_file());
        delete(
            &core,
            Some(&home),
            &file(&core.join("skills/g/other/SKILL.md")),
        )
        .unwrap();
        assert!(!core.join("skills/g").exists());
        #[cfg(unix)]
        {
            delete(
                &core,
                Some(&home),
                &file(&core.join("skills/linked/SKILL.md")),
            )
            .unwrap();
            assert!(target.join("SKILL.md").is_file(), "只删链接，不动目标");
            // 经过链接的子目录：不能删（会删到链接目标里）
            let nested = root.join("elsewhere2");
            write(&nested.join("deep/x/SKILL.md"), SKILL);
            std::os::unix::fs::symlink(&nested, core.join("skills/linked2")).unwrap();
            let listed = list(&core, Some(&home), &Map::new());
            let x = listed.iter().find(|s| s.dir_name == "x").unwrap();
            assert_eq!(x.package.as_deref(), Some("linked2"));
            assert!(!x.deletable);
            assert!(delete(&core, Some(&home), &x.file).is_err());
            assert!(nested.join("deep/x/SKILL.md").is_file());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_keeps_package_when_another_link_points_into_it() {
        use crate::skill_discovery::tests::link_dir;
        let root = temp("delete-linked-pkg");
        let core = root.join("core");
        write(&core.join("skills/pkg/inner/SKILL.md"), SKILL);
        write(&core.join("skills/pkg/other/SKILL.md"), SKILL);
        // `a` 排在 `pkg` 前面，指向 pkg/other（Windows 上是符号链接或目录联接）
        if !link_dir(&core.join("skills/pkg/other"), &core.join("skills/a")) {
            std::fs::remove_dir_all(root).unwrap();
            return;
        }
        let names = |core: &Path| -> Vec<String> {
            list(core, None, &Map::new())
                .into_iter()
                .map(|s| s.dir_name)
                .collect()
        };
        // Core 加载时同一个文件只加载一次：列表里 pkg/other 与 a 只出现一次
        assert_eq!(names(&core), ["a", "inner"]);
        let file = core.join("skills/pkg/inner/SKILL.md");
        delete(&core, None, &file.to_string_lossy()).unwrap();
        assert!(!core.join("skills/pkg/inner").exists());
        assert!(
            core.join("skills/pkg/other/SKILL.md").is_file(),
            "pkg 里还有 other，不能整个删掉"
        );
        // 删链接只删链接本身，目标不动
        let file = core.join("skills/a/SKILL.md");
        delete(&core, None, &file.to_string_lossy()).unwrap();
        assert!(std::fs::symlink_metadata(core.join("skills/a")).is_err());
        assert!(core.join("skills/pkg/other/SKILL.md").is_file());
        assert_eq!(names(&core), ["other"]);
        // 删掉 pkg 里最后一个技能：顶层目录一并删除
        let file = core.join("skills/pkg/other/SKILL.md");
        delete(&core, None, &file.to_string_lossy()).unwrap();
        assert!(!core.join("skills/pkg").exists());
        assert!(names(&core).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn list_dedupes_by_real_file_before_applying_enabled_like_core() {
        use crate::skill_discovery::tests::link_dir;
        let root = temp("list-dedupe-enabled");
        let core = root.join("core");
        write(&core.join("skills/pkg/inner/SKILL.md"), SKILL);
        write(&core.join("skills/pkg/other/SKILL.md"), SKILL);
        if !link_dir(&core.join("skills/pkg/other"), &core.join("skills/a")) {
            std::fs::remove_dir_all(root).unwrap();
            return;
        }
        let shown = |patterns: serde_json::Value| -> Vec<(String, bool)> {
            let mut settings = Map::new();
            settings.insert("skills".into(), patterns);
            list(&core, None, &settings)
                .into_iter()
                .map(|s| (s.dir_name, s.enabled))
                .collect()
        };
        // 停用先登记的 `a`：Core 去重保留 `a` 再按启停过滤，pkg/other 也不加载——列表显示 a 已停用、不另列 other
        assert_eq!(
            shown(serde_json::json!(["-skills/a/SKILL.md"])),
            [("a".to_owned(), false), ("inner".to_owned(), true)]
        );
        // 只停用后登记的 pkg/other：Core 去重时它已被 `a` 挤掉，`a` 照常加载
        assert_eq!(
            shown(serde_json::json!(["-skills/pkg/other/SKILL.md"])),
            [("a".to_owned(), true), ("inner".to_owned(), true)]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_keeps_package_when_a_negation_rule_cannot_be_read() {
        use crate::skill_discovery::{FaultOp, inject_fault, tests::Faults};
        let root = temp("delete-ignore-fault");
        let core = root.join("core");
        // other 只靠自己目录里的 `!SKILL.md` 才被发现
        write(&core.join("skills/.gitignore"), "*.md\n");
        write(&core.join("skills/pkg/inner/SKILL.md"), SKILL);
        write(&core.join("skills/pkg/inner/.ignore"), "!SKILL.md\n");
        write(&core.join("skills/pkg/other/SKILL.md"), SKILL);
        write(&core.join("skills/pkg/other/.ignore"), "!SKILL.md\n");
        let _faults = Faults;
        inject_fault(
            FaultOp::Read,
            &core.join("skills/pkg/other/.ignore"),
            usize::MAX,
        );
        let file = core.join("skills/pkg/inner/SKILL.md");
        delete(&core, None, &file.to_string_lossy()).unwrap();
        assert!(!core.join("skills/pkg/inner").exists());
        assert!(
            core.join("skills/pkg/other/SKILL.md").is_file(),
            "忽略文件读不到时扫描不完整，保留顶层目录"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_keeps_package_when_skill_metadata_cannot_be_read() {
        use crate::skill_discovery::{FaultOp, inject_fault, tests::Faults};
        let root = temp("delete-meta-fault");
        let core = root.join("core");
        write(&core.join("skills/pkg/inner/SKILL.md"), SKILL);
        write(&core.join("skills/pkg/other/SKILL.md"), SKILL);
        let _faults = Faults;
        inject_fault(
            FaultOp::Metadata,
            &core.join("skills/pkg/other/SKILL.md"),
            usize::MAX,
        );
        let file = core.join("skills/pkg/inner/SKILL.md");
        delete(&core, None, &file.to_string_lossy()).unwrap();
        assert!(!core.join("skills/pkg/inner").exists());
        assert!(
            core.join("skills/pkg/other/SKILL.md").is_file(),
            "SKILL.md 的元数据读不到时扫描不完整，保留顶层目录"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_keeps_package_when_a_directory_vanishes_during_the_scan() {
        use crate::skill_discovery::{inject_absent_dir, tests::Faults};
        let root = temp("delete-vanish");
        let core = root.join("core");
        write(&core.join("skills/pkg/inner/SKILL.md"), SKILL);
        write(&core.join("skills/pkg/other/SKILL.md"), SKILL);
        let _faults = Faults;
        // pkg/other 在扫描期间“消失”（try_exists 返回 Ok(false)），之后又回来
        inject_absent_dir(&core.join("skills/pkg/other"), usize::MAX);
        let file = core.join("skills/pkg/inner/SKILL.md");
        delete(&core, None, &file.to_string_lossy()).unwrap();
        assert!(!core.join("skills/pkg/inner").exists());
        assert!(
            core.join("skills/pkg/other/SKILL.md").is_file(),
            "子目录在扫描期间消失时扫描不完整，保留顶层目录"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn delete_keeps_package_when_the_remaining_scan_is_incomplete() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp("delete-unreadable");
        let core = root.join("core");
        write(&core.join("skills/pkg/inner/SKILL.md"), SKILL);
        write(&core.join("skills/pkg/other/x/SKILL.md"), SKILL);
        let other = core.join("skills/pkg/other");
        std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o000)).unwrap();
        // root 用户不受权限限制，这时读得到，不验证这一项
        let unreadable = std::fs::read_dir(&other).is_err();
        let file = core.join("skills/pkg/inner/SKILL.md");
        delete(&core, None, &file.to_string_lossy()).unwrap();
        assert!(!core.join("skills/pkg/inner").exists());
        if unreadable {
            assert!(core.join("skills/pkg").exists(), "扫描不完整时保留顶层目录");
        }
        std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(core.join("skills/pkg/other/x/SKILL.md").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn github_urls() {
        let p = |u: &str| parse_github_url(u).ok();
        let repo = |r: Option<&str>, sub: Option<&str>| {
            Some((
                "o".to_owned(),
                "r".to_owned(),
                r.map(str::to_owned),
                sub.map(str::to_owned),
            ))
        };
        assert_eq!(p("https://github.com/o/r"), repo(None, None));
        assert_eq!(p("https://github.com/o/r.git"), repo(None, None));
        assert_eq!(p("https://www.github.com/o/r/"), repo(None, None));
        assert_eq!(
            p("https://github.com/o/r/tree/main/skills/pdf"),
            repo(Some("main"), Some("skills/pdf"))
        );
        assert_eq!(
            p("https://github.com/o/r/blob/v1/skills/pdf/SKILL.md?plain=1"),
            repo(Some("v1"), Some("skills/pdf"))
        );
        // Core 的 ref 写法：#ref（hosted-git-info）与 @ref（splitRef），ref 可以含 /
        assert_eq!(
            p("https://github.com/o/r#feature/x"),
            repo(Some("feature/x"), None)
        );
        assert_eq!(
            p("https://github.com/o/r.git@feature/x"),
            repo(Some("feature/x"), None)
        );
        assert_eq!(p("git:github.com/o/r@v2"), repo(Some("v2"), None));
        assert_eq!(p("git:git@github.com:o/r"), repo(None, None));
        assert_eq!(
            p("https://github.com/o/r/tree/main/a@b"),
            repo(Some("main"), Some("a@b"))
        );
        assert_eq!(p("ssh://git@github.com/o/r"), repo(None, None));
        assert_eq!(p("http://github.com/o/r"), repo(None, None));
        assert_eq!(p("git:https://github.com/o/r#v1"), repo(Some("v1"), None));
        for bad in [
            "github.com/o/r",
            "git@github.com:o/r",
            "git+https://github.com/o/r",
            "https://gitlab.com/o/r",
            "https://github.com/o",
            "https://github.com/o/r/issues/1",
            "https://github.com/o/r/tree/main/../x",
            "https://github.com/o/r#a/../b",
            "https://github.com/o/r#",
            "https://github.com/o/r/tree/x#y",
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
        assert_eq!(
            codeload_url("o", "r", Some("feature/x")),
            "https://codeload.github.com/o/r/zip/feature/x"
        );
    }

    #[test]
    fn dir_names() {
        for ok in ["pdf", "my-skill_2", "a.b"] {
            assert!(valid_dir_name(ok), "{ok}");
        }
        for bad in [
            "",
            ".hidden",
            "a/b",
            "a\\b",
            "..",
            "con",
            "名字",
            "a b",
            &"x".repeat(65),
        ] {
            assert!(!valid_dir_name(bad), "{bad}");
        }
    }
}
