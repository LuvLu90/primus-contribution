"use client";

// 语音转文字：内置功能（薄壳的 speech_*，识别在 src-tauri/asr），用户点麦克风即可使用，不需要任何配置。
// 麦克风在 WebView 里采集，16 kHz PCM 经 speechAudio 交给薄壳；临时结果（interim）随时替换，
// 定稿（final）交给 onFinal 插入到光标处；会话结束时还没定稿的临时文本也一并插入，不丢用户说过的话。
// 出错（额度用完、网络不通、拿不到麦克风）只提示“语音转文字暂不可用”。
// 波形取 18 格音量历史：优先 WebView 麦克风实测音量，否则用平台推送的音量（mock）。
import { useCallback, useEffect, useRef, useState } from "react";
import { getPlatform, isTauriRuntime } from "@/lib/platform";
import type { SpeechEvent } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { useMicLevel } from "./use-mic-level";

export const WAVE_BARS = 18;
const WAVE_STEP_MS = 80;
/** 点停止后再采集的时长：大于一块采集缓冲（128ms），保证最后一块音频交出 */
const TAIL_MS = 160;

/** 语音转文字的错误（文案固定） */
export interface VoiceError {
  message: string;
}

export interface VoiceInput {
  /** 平台支持语音输入（首帧为 false，不可用时隐藏按钮） */
  available: boolean;
  recording: boolean;
  /** 当前这一句的临时文本 */
  interim: string;
  /** 最近 18 格音量（0–1），最新的在最后 */
  levels: number[];
  /** 已录音秒数 */
  elapsed: number;
  error: VoiceError | null;
  start: () => void;
  stop: () => void;
}

