//! 整段识别（HTTP）：等录音结束，把还没定稿的音频封成 WAV（Base64 data URL）一次发出。
//!
//! - 千问 3-ASR-Flash：OpenAI 兼容接口，结果在 `choices[0].message.content`。
//! - Fun-ASR-Flash、Qwen-Audio-ASR：DashScope 多模态接口，结果在 `output.text`。

use base64::Engine as _;
use serde_json::{Value, json};

use super::{Emit, Out};
use crate::audio::{BYTES_PER_MS, Feed, for_rate, wav};
use crate::failure::Failure;
use crate::hotwords;
use crate::models::{BATCH_MAX_SECONDS, Model, Protocol};
use crate::net::Net;

pub const COMPATIBLE_PATH: &str = "/compatible-mode/v1/chat/completions";
pub const MULTIMODAL_PATH: &str = "/api/v1/services/aigc/multimodal-generation/generation";

fn audio_part(wav_bytes: &[u8]) -> Value {
    let data = base64::engine::general_purpose::STANDARD.encode(wav_bytes);
    json!({"type": "input_audio", "input_audio": {"data": format!("data:audio/wav;base64,{data}")}})
}

pub fn request(model: &Model, wav_bytes: &[u8]) -> (&'static str, Value) {
    let audio = json!({"role": "user", "content": [audio_part(wav_bytes)]});
    let context = hotwords::context();
    match model.protocol {
        // 千问 3-ASR-Flash：热词作为 system 上下文
        Protocol::Compatible => (
            COMPATIBLE_PATH,
            json!({
                "model": model.id,
                "messages": [{"role": "system", "content": [{"type": "text", "text": context}]}, audio],
                "stream": false
            }),
        ),
        // 多模态接口：音频前一条 input_text 作上下文。实测上下文比即时热词准
        // （Fun-ASR-Flash 带热词反而把 Primus 认成 PROMPTS），所以这里只带上下文。
        _ => (
            MULTIMODAL_PATH,
            json!({
                "model": model.id,
                "input": {"messages": [
                    {"role": "user", "content": [{"type": "input_text", "text": context}]},
                    audio
                ]},
                "parameters": {"format": "wav", "sample_rate": model.sample_rate.to_string()}
            }),
        ),
    }
}

/// 兼容接口请求里音频（Base64 data URL）的大小上限：接口要求编码后不超过 10 MB，留出余量
pub const MAX_ENCODED_BYTES: usize = 9 * 1024 * 1024;

/// 这款模型发不下这段 WAV
pub fn too_large(model: &Model, wav_len: usize) -> bool {
    model.protocol == Protocol::Compatible && encoded_len(wav_len) > MAX_ENCODED_BYTES
}

/// Base64 编码后的长度
pub fn encoded_len(raw: usize) -> usize {
    raw.div_ceil(3) * 4
}

/// 从响应里取识别文本
pub fn text_of(res: &Value) -> Option<String> {
    let candidates = [
        &res["choices"][0]["message"]["content"],
        &res["output"]["text"],
        &res["output"]["sentence"]["text"],
        &res["output"]["output"]["text"],
    ];
    candidates
        .iter()
        .find_map(|v| v.as_str())
        .map(|s| s.trim().to_string())
}

pub async fn run(
    net: &Net,
    model: &Model,
    feed: &Feed,
    start: usize,
    emit: Emit<'_>,
) -> Result<(), Failure> {
    feed.wait_closed().await;
    let pcm = feed.slice_from(start);
    if pcm.len() < 100 * BYTES_PER_MS {
        // 不足 0.1 秒：没有可识别的内容
        return Ok(());
    }
    if pcm.len() > BATCH_MAX_SECONDS * 1000 * BYTES_PER_MS {
        return Err(Failure::Unsuited("录音超过整段识别的时长上限".into()));
    }
    let audio = wav(&for_rate(&pcm, model.sample_rate), model.sample_rate);
    // 只有兼容接口（qwen3-asr-flash）限制编码后 10 MB；Multimodal 接口上限 2 GB、5 分钟，时长已在上面检查
    if too_large(model, audio.len()) {
        return Err(Failure::Unsuited("录音超过整段识别的大小上限".into()));
    }
    let (path, body) = request(model, &audio);
    let res = net.post_json(path, &body).await?;
    match text_of(&res) {
        Some(text) => {
            if !text.is_empty() {
                emit(Out::Final { text, end_ms: None });
            }
            Ok(())
        }
        None => Err(Failure::Transient("响应里没有识别结果".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MODELS;

    #[test]
    fn size_limit_is_after_encoding() {
        // 280 秒 16 kHz 录音的 WAV 编码后超过上限；8 kHz 时在上限内
        assert!(encoded_len(280 * 1000 * BYTES_PER_MS + 44) > MAX_ENCODED_BYTES);
        assert!(encoded_len(280 * 1000 * BYTES_PER_MS / 2 + 44) < MAX_ENCODED_BYTES);
        assert_eq!(encoded_len(3), 4);
        // 只有兼容接口受这个限制
        let long = 270 * 1000 * BYTES_PER_MS + 44;
        for m in crate::models::MODELS.iter() {
            match m.protocol {
                Protocol::Compatible => assert!(too_large(m, long)),
                Protocol::Multimodal => assert!(!too_large(m, long)),
                _ => {}
            }
        }
        assert_eq!(encoded_len(4), 8);
    }

    #[test]
    fn request_shapes() {
        let flash = MODELS
            .iter()
            .find(|m| m.protocol == Protocol::Compatible)
            .unwrap();
        let (p, b) = request(flash, b"RIFF");
        assert_eq!(p, COMPATIBLE_PATH);
        assert_eq!(b["model"], "qwen3-asr-flash");
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(
            b["messages"][1]["content"][0]["input_audio"]["data"],
            "data:audio/wav;base64,UklGRg=="
        );
        let mm = MODELS
            .iter()
            .find(|m| m.protocol == Protocol::Multimodal)
            .unwrap();
        let (p, b) = request(mm, b"RIFF");
        assert_eq!(p, MULTIMODAL_PATH);
        assert_eq!(b["parameters"]["sample_rate"], "16000");
        assert!(b["input"]["messages"][1]["content"][0]["input_audio"].is_object());
        assert!(
            b["input"]["messages"][0]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("小元")
        );
    }

    #[test]
    fn reads_text_from_both_responses() {
        let compat =
            json!({"choices":[{"message":{"content":"hello world，这里是阿里巴巴语音实验室。"}}]});
        assert_eq!(
            text_of(&compat).as_deref(),
            Some("hello world，这里是阿里巴巴语音实验室。")
        );
        let mm = json!({"output":{"sentence":{"text":"你好。"},"text":"你好。"}});
        assert_eq!(text_of(&mm).as_deref(), Some("你好。"));
        assert_eq!(text_of(&json!({"output": {}})), None);
    }
}
