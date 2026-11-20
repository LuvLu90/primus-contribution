//! 热词：乾元里常说、但通用识别容易认错的词（如“乾元”被认成“前沿”，“Primus”被认成“Promax”）。
//!
//! 按各模型支持的方式带上：
//! - 实时的 Qwen-Audio-ASR、Fun-ASR：`parameters.vocabulary`（即时热词，`{"词": 权重}`，权重 1–5）。
//! - 整段的 Fun-ASR-Flash、Qwen-Audio-ASR：音频前加一条 `input_text` 作上下文（实测比热词准）。
//! - 千问 3-ASR-Flash（整段）：system 消息里放词表作上下文。
//! - 千问 3-ASR-Flash-Realtime：`session.input_audio_transcription.corpus.text`。
//! - Paraformer、Fun-ASR 8k：只支持预建词表（`vocabulary_id`），暂不带。
//!
//! 百炼限制：中文词不超过 15 字，英文词不超过 7 段；上下文每轮不超过 400 字。

use serde_json::{Map, Value, json};

/// 普通热词的权重（官方建议 4）
const WEIGHT: u8 = 4;
/// 最容易认错的产品名，权重拉满
const STRONG: u8 = 5;

/// (词, 权重)。新增词时注意上面的长度限制，并保持 [`context`] 不超过 400 字。
pub const HOTWORDS: &[(&str, u8)] = &[
    // 产品与助手
    ("乾元", STRONG),
    ("小元", STRONG),
    ("Primus", STRONG),
    ("乾元 Primus", WEIGHT),
    // 平台概念
    ("Agent", WEIGHT),
    ("子 Agent", WEIGHT),
    ("MCP", WEIGHT),
    ("Skill", WEIGHT),
    ("技能", WEIGHT),
    ("能力中心", WEIGHT),
    ("计划模式", WEIGHT),
    ("自动编辑", WEIGHT),
    ("完全访问", WEIGHT),
    ("检查点", WEIGHT),
    ("上下文", WEIGHT),
    ("压缩上下文", WEIGHT),
    ("工作区", WEIGHT),
    ("会话", WEIGHT),
    ("新会话", WEIGHT),
    ("插话", WEIGHT),
    ("守卫", WEIGHT),
    ("联网搜索", WEIGHT),
    ("提示词", WEIGHT),
    ("渠道", WEIGHT),
    ("终端", WEIGHT),
    ("Token", WEIGHT),
    // 开发
    ("PR", WEIGHT),
    ("main", WEIGHT),
    ("dev", WEIGHT),
    ("GitHub", WEIGHT),
    ("Tauri", WEIGHT),
    ("Biome", WEIGHT),
    ("Vitest", WEIGHT),
    ("Cursor", WEIGHT),
    ("Codex", WEIGHT),
    // 模型
    ("Claude", WEIGHT),
    ("Opus", WEIGHT),
    ("Sonnet", WEIGHT),
    ("GPT", WEIGHT),
    ("Gemini", WEIGHT),
    ("Kimi", WEIGHT),
    ("DeepSeek", WEIGHT),
    ("Qwen", WEIGHT),
    ("千问", WEIGHT),
];

/// 即时热词：`{"词": 权重, …}`，放进 `parameters.vocabulary`
pub fn vocabulary() -> Value {
    let map: Map<String, Value> = HOTWORDS
        .iter()
        .map(|(w, n)| ((*w).to_string(), json!(n)))
        .collect();
    Value::Object(map)
}

/// 这款实时模型的 run-task 里能不能带即时热词（`parameters.vocabulary`）。
///
/// 百炼文档里支持即时热词的只有 Qwen-Audio-ASR 系列；Fun-ASR-Realtime、Paraformer、Fun-ASR 8k
/// 只认预先建好的 `vocabulary_id`，不带，免得未知参数被当成“模型用不了”而停用一天。
pub fn takes_vocabulary(model_id: &str) -> bool {
    model_id.starts_with("qwen-audio-") || model_id.starts_with("fun-asr-flash-2")
}

/// 上下文文本：先用一句话交代产品名，再列词表。只列词表时千问会把“小元”认成“小袁”。
pub fn context() -> String {
    let words: Vec<&str> = HOTWORDS.iter().map(|(w, _)| *w).collect();
    format!(
        "这是在乾元（Primus）里对 AI 助手小元说的话。常用词：{}",
        words.join("、")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_within_limits() {
        for (w, n) in HOTWORDS {
            assert!((1..=5).contains(n), "{w}");
            if w.is_ascii() {
                assert!(w.split(' ').count() <= 7, "{w}");
            } else {
                assert!(w.chars().count() <= 15, "{w}");
            }
        }
    }

    #[test]
    fn no_duplicates() {
        let mut seen = std::collections::HashSet::new();
        for (w, _) in HOTWORDS {
            assert!(seen.insert(*w), "重复：{w}");
        }
    }

    #[test]
    fn context_fits_one_turn() {
        assert!(context().chars().count() <= 400);
    }

    #[test]
    fn vocabulary_only_where_supported() {
        for m in crate::models::MODELS {
            let expect = !m.id.starts_with("paraformer")
                && !m.id.contains("8k")
                && !m.id.starts_with("qwen3-")
                && m.id != "fun-asr-realtime";
            assert_eq!(takes_vocabulary(m.id), expect, "{}", m.id);
        }
    }

    #[test]
    fn includes_requested_words() {
        let v = vocabulary();
        for w in ["小元", "乾元", "Primus", "Agent"] {
            assert!(v.get(w).is_some(), "{w}");
        }
    }
}
