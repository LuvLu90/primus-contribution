//! 能力中心·MCP（ADR 0017）：读写用户级 MCP 配置 `<Core 用户目录>/mcp.json`。
//!
//! 薄壳只做文件层面的事：读出原文与版本（内容的 SHA-256，文件不存在为空串），写入前确认文件仍是读出时的版本
//! （Agent 或用户在别处改过时返回 [`McpConfigError::Conflict`]，界面重新读取后再改；版本复核与替换在本进程的
//! 提交临界区里紧挨着完成），大小不超过 1 MiB、
//! 是带 `mcpServers` 对象（可省略）的 JSON 对象，原子替换。服务器条目的校验、合并与格式保留在前端（与 Core 的
//! 校验规则一致）；连接测试、登录、登出经 Core 命令行（[`crate::supervisor::Supervisor::run_cli`]）。

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// `mcp.json` 最多的字节数（与项目信任读取 `.primus/mcp.json` 的上限一致）。
pub(crate) const MCP_JSON_LIMIT: u64 = 1024 * 1024;

#[derive(Debug)]
pub(crate) enum McpConfigError {
    /// 文件在读出后被改过
    Conflict,
    /// 内容不合法（不是 JSON 对象、过大）
    Invalid(String),
    Io(io::Error),
}

impl McpConfigError {
    pub(crate) fn code(&self) -> Option<&'static str> {
        matches!(self, Self::Conflict).then_some("conflict")
    }
}

impl fmt::Display for McpConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict => f.write_str("mcp.json 已在别处被修改，请重新读取后再保存"),
            Self::Invalid(m) => write!(f, "mcp.json 内容无效：{m}"),
            Self::Io(e) => write!(f, "读写 mcp.json 失败：{e}"),
        }
    }
}

impl From<io::Error> for McpConfigError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// 读出的 `mcp.json`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpConfigFile {
    /// 文件路径（界面显示）
    pub(crate) path: String,
    /// 原文；文件不存在时为 None
    pub(crate) text: Option<String>,
    /// 版本：内容的 SHA-256（十六进制），文件不存在时为空串；写入时原样带回
    pub(crate) version: String,
}

pub(crate) fn config_path(core_dir: &Path) -> PathBuf {
    core_dir.join("mcp.json")
}

fn version_of(bytes: Option<&[u8]>) -> String {
    bytes
        .map(|b| {
            Sha256::digest(b)
                .iter()
                .map(|x| format!("{x:02x}"))
                .collect()
        })
        .unwrap_or_default()
}

fn read_bytes(file: &Path) -> Result<Option<Vec<u8>>, McpConfigError> {
    let meta = match std::fs::metadata(file) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !meta.is_file() {
        return Err(McpConfigError::Invalid("不是普通文件".into()));
    }
    if meta.len() > MCP_JSON_LIMIT {
        return Err(McpConfigError::Invalid("超过 1 MiB".into()));
    }
    Ok(Some(std::fs::read(file)?))
}

/// 读出 `mcp.json`。
pub(crate) fn read(core_dir: &Path) -> Result<McpConfigFile, McpConfigError> {
    let file = config_path(core_dir);
    let bytes = read_bytes(&file)?;
    let text = bytes
        .as_deref()
        .map(|b| {
            std::str::from_utf8(b)
                .map(|t| t.strip_prefix('\u{feff}').unwrap_or(t).to_owned())
                .map_err(|_| McpConfigError::Invalid("不是 UTF-8 文本".into()))
        })
        .transpose()?;
    Ok(McpConfigFile {
        path: file.to_string_lossy().into_owned(),
        text,
        version: version_of(bytes.as_deref()),
    })
}

/// 检查要写入的内容：JSON 对象，`mcpServers` 省略或为对象，不超过 1 MiB。
pub(crate) fn validate(text: &str) -> Result<(), McpConfigError> {
    if text.len() as u64 > MCP_JSON_LIMIT {
        return Err(McpConfigError::Invalid("超过 1 MiB".into()));
    }
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| McpConfigError::Invalid(e.to_string()))?;
    let obj = value
        .as_object()
        .ok_or_else(|| McpConfigError::Invalid("应为 JSON 对象".into()))?;
    match obj.get("mcpServers") {
        None | Some(serde_json::Value::Object(_)) => Ok(()),
        Some(_) => Err(McpConfigError::Invalid("mcpServers 应为对象".into())),
    }
}

/// 写入 `mcp.json`：文件当前版本须等于 `expected`（读出时的版本），否则返回冲突、不写。返回新版本。
pub(crate) fn write(core_dir: &Path, text: &str, expected: &str) -> Result<String, McpConfigError> {
    write_with(core_dir, text, expected, || {})
}

