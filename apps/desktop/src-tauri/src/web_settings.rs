//! 联网设置（ADR 0020）：设置·能力中心里的“联网”开关，是否允许 AI 联网搜索与读取网页。
//!
//! - 文件：`users/<SID>/app/web.json`（`{"enabled": true}`），不存在或内容无效时默认开启。
//! - 路径经环境变量 `PRIMUS_WEB_SETTINGS` 传给 Core 的 primus-web 扩展；扩展每轮对话开始前读一次，
//!   关闭时把 `web_search` / `web_fetch` 从模型可用的工具里移除，所以改设置不需要重启 Core。
//! - 薄壳只读写这个开关，不理解其他联网逻辑。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::paths::DataPaths;

/// 设置文件名（在 `users/<SID>/app` 下）。
const FILE_NAME: &str = "web.json";

/// 联网设置。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebSettings {
    /// 允许 AI 联网搜索与读取网页。
    pub(crate) enabled: bool,
}

impl Default for WebSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// 设置文件路径。
pub(crate) fn settings_file(paths: &DataPaths) -> PathBuf {
    paths.app_dir().join(FILE_NAME)
}

impl WebSettings {
    /// 读取设置；文件不存在或内容无效时用默认值（开启）。其他读取错误（权限、共享冲突）原样返回：
    /// 此时 Core 的 primus-web 也读不到，会按关闭处理，设置界面不能报告成“开启”。
    pub(crate) fn load(path: &Path) -> io::Result<Self> {
        match fs::read(path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e),
        }
    }

    /// 保存（先写临时文件再替换）。
    pub(crate) fn save(&self, path: &Path) -> io::Result<()> {
        let text = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        crate::providers::write_atomic(path, &text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::tests::{TempDir, data_paths};

    #[test]
    fn defaults_on_and_roundtrips() {
        let tmp = TempDir::new();
        let paths = data_paths(&tmp.0);
        let file = settings_file(&paths);
        assert_eq!(file, paths.app_dir().join("web.json"));
        assert_eq!(
            WebSettings::load(&file).unwrap(),
            WebSettings { enabled: true }
        );

        WebSettings { enabled: false }.save(&file).unwrap();
        assert_eq!(
            WebSettings::load(&file).unwrap(),
            WebSettings { enabled: false }
        );
        // 扩展按这个格式读取
        let text = fs::read_to_string(&file).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json, serde_json::json!({ "enabled": false }));

        fs::write(&file, b"{not json").unwrap();
        assert_eq!(WebSettings::load(&file).unwrap(), WebSettings::default());
    }

    #[test]
    fn read_errors_are_not_reported_as_enabled() {
        let tmp = TempDir::new();
        let paths = data_paths(&tmp.0);
        let file = settings_file(&paths);
        // 路径是目录：不是“不存在”，读取失败要报错
        fs::create_dir_all(&file).unwrap();
        assert!(WebSettings::load(&file).is_err());
    }
}
