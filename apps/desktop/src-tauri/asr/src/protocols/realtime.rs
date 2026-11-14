//! `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=…`：千问 3-ASR-Flash-Realtime。
//!
//! 握手需带 `OpenAI-Beta: realtime=v1`，否则连接会被直接重置。
//! 流程：session.update（PCM 16 kHz、服务端 VAD 断句）→ input_audio_buffer.append（Base64 音频）
//! → 录音结束发 session.finish → 等 session.finished。
//! 临时结果为 `…transcription.text` 的 text + stash，定稿为 `…transcription.completed` 的 transcript；
//! 一句的结束时间取前一个 `input_audio_buffer.speech_stopped` 的 audio_end_ms。

use base64::Engine as _;
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use super::{Emit, FINISH_TIMEOUT, Out};
use crate::audio::Feed;
use crate::failure::{Failure, classify};
use crate::models::Model;
use crate::net::{self, Net};

pub fn path(model: &Model) -> String {
    format!("/api-ws/v1/realtime?model={}", model.id)
}

pub fn session_update(model: &Model) -> String {
    json!({
        "event_id": "event_session",
        "type": "session.update",
        "session": {
            "modalities": ["text"],
            "input_audio_format": "pcm",
            "sample_rate": model.sample_rate,
            "turn_detection": {"type": "server_vad", "threshold": 0.2, "silence_duration_ms": 800}
        }
    })
    .to_string()
}

/// 每条客户端消息都要带唯一的 event_id
fn event_id() -> String {
    format!("event_{}", super::duplex::task_id())
}

pub fn append(pcm: &[u8]) -> String {
    json!({
        "event_id": event_id(),
        "type": "input_audio_buffer.append",
        "audio": base64::engine::general_purpose::STANDARD.encode(pcm)
    })
    .to_string()
}

pub fn finish() -> String {
    json!({"event_id": event_id(), "type": "session.finish"}).to_string()
}

#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    Interim(String),
    Completed(String),
    SpeechStopped(Option<u64>),
    Finished,
    Failed(Failure),
    Ignore,
}

pub fn parse(text: &str) -> Event {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return Event::Ignore;
    };
    let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
    match v["type"].as_str().unwrap_or_default() {
        "conversation.item.input_audio_transcription.text" => {
            Event::Interim(s("text") + &s("stash"))
        }
        "conversation.item.input_audio_transcription.completed" => {
            Event::Completed(s("transcript"))
        }
        "input_audio_buffer.speech_stopped" => Event::SpeechStopped(v["audio_end_ms"].as_u64()),
        "session.finished" => Event::Finished,
        "error" | "conversation.item.input_audio_transcription.failed" => {
            let e = &v["error"];
            Event::Failed(classify(
                e["code"].as_str().unwrap_or_default(),
                None,
                e["message"].as_str().unwrap_or_default(),
            ))
        }
        _ => Event::Ignore,
    }
}

fn closed(e: impl std::fmt::Display) -> Failure {
    Failure::Transient(format!("连接中断：{e}"))
}

pub async fn run(
    net: &Net,
    model: &Model,
    feed: &Feed,
    start: usize,
    emit: Emit<'_>,
) -> Result<(), Failure> {
    let mut ws = net
        .ws(&path(model), &[("OpenAI-Beta", "realtime=v1")])
        .await?;
    net::send(&mut ws, Message::text(session_update(model))).await?;

    let mut pos = start;
    let mut finishing = false;
    let mut last_stop: Option<u64> = None;
    let deadline = tokio::time::sleep(std::time::Duration::MAX / 4);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            chunk = feed.next(&mut pos), if !finishing => match chunk {
                Some(c) => net::send(&mut ws, Message::text(append(&c))).await?,
                None => {
                    net::send(&mut ws, Message::text(finish())).await?;
                    finishing = true;
                    deadline.as_mut().reset(tokio::time::Instant::now() + FINISH_TIMEOUT);
                }
            },
            msg = ws.next() => {
                let Some(msg) = msg else { return Err(Failure::Transient("连接被关闭".into())) };
                match msg.map_err(closed)? {
                    Message::Text(t) => match parse(&t) {
                        Event::Interim(text) => emit(Out::Interim(text)),
                        Event::Completed(text) => {
                            if text.is_empty() {
                                emit(Out::Interim(String::new()));
                            } else {
                                emit(Out::Final { text, end_ms: last_stop });
                            }
                        }
                        Event::SpeechStopped(ms) => last_stop = ms,
                        Event::Finished => {
                            net::close(&mut ws).await;
                            return Ok(());
                        }
                        Event::Failed(f) => return Err(f),
                        Event::Ignore => {}
                    },
                    Message::Close(_) => return Err(Failure::Transient("连接被关闭".into())),
                    _ => {}
                }
            }
            _ = &mut deadline => return Err(Failure::Transient("等待识别结果超时".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{MODELS, Protocol};

    #[test]
    fn messages() {
        let m = MODELS
            .iter()
            .find(|m| m.protocol == Protocol::Realtime)
            .unwrap();
        assert_eq!(
            path(m),
            "/api-ws/v1/realtime?model=qwen3-asr-flash-realtime"
        );
        let v: Value = serde_json::from_str(&session_update(m)).unwrap();
        assert_eq!(v["session"]["input_audio_format"], "pcm");
        assert_eq!(v["session"]["sample_rate"], 16000);
        let a: Value = serde_json::from_str(&append(&[1, 2, 3])).unwrap();
        assert_eq!(a["audio"], "AQID");
        // append 与 finish 都带唯一的 event_id
        let b: Value = serde_json::from_str(&append(&[1])).unwrap();
        let f: Value = serde_json::from_str(&finish()).unwrap();
        for v in [&a, &b, &f] {
            assert!(
                v["event_id"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("event_"))
            );
        }
        assert_ne!(a["event_id"], b["event_id"]);
        assert_eq!(f["type"], "session.finish");
    }

    #[test]
    fn parses_events() {
        assert_eq!(
            parse(
                r#"{"type":"conversation.item.input_audio_transcription.text","text":"你好","stash":"世"}"#
            ),
            Event::Interim("你好世".into())
        );
        assert_eq!(
            parse(
                r#"{"type":"conversation.item.input_audio_transcription.completed","transcript":"你好世界。"}"#
            ),
            Event::Completed("你好世界。".into())
        );
        assert_eq!(
            parse(r#"{"type":"input_audio_buffer.speech_stopped","audio_end_ms":2400}"#),
            Event::SpeechStopped(Some(2400))
        );
        assert!(matches!(
            parse(
                r#"{"type":"error","error":{"code":"AllocationQuota.FreeTierOnly","message":"x"}}"#
            ),
            Event::Failed(Failure::Quota(_))
        ));
        assert_eq!(parse(r#"{"type":"session.finished"}"#), Event::Finished);
    }
}
