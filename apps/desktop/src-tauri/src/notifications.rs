//! 通知与提示音（ADR 0023）：设置文件与通知点击的转发。
//!
//! - 设置：`users/<SID>/app/notifications.json`（`{"turnComplete":"background","needsInput":true,"sound":true}`），
//!   不存在或内容无效时用默认值，缺少的字段各自取默认值。是否提醒、放什么声音由前端判断与播放；
//!   薄壳只保存设置、弹系统通知（`platform::toast`）、在点击时把主窗口拉到前台并通知前端切到对应会话。
//! - 应用设置原定写入 `settings.toml`（第 18 章），在它接入前与联网设置一样单独存一个文件。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use crate::paths::DataPaths;

/// 设置文件名（在 `users/<SID>/app` 下）。
const FILE_NAME: &str = "notifications.json";

/// 一轮结束时何时通知。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TurnComplete {
    Never,
    /// 窗口不在前台或用户在看别的会话时（默认，与 Codex 的 `unfocused` 一致）
    #[default]
    Background,
    Always,
}

/// 通知与提示音设置。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct NotificationSettings {
    pub(crate) turn_complete: TurnComplete,
    /// 需要用户确认、回答或批准计划时通知
    pub(crate) needs_input: bool,
    /// 通知时播放提示音
    pub(crate) sound: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            turn_complete: TurnComplete::Background,
            needs_input: true,
            sound: true,
        }
    }
}

/// 设置文件路径。
pub(crate) fn settings_file(paths: &DataPaths) -> PathBuf {
    paths.app_dir().join(FILE_NAME)
}

impl NotificationSettings {
    /// 读取设置；文件不存在或内容无效时用默认值，其他读取错误原样返回。
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

/// 前端要显示的一条通知（`notification_show`）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NotificationRequest {
    pub(crate) title: String,
    pub(crate) body: String,
    /// 点击时交回前端（前端的标签 ID）
    pub(crate) tag: String,
    /// 需要用户处理：窗口不在前台时闪烁任务栏按钮
    pub(crate) attention: bool,
}

/// 标题与正文的长度上限（字符）：前端已截断，这里再兜底，避免超长内容撑大 Toast。
const TITLE_MAX: usize = 80;
const BODY_MAX: usize = 300;

impl NotificationRequest {
    pub(crate) fn clamp(mut self) -> Self {
        self.title = self.title.chars().take(TITLE_MAX).collect();
        self.body = self.body.chars().take(BODY_MAX).collect();
        self
    }
}

type Listener = Box<dyn Fn(String) + Send + Sync>;

/// 通知点击的订阅（`notification_watch`）：再次订阅替换旧的。
#[derive(Default)]
pub(crate) struct NotificationHub {
    listener: Mutex<Option<Listener>>,
}

impl NotificationHub {
    pub(crate) fn set_listener(&self, listener: impl Fn(String) + Send + Sync + 'static) {
        *self.listener.lock().unwrap_or_else(PoisonError::into_inner) = Some(Box::new(listener));
    }

    /// 用户点击了通知：交给前端（前端切到对应会话）。
    pub(crate) fn activate(&self, tag: String) {
        if let Some(listener) = self
            .listener
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            listener(tag);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::tests::{TempDir, data_paths};
    use std::sync::Arc;

    #[test]
    fn defaults_and_roundtrip() {
        let tmp = TempDir::new();
        let paths = data_paths(&tmp.0);
        let file = settings_file(&paths);
        assert_eq!(file, paths.app_dir().join("notifications.json"));
        assert_eq!(
            NotificationSettings::load(&file).unwrap(),
            NotificationSettings::default()
        );

        let custom = NotificationSettings {
            turn_complete: TurnComplete::Always,
            needs_input: false,
            sound: false,
        };
        custom.save(&file).unwrap();
        assert_eq!(NotificationSettings::load(&file).unwrap(), custom);
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "turnComplete": "always", "needsInput": false, "sound": false })
        );

        // 缺少的字段取默认值；无效内容整体用默认值
        fs::write(&file, br#"{"sound":false}"#).unwrap();
        assert_eq!(
            NotificationSettings::load(&file).unwrap(),
            NotificationSettings {
                sound: false,
                ..NotificationSettings::default()
            }
        );
        fs::write(&file, br#"{"turnComplete":"sometimes"}"#).unwrap();
        assert_eq!(
            NotificationSettings::load(&file).unwrap(),
            NotificationSettings::default()
        );
    }

    #[test]
    fn read_errors_are_reported() {
        let tmp = TempDir::new();
        let paths = data_paths(&tmp.0);
        let file = settings_file(&paths);
        fs::create_dir_all(&file).unwrap();
        assert!(NotificationSettings::load(&file).is_err());
    }

    #[test]
    fn request_is_clamped_and_strict() {
        let req: NotificationRequest = serde_json::from_value(serde_json::json!({
            "title": "t".repeat(200), "body": "好".repeat(500), "tag": "tab-1", "attention": true
        }))
        .unwrap();
        let req = req.clamp();
        assert_eq!(req.title.chars().count(), TITLE_MAX);
        assert_eq!(req.body.chars().count(), BODY_MAX);
        assert!(
            serde_json::from_value::<NotificationRequest>(serde_json::json!({
                "title": "", "body": "", "tag": "", "attention": false, "extra": 1
            }))
            .is_err()
        );
    }

    #[test]
    fn hub_forwards_to_latest_listener() {
        let hub = NotificationHub::default();
        hub.activate("ignored".into());
        let got = Arc::new(Mutex::new(Vec::new()));
        let first = got.clone();
        hub.set_listener(move |t| first.lock().unwrap().push(format!("a:{t}")));
        hub.activate("tab-1".into());
        let second = got.clone();
        hub.set_listener(move |t| second.lock().unwrap().push(format!("b:{t}")));
        hub.activate("tab-2".into());
        assert_eq!(*got.lock().unwrap(), ["a:tab-1", "b:tab-2"]);
    }
}
