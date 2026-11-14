//! 录音缓冲：麦克风送来的 16 kHz、16 位、单声道 PCM（小端）整段留在内存里，
//! 换模型时从还没定稿的位置重放；会话结束即丢弃，不落盘。

use std::sync::Mutex;

use tokio::sync::Notify;

/// 麦克风音频的采样率
pub const INPUT_RATE: u32 = 16_000;
/// 每毫秒的字节数（16 kHz × 2 字节）
pub const BYTES_PER_MS: usize = 32;

#[derive(Default)]
struct Inner {
    pcm: Vec<u8>,
    closed: bool,
}

/// 一次录音的音频：写入端是薄壳命令，读取端是正在识别的模型。
#[derive(Default)]
pub struct Feed {
    inner: Mutex<Inner>,
    notify: Notify,
}

impl Feed {
    pub fn push(&self, chunk: &[u8]) {
        let mut g = self.inner.lock().unwrap();
        if g.closed {
            return;
        }
        g.pcm.extend_from_slice(chunk);
        drop(g);
        self.notify.notify_waiters();
    }

    /// 录音结束：读取端读完已有音频后收到 None
    pub fn close(&self) {
        self.inner.lock().unwrap().closed = true;
        self.notify.notify_waiters();
    }

    pub fn closed(&self) -> bool {
        self.inner.lock().unwrap().closed
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().pcm.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 从 `pos` 起的全部音频（不等待）
    pub fn slice_from(&self, pos: usize) -> Vec<u8> {
        let g = self.inner.lock().unwrap();
        g.pcm
            .get(pos.min(g.pcm.len())..)
            .unwrap_or_default()
            .to_vec()
    }

    /// 等到 `pos` 之后有新音频（返回它并前移 `pos`），或录音结束且已读完（返回 None）
    pub async fn next(&self, pos: &mut usize) -> Option<Vec<u8>> {
        loop {
            let notified = self.notify.notified();
            {
                let g = self.inner.lock().unwrap();
                // 偶数字节对齐，不把一个采样拆成两半
                let end = g.pcm.len() & !1;
                if end > *pos {
                    let chunk = g.pcm[*pos..end].to_vec();
                    *pos = end;
                    return Some(chunk);
                }
                if g.closed {
                    return None;
                }
            }
            notified.await;
        }
    }

    /// 等到录音结束
    pub async fn wait_closed(&self) {
        loop {
            let notified = self.notify.notified();
            if self.closed() {
                return;
            }
            notified.await;
        }
    }
}

/// 16 kHz → 8 kHz：相邻两个采样取平均（足够给电话模型用）
pub fn downsample_half(pcm: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pcm.len() / 2);
    for frame in pcm.as_chunks::<4>().0 {
        let a = i32::from(i16::from_le_bytes([frame[0], frame[1]]));
        let b = i32::from(i16::from_le_bytes([frame[2], frame[3]]));
        out.extend_from_slice(&(((a + b) / 2) as i16).to_le_bytes());
    }
    out
}

/// 按模型采样率转换
pub fn for_rate(pcm: &[u8], rate: u32) -> Vec<u8> {
    if rate == INPUT_RATE / 2 {
        downsample_half(pcm)
    } else {
        pcm.to_vec()
    }
}

/// 封装成 WAV 文件（整段识别的模型要文件格式）
pub fn wav(pcm: &[u8], rate: u32) -> Vec<u8> {
    let len = pcm.len() as u32;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // 单声道
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsample_averages_pairs() {
        let pcm: Vec<u8> = [100i16, 200, -100, -300]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let out = downsample_half(&pcm);
        assert_eq!(
            out,
            [150i16, -200]
                .iter()
                .flat_map(|s| s.to_le_bytes())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn wav_header() {
        let w = wav(&[0u8; 32_000], 16_000);
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(w[40..44].try_into().unwrap()), 32_000);
        assert_eq!(w.len(), 32_044);
    }

    #[tokio::test]
    async fn feed_delivers_then_ends() {
        let feed = std::sync::Arc::new(Feed::default());
        let mut pos = 0;
        feed.push(&[1, 2, 3]);
        assert_eq!(feed.next(&mut pos).await, Some(vec![1, 2]));
        let f = feed.clone();
        tokio::spawn(async move {
            f.push(&[4]);
            f.close();
        });
        assert_eq!(feed.next(&mut pos).await, Some(vec![3, 4]));
        assert_eq!(feed.next(&mut pos).await, None);
        assert_eq!(feed.slice_from(1), vec![2, 3, 4]);
    }
}
