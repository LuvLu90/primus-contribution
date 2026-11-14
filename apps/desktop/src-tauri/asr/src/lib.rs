//! 乾元内置的语音转文字。
//!
//! 用户只管点麦克风：麦克风音频（16 kHz、16 位、单声道 PCM）由薄壳交进来，这里按 [`models::MODELS`]
//! 的顺序调用阿里云百炼的语音识别模型；一款免费额度用完或出错，就从还没定稿的位置把录音交给下一款，
//! 用户看不到用的是哪款。全部不可用时只发 [`Event::Unavailable`]（界面提示“语音转文字暂不可用”）。
//!
//! - 密钥在构建时注入（环境变量 `PRIMUS_ASR_KEY`，见 build.rs），不进仓库、不出现在界面与日志里。
//! - 各模型暂停到什么时候记在一个小 JSON 文件里（[`state`]），不记录任何音频与文字。
//! - 录音只在内存里，会话结束即丢弃。

pub mod audio;
pub mod failure;
pub mod models;
pub mod net;
pub mod protocols;
pub mod state;

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use audio::{BYTES_PER_MS, Feed};
use failure::Failure;
use models::{MODELS, Model, Protocol};
use protocols::{Emit, Out};
use state::State;

include!(concat!(env!("OUT_DIR"), "/key.rs"));

/// 构建时注入的密钥；调试构建没有注入时可用运行时环境变量 PRIMUS_ASR_KEY 代替
fn embedded_key() -> String {
    let key: Vec<u8> = KEY_DATA
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ KEY_MASK[i % KEY_MASK.len()])
        .collect();
    let key = String::from_utf8(key).unwrap_or_default();
    if key.is_empty() && cfg!(debug_assertions) {
        return std::env::var("PRIMUS_ASR_KEY").unwrap_or_default();
    }
    key
}

/// 推给界面的事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// 当前这一句的临时文本（空串表示清掉）
    Interim(String),
    /// 定稿的一句
    Final(String),
    /// 语音转文字暂不可用（所有模型都用不了或网络不通）；随后 End
    Unavailable,
    /// 会话结束
    End,
}

pub type Sink = Arc<dyn Fn(Event) + Send + Sync>;

pub type BoxFuture<'a> = Pin<Box<dyn Future<Output = Result<(), Failure>> + Send + 'a>>;

/// 调用一款模型（测试里用假的实现）
pub trait Backend: Send + Sync + 'static {
    fn run<'a>(
        &'a self,
        model: &'a Model,
        feed: &'a Feed,
        start: usize,
        emit: Emit<'a>,
    ) -> BoxFuture<'a>;
}

/// 百炼
pub struct Bailian {
    net: net::Net,
}

impl Backend for Bailian {
    fn run<'a>(
        &'a self,
        model: &'a Model,
        feed: &'a Feed,
        start: usize,
        emit: Emit<'a>,
    ) -> BoxFuture<'a> {
        Box::pin(async move {
            match model.protocol {
                Protocol::Duplex => {
                    protocols::duplex::run(&self.net, model, feed, start, emit).await
                }
                Protocol::Realtime => {
                    protocols::realtime::run(&self.net, model, feed, start, emit).await
                }
                Protocol::Compatible | Protocol::Multimodal => {
                    protocols::batch::run(&self.net, model, feed, start, emit).await
                }
            }
        })
    }
}

/// 连续几次临时错误（网络不通）就不再往下试，直接提示不可用。实时模型（WebSocket）连续出错时
/// 先跳到整段识别的模型（HTTPS）再试，两种连接方式都不通才提示不可用
const MAX_TRANSIENT: usize = 2;

struct Shared {
    backend: Box<dyn Backend>,
    models: Vec<Model>,
    state: Mutex<State>,
    now: fn() -> u64,
}

pub struct Asr {
    shared: Option<Arc<Shared>>,
    runtime: Option<tokio::runtime::Runtime>,
    /// 当前会话的录音；会话结束（识别完或全部失败）时清掉，录音随之释放
    feed: Arc<Mutex<Option<Arc<Feed>>>>,
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

impl Asr {
    /// `state_path`：模型暂停记录的文件（应用数据目录下）
    pub fn new(state_path: Option<PathBuf>) -> Self {
        let key = embedded_key();
        let net = (!key.is_empty()).then(|| net::Net::new(key).ok()).flatten();
        match net {
            Some(net) => Self::with_backend(
                Box::new(Bailian { net }),
                MODELS.to_vec(),
                State::load(state_path),
                unix_now,
            ),
            None => Self {
                shared: None,
                runtime: None,
                feed: Arc::new(Mutex::new(None)),
            },
        }
    }

