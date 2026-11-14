//! 语音转文字（`speech_available` / `speech_start` / `speech_audio` / `speech_stop`）：
//! 内置功能，识别由独立的 `primus-asr` 库（`src-tauri/asr/`）完成，用户不需要任何配置。
//!
//! - 麦克风由前端 WebView 采集（getUserMedia，App 自己的页面由 `webview_permissions` 自动授权，不弹权限框），
//!   转成 16 kHz、16 位、单声道 PCM 后经 `speech_audio` 交进来。
//! - 用的是哪款模型、额度怎么切换，都不推给前端；全部不可用或出错时只推 [`SpeechEvent::Error`]，
//!   文案固定为“语音转文字暂不可用”。
//! - 音频与识别结果只在内存里经过，不落盘；落盘的只有各模型暂停到什么时候（`app/asr-state.json`）。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;

/// 出错时给用户看的唯一文案
pub(crate) const UNAVAILABLE: &str = "语音转文字暂不可用";

/// 推给前端的识别事件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum SpeechEvent {
    /// 识别中的临时文本（当前这一句，随时被替换；空串表示清掉）
    Interim { text: String },
    /// 定稿的一句
    Final { text: String },
    /// 语音转文字暂不可用（会话随后结束）
    Error { message: String },
    /// 会话结束
    End,
}

impl From<primus_asr::Event> for SpeechEvent {
    fn from(e: primus_asr::Event) -> Self {
        match e {
            primus_asr::Event::Interim(text) => SpeechEvent::Interim { text },
            primus_asr::Event::Final(text) => SpeechEvent::Final { text },
            primus_asr::Event::Unavailable => SpeechEvent::Error {
                message: UNAVAILABLE.to_string(),
            },
            primus_asr::Event::End => SpeechEvent::End,
        }
    }
}

/// 事件回调（在识别线程里调用）。
pub(crate) type SpeechSink = Arc<dyn Fn(SpeechEvent) + Send + Sync + 'static>;

pub(crate) struct Speech(primus_asr::Asr);

impl Speech {
    /// `state_path`：各模型暂停记录的文件
    pub(crate) fn new(state_path: PathBuf) -> Self {
        Self(primus_asr::Asr::new(Some(state_path)))
    }

    /// 构建时注入了识别服务的密钥才可用（开发构建没有时隐藏麦克风按钮）
    pub(crate) fn available(&self) -> bool {
        self.0.available()
    }

    /// 开始听写（已有会话时先结束旧的）
    pub(crate) fn start(&self, sink: SpeechSink) {
        self.0.start(Arc::new(move |e| sink(e.into())));
    }

    /// 麦克风音频：16 kHz、16 位、单声道、小端 PCM
    pub(crate) fn audio(&self, pcm: &[u8]) {
        self.0.push(pcm);
    }

    /// 停止录音：已录的音频识别完后推送 `end`
    pub(crate) fn stop(&self) {
        self.0.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialize_with_type_tag() {
        let json = |e: SpeechEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            json(primus_asr::Event::Interim("你好".into()).into()),
            serde_json::json!({"type": "interim", "text": "你好"})
        );
        assert_eq!(
            json(primus_asr::Event::Final("你好。".into()).into()),
            serde_json::json!({"type": "final", "text": "你好。"})
        );
        assert_eq!(
            json(primus_asr::Event::Unavailable.into()),
            serde_json::json!({"type": "error", "message": "语音转文字暂不可用"})
        );
        assert_eq!(
            json(primus_asr::Event::End.into()),
            serde_json::json!({"type": "end"})
        );
    }
}