/// 本进程内对 `mcp.json` 的提交互斥：版本复核与替换在同一临界区里完成，两笔并发保存只有一笔成功、另一笔返回冲突。
static COMMIT: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 当前文件内容（不存在为 None）。原文件过大或不是文本也照常取出：只要版本对得上就允许整体替换。
fn current_bytes(file: &Path) -> Result<Option<Vec<u8>>, McpConfigError> {
    read_bytes(file).or_else(|e| match e {
        McpConfigError::Invalid(_) => std::fs::read(file).map(Some).map_err(Into::into),
        e => Err(e),
    })
}

/// [`write`] 的实现。先把新内容完整写进同目录的临时文件，再进入提交临界区：重新读取文件、复核版本、改名替换。
/// 复核与改名之间不再有写内容的耗时步骤，Core 或编辑器在此前任何时刻改过文件都会被复核发现。
/// `before_commit` 在进入临界区后、复核前调用（测试用来模拟“比较之后、替换之前”的另一笔写入）。
fn write_with(
    core_dir: &Path,
    text: &str,
    expected: &str,
    before_commit: impl FnOnce(),
) -> Result<String, McpConfigError> {
    validate(text)?;
    let file = config_path(core_dir);
    // 先做一次便宜的检查：版本已经不对就不必写临时文件
    if version_of(current_bytes(&file)?.as_deref()) != expected {
        return Err(McpConfigError::Conflict);
    }
    let dir = file
        .parent()
        .ok_or_else(|| McpConfigError::Invalid("配置路径无效".into()))?;
    std::fs::create_dir_all(dir)?;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = dir.join(format!(
        "mcp.json.{}.{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let result = (|| {
        std::fs::write(&tmp, text)?;
        let _guard = COMMIT.lock().unwrap_or_else(|p| p.into_inner());
        before_commit();
        if version_of(current_bytes(&file)?.as_deref()) != expected {
            return Err(McpConfigError::Conflict);
        }
        std::fs::rename(&tmp, &file)?;
        Ok(version_of(Some(text.as_bytes())))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "primus-mcp-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_write_with_conflict_detection() {
        let dir = temp();
        let first = read(&dir).unwrap();
        assert_eq!(first.text, None);
        assert_eq!(first.version, "");
        let text = "{\n  \"mcpServers\": {}\n}\n";
        let v1 = write(&dir, text, &first.version).unwrap();
        let again = read(&dir).unwrap();
        assert_eq!(again.text.as_deref(), Some(text));
        assert_eq!(again.version, v1);
        // 用旧版本写：冲突，不写
        let err = write(&dir, "{}", "").unwrap_err();
        assert_eq!(err.code(), Some("conflict"));
        assert_eq!(read(&dir).unwrap().text.as_deref(), Some(text));
        // 别处改了文件
        std::fs::write(config_path(&dir), "{\"mcpServers\":{\"x\":{}}}").unwrap();
        assert_eq!(write(&dir, "{}", &v1).unwrap_err().code(), Some("conflict"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn write_between_check_and_replace_is_a_conflict() {
        let dir = temp();
        let v0 = read(&dir).unwrap().version;
        // 另一笔写入发生在初次比较之后、替换之前：复核发现，返回冲突，保留对方写入的内容
        let other = "{\"mcpServers\":{\"other\":{\"command\":\"x\"}}}";
        let err = write_with(&dir, "{}", &v0, || {
            std::fs::write(config_path(&dir), other).unwrap();
        })
        .unwrap_err();
        assert_eq!(err.code(), Some("conflict"));
        assert_eq!(read(&dir).unwrap().text.as_deref(), Some(other));
        // 没有留下临时文件
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_saves_from_the_same_version_only_one_wins() {
        let dir = temp();
        let v0 = read(&dir).unwrap().version;
        let results: Vec<_> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..8)
                .map(|i| {
                    let (dir, v0) = (&dir, &v0);
                    s.spawn(move || write(dir, &format!("{{\"n\":{i}}}"), v0))
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let ok: Vec<_> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
        assert_eq!(ok.len(), 1, "{results:?}");
        assert!(
            results
                .iter()
                .filter_map(|r| r.as_ref().err())
                .all(|e| e.code() == Some("conflict"))
        );
        assert_eq!(&read(&dir).unwrap().version, ok[0]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validates_shape_and_bom() {
        assert!(validate("{}").is_ok());
        assert!(validate("{\"mcpServers\":{},\"autoEnableCodemode\":true}").is_ok());
        for bad in ["[]", "1", "{\"mcpServers\":[]}", "{", ""] {
            assert!(validate(bad).is_err(), "{bad}");
        }
        let big = format!("{{\"x\":\"{}\"}}", "a".repeat(MCP_JSON_LIMIT as usize));
        assert!(validate(&big).is_err());
        let dir = temp();
        std::fs::write(config_path(&dir), "\u{feff}{}").unwrap();
        assert_eq!(read(&dir).unwrap().text.as_deref(), Some("{}"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