    pub fn with_backend(
        backend: Box<dyn Backend>,
        models: Vec<Model>,
        state: State,
        now: fn() -> u64,
    ) -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("primus-asr")
            .enable_all()
            .build()
            .ok();
        Self {
            shared: runtime.as_ref().map(|_| {
                Arc::new(Shared {
                    backend,
                    models,
                    state: Mutex::new(state),
                    now,
                })
            }),
            runtime,
            feed: Arc::new(Mutex::new(None)),
        }
    }

    /// 是否可用（构建时注入了密钥）
    pub fn available(&self) -> bool {
        self.shared.is_some()
    }

    /// 开始一次听写（已有会话时先结束它）
    pub fn start(&self, sink: Sink) {
        let (Some(shared), Some(rt)) = (&self.shared, &self.runtime) else {
            sink(Event::Unavailable);
            sink(Event::End);
            return;
        };
        let feed = Arc::new(Feed::default());
        if let Some(old) = self.feed.lock().unwrap().replace(feed.clone()) {
            old.close();
        }
        let active = self.feed.clone();
        let shared = shared.clone();
        rt.spawn(async move {
            run_session(shared, feed.clone(), sink).await;
            // 会话结束：释放录音（只清自己的，不动之后新开始的会话）
            let mut slot = active.lock().unwrap();
            if slot.as_ref().is_some_and(|f| Arc::ptr_eq(f, &feed)) {
                *slot = None;
            }
        });
    }

    /// 麦克风音频（16 kHz、16 位、单声道、小端 PCM）
    pub fn push(&self, pcm: &[u8]) {
        if let Some(feed) = self.feed.lock().unwrap().as_ref() {
            feed.push(pcm);
        }
    }

    /// 停止录音：已录的音频识别完后推送 End
    pub fn stop(&self) {
        if let Some(feed) = self.feed.lock().unwrap().take() {
            feed.close();
        }
    }
}

