//! 手动联调：逐个模型识别一段 16 kHz 单声道 WAV，打印结果或失败分类。
//! 用法：PRIMUS_ASR_KEY=sk-… cargo run -p primus-asr --example live -- 录音.wav [模型 ID…]
use std::sync::Arc;

use primus_asr::audio::Feed;
use primus_asr::models::{MODELS, Protocol};
use primus_asr::protocols::{Out, batch, duplex, realtime};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("需要一个 WAV 文件");
    let only: Vec<String> = args.collect();
    let wav = std::fs::read(&path).expect("读取 WAV 失败");
    let pcm = wav[44..].to_vec();
    let net =
        primus_asr::net::Net::new(std::env::var("PRIMUS_ASR_KEY").unwrap_or_default()).unwrap();
    for model in MODELS
        .iter()
        .filter(|m| only.is_empty() || only.iter().any(|o| o == m.id))
    {
        let feed = Arc::new(Feed::default());
        let f = feed.clone();
        let pcm = pcm.clone();
        // 按实时速度送音频
        tokio::spawn(async move {
            for c in pcm.chunks(3200) {
                f.push(c);
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            f.close();
        });
        let emit = |o: Out| {
            if let Out::Final { text, end_ms } = o {
                println!("    定稿 {end_ms:?}: {text}");
            }
        };
        let r = match model.protocol {
            Protocol::Duplex => duplex::run(&net, model, &feed, 0, &emit).await,
            Protocol::Realtime => realtime::run(&net, model, &feed, 0, &emit).await,
            _ => batch::run(&net, model, &feed, 0, &emit).await,
        };
        println!("{} → {:?}", model.id, r);
    }
}