export function useVoiceInput({
  onStart,
  onFinal,
  onEnd,
}: {
  /** 开始录音（记下光标位置） */
  onStart?: () => void;
  /** 定稿的一段文本 */
  onFinal: (text: string) => void;
  /** 录音结束 */
  onEnd?: () => void;
}): VoiceInput {
  const [available, setAvailable] = useState(false);
  const [recording, setRecording] = useState(false);
  // 麦克风开着（点停止后立即关麦克风，录音状态保持到识别完成）
  const [capturing, setCapturing] = useState(false);
  const [interim, setInterim] = useState("");
  const [levels, setLevels] = useState<number[]>(() => Array(WAVE_BARS).fill(0));
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<VoiceError | null>(null);
  const callbacks = useRef({ onStart, onFinal, onEnd });
  callbacks.current = { onStart, onFinal, onEnd };
  const interimRef = useRef("");
  const pushedLevel = useRef(0);
  /** 已交给薄壳的音频（按顺序串起来的发送） */
  const audioSent = useRef<Promise<void>>(Promise.resolve());
  // 每次开始一个会话一个令牌：旧会话迟到的事件不影响新会话
  const session = useRef<symbol | null>(null);
  // 当前会话在平台上的编号（speechStart 返回）：音频与停止请求都带上它，
  // 别的标签或旧会话的音频不会进入新会话，也停不掉新会话
  const sessionId = useRef<Promise<number> | null>(null);
  // 已在结束的会话（停止或发送失败），避免重复结束
  const stopping = useRef<symbol | null>(null);
  const unavailable = useCallback(
    () => setError((prev) => prev ?? { message: strings.chat.voice.unavailable }),
    [],
  );

  const finish = useCallback((token: symbol) => {
    if (session.current !== token) return;
    session.current = null;
    sessionId.current = null;
    const pending = interimRef.current;
    interimRef.current = "";
    setInterim("");
    if (pending) callbacks.current.onFinal(pending);
    setCapturing(false);
    setRecording(false);
    callbacks.current.onEnd?.();
  }, []);

  /** 结束这次识别（已送达的音频识别完后平台推送 end）；停止请求失败时直接结束界面上的录音状态 */
  const endSession = useCallback(
    (token: symbol, id: Promise<number>) => {
      void id
        .then(async (n) => {
          const p = await getPlatform();
          // 等待期间这次会话可能已结束、又开始了新会话：不能把新会话停掉
          if (session.current === token) await p.speechStop(n);
        })
        .catch(() => finish(token));
    },
    [finish],
  );

  /** 识别出错（拿不到麦克风、音频送不进去）：提示不可用，关麦克风并结束这次识别 */
  const fail = useCallback(
    (token: symbol, id: Promise<number> | null) => {
      if (session.current !== token) return;
      unavailable();
      if (stopping.current === token) return;
      stopping.current = token;
      setCapturing(false);
      if (id) endSession(token, id);
      else finish(token);
    },
    [endSession, finish, unavailable],
  );

  // 只在桌面端读麦克风（浏览器预览不调用 getUserMedia，不弹浏览器权限框）
  const readMic = useMicLevel(capturing, isTauriRuntime(), {
    onError: () => {
      const token = session.current;
      if (token) fail(token, sessionId.current);
    },
    onPcm: (pcm) => {
      const token = session.current;
      const id = sessionId.current;
      if (!token || !id) return;
      // 按顺序送达；停止时等最后一块送完再结束识别。真正发送前再核对会话：
      // 排在队列里的旧会话音频不能送进之后新开始的会话
      audioSent.current = audioSent.current
        .then(async () => {
          if (session.current !== token) return;
          const n = await id;
          const p = await getPlatform();
          if (session.current === token) await p.speechAudio(n, pcm);
        })
        // 送不进去：仍是当前会话才提示不可用并结束（旧会话的失败不影响新会话）
        .catch(() => fail(token, id));
    },
  });

  useEffect(() => {
    let cancelled = false;
    getPlatform()
      .then((p) => p.speechAvailable())
      .then((ok) => !cancelled && setAvailable(ok))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(() => {
    if (session.current) return;
    const token = Symbol("speech");
    session.current = token;
    setError(null);
    setElapsed(0);
    setLevels(Array(WAVE_BARS).fill(0));
    interimRef.current = "";
    pushedLevel.current = 0;
    callbacks.current.onStart?.();
    setRecording(true);
    setCapturing(true);
    const onEvent = (e: SpeechEvent) => {
      if (session.current !== token) return;
      if (e.type === "interim") {
        interimRef.current = e.text;
        setInterim(e.text);
      } else if (e.type === "final") {
        interimRef.current = "";
        setInterim("");
        callbacks.current.onFinal(e.text);
      } else if (e.type === "level") pushedLevel.current = e.level;
      else if (e.type === "error") unavailable();
      else finish(token);
    };
    const id = getPlatform().then((p) => p.speechStart(onEvent));
    sessionId.current = id;
    id.catch(() => {
      if (session.current !== token) return;
      unavailable();
      finish(token);
    });
  }, [finish, unavailable]);

  const stop = useCallback(() => {
    const token = session.current;
    const id = sessionId.current;
    if (!token || !id || stopping.current === token) return;
    stopping.current = token;
    // 采集按整块（2048 帧，16 kHz 下 128ms）交出音频：再采一块，让点停止前说的最后几个字也送进去，
    // 然后关麦克风，等已采的音频全部送达后再结束识别
    setTimeout(() => {
      if (session.current !== token) return;
      setCapturing(false);
      void audioSent.current.then(() => endSession(token, id));
    }, TAIL_MS);
  }, [endSession]);

  // 录音中：波形与计时
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const wave = setInterval(() => {
      const level = readMic() ?? pushedLevel.current;
      setLevels((prev) => [...prev.slice(1), level]);
    }, WAVE_STEP_MS);
    const clock = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => {
      clearInterval(wave);
      clearInterval(clock);
    };
  }, [recording, readMic]);

  // 卸载时结束仍在进行的识别
  useEffect(
    () => () => {
      const id = sessionId.current;
      if (!session.current || !id) return;
      session.current = null;
      sessionId.current = null;
      void id.then(async (n) => (await getPlatform()).speechStop(n)).catch(() => {});
    },
    [],
  );

  return { available, recording, interim, levels, elapsed, error, start, stop };
}