async fn run_session(shared: Arc<Shared>, feed: Arc<Feed>, sink: Sink) {
    let committed = Arc::new(AtomicUsize::new(0));
    let mut transient = 0;
    let mut next = 0;
    // 实时模型（WebSocket）连不上时改用整段识别的模型（HTTPS，连接方式不同）
    let mut skip_streaming = false;
    loop {
        let now = (shared.now)();
        let pick = {
            let state = shared.state.lock().unwrap();
            (next..shared.models.len()).find(|&i| {
                let m = &shared.models[i];
                state.usable(m, now) && !(skip_streaming && m.protocol.streaming())
            })
        };
        let Some(i) = pick else { break };
        next = i + 1;
        let model = &shared.models[i];
        let start = committed.load(Ordering::SeqCst);
        let emit = {
            let (sink, committed, feed) = (sink.clone(), committed.clone(), feed.clone());
            move |out: Out| match out {
                Out::Interim(text) => sink(Event::Interim(text)),
                Out::Final { text, end_ms } => {
                    // 定稿的一句没有结束时间：以定稿到达时已录到的位置为检查点（已录长度不小于句末），
                    // 换模型时从这里重放，不会跳过定稿之后才录的音频
                    let pos = match end_ms {
                        Some(ms) => (start + ms as usize * BYTES_PER_MS).min(feed.len()),
                        None => feed.len(),
                    };
                    committed.fetch_max(pos & !1, Ordering::SeqCst);
                    sink(Event::Final(text));
                }
            }
        };
        let result = shared.backend.run(model, &feed, start, &emit).await;
        match result {
            Ok(()) => {
                shared.state.lock().unwrap().clear(model);
                sink(Event::End);
                return;
            }
            Err(failure) => {
                sink(Event::Interim(String::new()));
                shared.state.lock().unwrap().record(model, &failure, now);
                if matches!(failure, Failure::Transient(_)) {
                    transient += 1;
                    if transient >= MAX_TRANSIENT {
                        if model.protocol.streaming() && !skip_streaming {
                            skip_streaming = true;
                            transient = 0;
                            continue;
                        }
                        break;
                    }
                } else {
                    transient = 0;
                }
            }
        }
    }
    sink(Event::Unavailable);
    sink(Event::End);
    // 没有模型可用：丢弃之后送来的音频
    feed.close();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Quota;
    use std::collections::VecDeque;

    /// 按脚本返回结果的假模型：每次调用取一条脚本，记录调用的模型与起点
    struct Fake {
        script: Mutex<VecDeque<Vec<Step>>>,
        calls: Arc<Mutex<Vec<(&'static str, usize)>>>,
    }

    #[derive(Clone)]
    enum Step {
        Emit(Out),
        /// 等录音结束
        WaitClosed,
        Fail(Failure),
    }

    impl Backend for Fake {
        fn run<'a>(
            &'a self,
            model: &'a Model,
            feed: &'a Feed,
            start: usize,
            emit: Emit<'a>,
        ) -> BoxFuture<'a> {
            self.calls.lock().unwrap().push((model.id, start));
            let steps = self.script.lock().unwrap().pop_front().unwrap_or_default();
            Box::pin(async move {
                for step in steps {
                    match step {
                        Step::Emit(out) => emit(out),
                        Step::WaitClosed => feed.wait_closed().await,
                        Step::Fail(f) => return Err(f),
                    }
                }
                Ok(())
            })
        }
    }

    fn model(id: &'static str, quota: Quota) -> Model {
        Model {
            id,
            protocol: Protocol::Duplex,
            sample_rate: 16_000,
            quota,
        }
    }

    const NOW: u64 = 1_794_656_460;

    type Calls = Arc<Mutex<Vec<(&'static str, usize)>>>;
    type Events = Arc<Mutex<Vec<Event>>>;

    fn setup(script: Vec<Vec<Step>>) -> (Asr, Calls, Events, Sink) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let fake = Fake {
            script: Mutex::new(script.into()),
            calls: calls.clone(),
        };
        let models = vec![
            model("a", Quota::OneOff),
            model("b", Quota::OneOff),
            model("c", Quota::Monthly),
        ];
        let asr = Asr::with_backend(Box::new(fake), models, State::load(None), || NOW);
        let events = Arc::new(Mutex::new(Vec::new()));
        let ev = events.clone();
        let sink: Sink = Arc::new(move |e| ev.lock().unwrap().push(e));
        (asr, calls, events, sink)
    }

    fn wait_end(events: &Events) -> Vec<Event> {
        for _ in 0..200 {
            if events.lock().unwrap().last() == Some(&Event::End) {
                return events.lock().unwrap().clone();
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("没有收到 End：{:?}", events.lock().unwrap());
    }

    fn quota() -> Failure {
        Failure::Quota("AllocationQuota.FreeTierOnly".into())
    }

    #[test]
    fn first_model_works() {
        let (asr, calls, events, sink) = setup(vec![vec![
            Step::Emit(Out::Interim("你".into())),
            Step::WaitClosed,
            Step::Emit(Out::Final {
                text: "你好。".into(),
                end_ms: Some(500),
            }),
        ]]);
        asr.start(sink);
        asr.push(&[0; 3200]);
        asr.stop();
        let ev = wait_end(&events);
        assert_eq!(
            ev,
            vec![
                Event::Interim("你".into()),
                Event::Final("你好。".into()),
                Event::End
            ]
        );
        assert_eq!(*calls.lock().unwrap(), vec![("a", 0)]);
    }

    #[test]
    fn quota_switches_and_replays_from_last_final() {
        let (asr, calls, events, sink) = setup(vec![
            vec![
                Step::WaitClosed,
                Step::Emit(Out::Final {
                    text: "第一句。".into(),
                    end_ms: Some(100),
                }),
                Step::Fail(quota()),
            ],
            vec![Step::Emit(Out::Final {
                text: "第二句。".into(),
                end_ms: Some(50),
            })],
        ]);
        asr.push(&[0; 10]); // 没有会话时丢弃
        asr.start(sink);
        asr.push(&[0; 32 * 300]);
        asr.stop();
        let ev = wait_end(&events);
        assert_eq!(
            ev,
            vec![
                Event::Final("第一句。".into()),
                Event::Interim(String::new()),
                Event::Final("第二句。".into()),
                Event::End
            ]
        );
        // 第二款从第一句结束（100 ms = 3200 字节）处开始
        assert_eq!(*calls.lock().unwrap(), vec![("a", 0), ("b", 3200)]);
        // 第一款记为额度用完：下一次直接从第二款开始
        let shared = asr.shared.as_ref().unwrap();
        assert!(!shared.state.lock().unwrap().usable(&shared.models[0], NOW));
    }

    #[test]
    fn all_exhausted_is_unavailable() {
        let (asr, calls, events, sink) = setup(vec![
            vec![Step::Fail(quota())],
            vec![Step::Fail(Failure::Unusable("Model.AccessDenied".into()))],
            vec![Step::Fail(quota())],
        ]);
        asr.start(sink.clone());
        let ev = wait_end(&events);
        assert_eq!(ev.iter().filter(|e| **e == Event::Unavailable).count(), 1);
        assert_eq!(calls.lock().unwrap().len(), 3);
        // 再开始一次：所有模型都在暂停期，不再调用
        events.lock().unwrap().clear();
        asr.start(sink);
        assert_eq!(wait_end(&events), vec![Event::Unavailable, Event::End]);
        assert_eq!(calls.lock().unwrap().len(), 3);
    }

    #[test]
    fn websocket_down_falls_back_to_https() {
        let net = || Failure::Transient("连接失败".into());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let fake = Fake {
            script: Mutex::new(
                vec![
                    vec![Step::Fail(net())],
                    vec![Step::Fail(net())],
                    vec![
                        Step::WaitClosed,
                        Step::Emit(Out::Final {
                            text: "好。".into(),
                            end_ms: None,
                        }),
                    ],
                ]
                .into(),
            ),
            calls: calls.clone(),
        };
        let mut batch = model("batch", Quota::OneOff);
        batch.protocol = Protocol::Compatible;
        let models = vec![
            model("a", Quota::OneOff),
            model("b", Quota::OneOff),
            model("c", Quota::OneOff),
            batch,
        ];
        let asr = Asr::with_backend(Box::new(fake), models, State::load(None), || NOW);
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let ev = events.clone();
        let sink: Sink = Arc::new(move |e| ev.lock().unwrap().push(e));
        asr.start(sink);
        asr.push(&[0; 3200]);
        asr.stop();
        let got = wait_end(&events);
        assert!(got.contains(&Event::Final("好。".into())));
        assert!(!got.contains(&Event::Unavailable));
        // 第三款实时模型被跳过
        let ids: Vec<_> = calls.lock().unwrap().iter().map(|c| c.0).collect();
        assert_eq!(ids, vec!["a", "b", "batch"]);
    }

    #[test]
    fn final_without_timestamp_replays_from_arrival() {
        let (asr, calls, events, sink) = setup(vec![
            vec![
                Step::Emit(Out::Final {
                    text: "一。".into(),
                    end_ms: None,
                }),
                Step::WaitClosed,
                Step::Fail(quota()),
            ],
            vec![Step::WaitClosed],
        ]);
        asr.start(sink);
        // 定稿到达后再录的音频：换模型时要重放
        std::thread::sleep(std::time::Duration::from_millis(50));
        asr.push(&[0; 3200]);
        asr.stop();
        wait_end(&events);
        let c = calls.lock().unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[1].1, 0);
    }

    #[test]
    fn session_end_releases_recording() {
        let (asr, _calls, events, sink) = setup(vec![vec![Step::Fail(quota())]; 3]);
        asr.start(sink);
        asr.push(&[0; 3200]);
        wait_end(&events);
        for _ in 0..100 {
            if asr.feed.lock().unwrap().is_none() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("会话结束后录音没有释放");
    }

    #[test]
    fn network_down_gives_up_quickly() {
        let net = || Failure::Transient("连接失败".into());
        let (asr, calls, events, sink) =
            setup(vec![vec![Step::Fail(net())], vec![Step::Fail(net())]]);
        asr.start(sink);
        let ev = wait_end(&events);
        assert!(ev.contains(&Event::Unavailable));
        assert_eq!(calls.lock().unwrap().len(), MAX_TRANSIENT);
        // 临时错误不记账
        let shared = asr.shared.as_ref().unwrap();
        assert!(shared.state.lock().unwrap().usable(&shared.models[0], NOW));
    }
}
