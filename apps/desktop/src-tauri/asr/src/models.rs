//! 模型链：阿里云百炼（华北 2 北京）有免费额度、又能用来听写的 10 款语音识别模型，按使用顺序排列。
//!
//! 排序：90 天有效期的额度先用（过期就作废），每月 1 日重置的 Paraformer 放最后长期兜底；
//! 同一档里实时识别（边说边出字）在前，整段识别（松开后才出字）在后，8 kHz 电话模型最后。

/// 模型走的接口。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    /// `wss://…/api-ws/v1/inference`：run-task / 二进制音频 / finish-task（Paraformer、Fun-ASR、Qwen-Audio 实时）
    Duplex,
    /// `wss://…/api-ws/v1/realtime?model=`：session.update / input_audio_buffer.append / session.finish（千问 3-ASR-Realtime）
    Realtime,
    /// `POST …/compatible-mode/v1/chat/completions`，整段音频（千问 3-ASR-Flash）
    Compatible,
    /// `POST …/api/v1/services/aigc/multimodal-generation/generation`，整段音频（Fun-ASR-Flash、Qwen-Audio-ASR）
    Multimodal,
}

impl Protocol {
    /// 边录边识别；否则要等停止录音后整段识别
    pub fn streaming(self) -> bool {
        matches!(self, Protocol::Duplex | Protocol::Realtime)
    }
}

/// 免费额度怎么恢复。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quota {
    /// 开通后 90 天内有效的一次性额度：用完就不再恢复
    OneOff,
    /// 每月 1 日 0 点（北京时间）重新发放
    Monthly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Model {
    pub id: &'static str,
    pub protocol: Protocol,
    /// 发给模型的采样率（麦克风音频统一是 16 kHz，8 kHz 模型先降采样）
    pub sample_rate: u32,
    pub quota: Quota,
}

const fn m(id: &'static str, protocol: Protocol, sample_rate: u32, quota: Quota) -> Model {
    Model {
        id,
        protocol,
        sample_rate,
        quota,
    }
}

/// 使用顺序（第一款可用的先用，额度用完或出错换下一款）。
pub const MODELS: [Model; 10] = [
    m(
        "qwen3-asr-flash-realtime",
        Protocol::Realtime,
        16_000,
        Quota::OneOff,
    ),
    m("fun-asr-realtime", Protocol::Duplex, 16_000, Quota::OneOff),
    m(
        "qwen-audio-3.1-asr-flash-streaming",
        Protocol::Duplex,
        16_000,
        Quota::OneOff,
    ),
    m(
        "qwen-audio-3.1-asr-flash-message",
        Protocol::Duplex,
        16_000,
        Quota::OneOff,
    ),
    m(
        "qwen3-asr-flash",
        Protocol::Compatible,
        16_000,
        Quota::OneOff,
    ),
    m(
        "fun-asr-flash-2026-06-15",
        Protocol::Multimodal,
        16_000,
        Quota::OneOff,
    ),
    m(
        "qwen-audio-3.1-asr-flash",
        Protocol::Multimodal,
        16_000,
        Quota::OneOff,
    ),
    m(
        "paraformer-realtime-v2",
        Protocol::Duplex,
        16_000,
        Quota::Monthly,
    ),
    m(
        "fun-asr-flash-8k-realtime",
        Protocol::Duplex,
        8_000,
        Quota::OneOff,
    ),
    m(
        "paraformer-realtime-8k-v2",
        Protocol::Duplex,
        8_000,
        Quota::Monthly,
    ),
];

/// 整段识别的模型一次最多 5 分钟：留出余量，超过 280 秒的录音跳过这些模型
pub const BATCH_MAX_SECONDS: usize = 280;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_distinct_models() {
        let mut ids: Vec<_> = MODELS.iter().map(|m| m.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 10);
    }

    #[test]
    fn monthly_quota_models_come_last_among_16k() {
        let first_monthly = MODELS
            .iter()
            .position(|m| m.quota == Quota::Monthly)
            .unwrap();
        assert!(
            MODELS[..first_monthly]
                .iter()
                .all(|m| m.quota == Quota::OneOff && m.sample_rate == 16_000)
        );
    }
}
