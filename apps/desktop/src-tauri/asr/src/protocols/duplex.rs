//! `wss://dashscope.aliyuncs.com/api-ws/v1/inference`：Paraformer、Fun-ASR、Qwen-Audio 的实时识别。
//!
//! 流程：run-task → 等 task-started → 发二进制 PCM → 录音结束发 finish-task → 等 task-finished。
//! 结果在 result-generated 事件的 `payload.output.sentence`：`sentence_end` 为真时是定稿。

use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use super::{Emit, FINISH_TIMEOUT, Out, START_TIMEOUT};
use crate::audio::{Feed, downsample_half};
use crate::failure::{Failure, classify};
use crate::models::Model;
use crate::net::{self, Net};

pub const PATH: &str = "/api-ws/v1/inference";

pub fn run_task(model: &Model, task_id: &str) -> String {
    json!({
        "header": {"action": "run-task", "task_id": task_id, "streaming": "duplex"},
        "payload": {
            "task_group": "audio",
            "task": "asr",
            "function": "recognition",
            "model": model.id,
            "parameters": {"format": "pcm", "sample_rate": model.sample_rate},
            "input": {}
        }
    })
    .to_string()
}

pub fn finish_task(task_id: &str) -> String {
    json!({
        "header": {"action": "finish-task", "task_id": task_id, "streaming": "duplex"},
        "payload": {"input": {}}
    })
    .to_string()
}

/// 服务端事件
#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    Started,
    Result(Out),
    Finished,
    Failed(Failure),
    /// 心跳、空结果或不认识的事件
    Ignore,
}

pub fn parse(text: &str) -> Event {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return Event::Ignore;
    };
    let header = &v["header"];
    match header["event"].as_str().unwrap_or_default() {
        "task-started" => Event::Started,
        "task-finished" => Event::Finished,
        "task-failed" => Event::Failed(classify(
            header["error_code"].as_str().unwrap_or_default(),
            None,
            header["error_message"].as_str().unwrap_or_default(),
        )),
        "result-generated" => {
            let s = &v["payload"]["output"]["sentence"];
            if s["heartbeat"].as_bool() == Some(true) {
                return Event::Ignore;
            }
            let text = s["text"].as_str().unwrap_or_default().to_string();
            if s["sentence_end"].as_bool() == Some(true) {
                if text.is_empty() {
                    return Event::Ignore;
                }
                Event::Result(Out::Final {
                    text,
                    end_ms: s["end_time"].as_u64(),
                })
            } else {
                Event::Result(Out::Interim(text))
            }
        }
        _ => Event::Ignore,
    }
}

/// 32 位十六进制的任务 ID
pub fn task_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    (0..2)
        .map(|i| {
            let mut h = RandomState::new().build_hasher();
            h.write_u32(i);
            format!("{:016x}", h.finish())
        })
        .collect()
}

/// 把 16 kHz 音频块转成模型的采样率；8 kHz 时不足 4 字节的尾巴留到下一块
pub struct Resampler {
    rate: u32,
    carry: Vec<u8>,
}

impl Resampler {
    pub fn new(rate: u32) -> Self {
        Self {
            rate,
            carry: Vec::new(),
        }
    }

    pub fn convert(&mut self, chunk: &[u8]) -> Vec<u8> {
        if self.rate != 8_000 {
            return chunk.to_vec();
        }
        self.carry.extend_from_slice(chunk);
        let usable = self.carry.len() / 4 * 4;
        let out = downsample_half(&self.carry[..usable]);
        self.carry.drain(..usable);
        out
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
    let mut ws = net.ws(PATH, &[]).await?;
    let id = task_id();
    net::send(&mut ws, Message::text(run_task(model, &id))).await?;

    // 等任务开始（额度用完、模型不可用多在这里返回 task-failed）
    let started = tokio::time::timeout(START_TIMEOUT, async {
        while let Some(msg) = ws.next().await {
            match msg.map_err(closed)? {
                Message::Text(t) => match parse(&t) {
                    Event::Started => return Ok(()),
                    Event::Failed(f) => return Err(f),
                    _ => {}
                },
                Message::Close(_) => return Err(Failure::Transient("连接被关闭".into())),
                _ => {}
            }
        }
        Err(Failure::Transient("连接被关闭".into()))
    })
    .await
    .map_err(|_| Failure::Transient("任务启动超时".into()))?;
    started?;

    let mut resampler = Resampler::new(model.sample_rate);
    let mut pos = start;
    let mut finishing = false;
    let deadline = tokio::time::sleep(std::time::Duration::MAX / 4);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            chunk = feed.next(&mut pos), if !finishing => match chunk {
                Some(c) => {
                    let pcm = resampler.convert(&c);
                    if !pcm.is_empty() {
                        net::send(&mut ws, Message::binary(pcm)).await?;
                    }
                }
                None => {
                    net::send(&mut ws, Message::text(finish_task(&id))).await?;
                    finishing = true;
                    deadline.as_mut().reset(tokio::time::Instant::now() + FINISH_TIMEOUT);
                }
            },
            msg = ws.next() => {
                let Some(msg) = msg else { return Err(Failure::Transient("连接被关闭".into())) };
                match msg.map_err(closed)? {
                    Message::Text(t) => match parse(&t) {
                        Event::Result(out) => emit(out),
                        Event::Finished => {
                            net::close(&mut ws).await;
                            return Ok(());
                        }
                        Event::Failed(f) => return Err(f),
                        _ => {}
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
    use crate::models::MODELS;

    #[test]
    fn run_task_carries_model_and_rate() {
        let m = MODELS.iter().find(|m| m.sample_rate == 8_000).unwrap();
        let v: Value = serde_json::from_str(&run_task(m, "abc")).unwrap();
        assert_eq!(v["header"]["action"], "run-task");
        assert_eq!(v["payload"]["model"], m.id);
        assert_eq!(v["payload"]["parameters"]["sample_rate"], 8000);
        assert_eq!(v["payload"]["parameters"]["format"], "pcm");
    }

    #[test]
    fn parses_results_and_failures() {
        let interim = r#"{"header":{"event":"result-generated"},"payload":{"output":{"sentence":{"text":"你好","sentence_end":false}}}}"#;
        assert_eq!(parse(interim), Event::Result(Out::Interim("你好".into())));
        let fin = r#"{"header":{"event":"result-generated"},"payload":{"output":{"sentence":{"text":"你好。","sentence_end":true,"end_time":1820}}}}"#;
        assert_eq!(
            parse(fin),
            Event::Result(Out::Final {
                text: "你好。".into(),
                end_ms: Some(1820)
            })
        );
        let hb = r#"{"header":{"event":"result-generated"},"payload":{"output":{"sentence":{"heartbeat":true}}}}"#;
        assert_eq!(parse(hb), Event::Ignore);
        let failed = r#"{"header":{"event":"task-failed","error_code":"AllocationQuota.FreeTierOnly","error_message":"free tier exhausted"}}"#;
        assert!(matches!(parse(failed), Event::Failed(Failure::Quota(_))));
        assert_eq!(
            parse(r#"{"header":{"event":"task-started"}}"#),
            Event::Started
        );
    }

    #[test]
    fn task_id_is_32_hex() {
        let id = task_id();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn resampler_keeps_odd_tail() {
        let mut r = Resampler::new(8_000);
        assert_eq!(r.convert(&[0, 0, 0, 0, 1, 0]).len(), 2);
        assert_eq!(r.convert(&[1, 0]).len(), 2);
        let mut same = Resampler::new(16_000);
        assert_eq!(same.convert(&[1, 2, 3, 4]), vec![1, 2, 3, 4]);
    }
}
