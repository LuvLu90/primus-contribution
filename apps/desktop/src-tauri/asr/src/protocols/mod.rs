//! 各模型的接口。每个 `run` 从录音缓冲的 `start` 处开始识别，把结果交给 `emit`，
//! 正常结束（录音停止且服务端返回全部结果）为 Ok，任何失败按 [`Failure`](crate::failure::Failure) 分类返回。

pub mod batch;
pub mod duplex;
pub mod realtime;

/// 识别结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Out {
    /// 当前这一句的临时文本（随时被替换）
    Interim(String),
    /// 定稿的一句；`end_ms` 为这句在本次识别音频里的结束时间（毫秒），换模型时从这里之后重放
    Final { text: String, end_ms: Option<u64> },
}

pub type Emit<'a> = &'a (dyn Fn(Out) + Send + Sync);

/// 等服务端收尾（发出结束指令后）的最长时间
pub const FINISH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// 等任务开始的最长时间
pub const START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
