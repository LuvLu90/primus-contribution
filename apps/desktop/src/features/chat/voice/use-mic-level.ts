"use client";

// 麦克风：WebView 里 getUserMedia 采集，只在录音时打开，停止即释放。
// - 音量（波形用）：AnalyserNode 算 RMS。
// - 音频（语音转文字用）：转成 16 kHz、16 位、单声道、小端 PCM，约每 128ms 交给 onPcm 一块。
// 只在桌面端（Tauri）读麦克风：薄壳已为 App 自己的页面自动授予 WebView2 麦克风权限，不会弹权限框。
// 浏览器预览（mock，enabled=false）完全不调用 getUserMedia，避免浏览器弹出麦克风权限请求，波形用 mock 推送的音量。
// 拿不到麦克风时返回的读取函数恒为 null，调用方改用平台推送的音量；失败（被拒绝、没有设备）时回调 onError。
import { useCallback, useEffect, useRef } from "react";

/** 语音转文字要的采样率 */
export const PCM_RATE = 16000;

/** Float32 采样（-1–1）按 `fromRate` 重采样到 16 kHz，转成 16 位小端 PCM 字节 */
export function toPcm16(samples: Float32Array, fromRate: number): Uint8Array {
  const ratio = fromRate / PCM_RATE;
  const count = ratio === 1 ? samples.length : Math.floor(samples.length / ratio);
  const out = new DataView(new ArrayBuffer(count * 2));
  for (let i = 0; i < count; i++) {
    let v: number;
    if (ratio === 1) v = samples[i] ?? 0;
    else {
      // 降采样：取这一段的平均，顺带滤掉一些高频
      const from = Math.floor(i * ratio);
      const to = Math.min(samples.length, Math.max(from + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = from; j < to; j++) sum += samples[j] ?? 0;
      v = sum / (to - from);
    }
    const clamped = Math.max(-1, Math.min(1, v));
    out.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

/** 返回一个读取当前音量（0–1）的函数；未开始或不可用时为 null */
export function useMicLevel(
  active: boolean,
  enabled: boolean,
  options: { onError?: () => void; onPcm?: (pcm: Uint8Array) => void } = {},
): () => number | null {
  const reader = useRef<(() => number) | null>(null);
  const callbacks = useRef(options);
  callbacks.current = options;
  useEffect(() => {
    if (!active || !enabled) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      callbacks.current.onError?.();
      return;
    }
    let cancelled = false;
    let stream: MediaStream | undefined;
    let ctx: AudioContext | undefined;
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
      .then((s) => {
        if (cancelled) {
          // 清理已经执行过（很快停止或卸载）：立即释放迟到的麦克风
          for (const track of s.getTracks()) track.stop();
          return;
        }
        stream = s;
        // 直接按 16 kHz 建音频上下文，由浏览器重采样；不支持时退回默认采样率，自己重采样
        try {
          ctx = new AudioContext({ sampleRate: PCM_RATE });
        } catch {
          ctx = new AudioContext();
        }
        const source = ctx.createMediaStreamSource(s);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        // ScriptProcessorNode：不需要额外的脚本文件（CSP 只允许同源脚本）；输出静音，只为让处理持续进行
        const processor = ctx.createScriptProcessor(2048, 1, 1);
        const rate = ctx.sampleRate;
        processor.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0);
          callbacks.current.onPcm?.(toPcm16(input, rate));
        };
        source.connect(processor);
        processor.connect(ctx.destination);
        const buf = new Float32Array(analyser.fftSize);
        reader.current = () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          const rms = Math.sqrt(sum / buf.length);
          // 说话时 RMS 大约 0.02–0.3：取平方根拉开小音量的层次
          return Math.min(1, Math.sqrt(rms * 4));
        };
      })
      .catch(() => {
        if (!cancelled) callbacks.current.onError?.();
      });
    return () => {
      cancelled = true;
      reader.current = null;
      for (const track of stream?.getTracks() ?? []) track.stop();
      void ctx?.close().catch(() => {});
    };
  }, [active, enabled]);
  // 稳定的读取函数：调用方放进依赖也不会反复重建定时器
  return useCallback(() => reader.current?.() ?? null, []);
}
