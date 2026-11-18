import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPlatformForTesting } from "@/lib/platform";
import { createMockPlatform } from "@/lib/platform/mock";
import type { SpeechEvent } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { STOP_WAIT_MS, useVoiceInput } from "./use-voice-input";

// 麦克风：测试里直接拿到 onPcm / onError，模拟采到音频
const mic = vi.hoisted(() => ({
  options: {} as { onError?: () => void; onPcm?: (pcm: Uint8Array) => void },
}));
vi.mock("./use-mic-level", () => ({
  useMicLevel: (
    _active: boolean,
    _enabled: boolean,
    options: { onError?: () => void; onPcm?: (pcm: Uint8Array) => void } = {},
  ) => {
    mic.options = options;
    return () => null;
  },
}));

describe("语音转文字", () => {
  afterEach(() => setPlatformForTesting(undefined));

  function withEvents(events: SpeechEvent[]) {
    const base = createMockPlatform();
    setPlatformForTesting({
      ...base,
      speechStart: async (onEvent) => {
        for (const e of events) onEvent(e);
        return 1;
      },
    });
  }

  it("出错只提示“语音转文字暂不可用”，已说的临时文本仍插入", async () => {
    withEvents([
      { type: "interim", text: "你好" },
      { type: "error", message: "语音转文字暂不可用" },
      { type: "end" },
    ]);
    const onFinal = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onFinal }));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.recording).toBe(false));
    expect(result.current.error).toEqual({ message: strings.chat.voice.unavailable });
    expect(onFinal).toHaveBeenCalledWith("你好");
  });

  it("平台启动失败也只提示同一句", async () => {
    const base = createMockPlatform();
    setPlatformForTesting({
      ...base,
      speechStart: async () => {
        throw new Error("speech_start failed: internal");
      },
    });
    const { result } = renderHook(() => useVoiceInput({ onFinal: () => {} }));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.recording).toBe(false));
    expect(result.current.error?.message).toBe("语音转文字暂不可用");
  });

  it("定稿逐句交给 onFinal", async () => {
    withEvents([
      { type: "final", text: "第一句。" },
      { type: "final", text: "第二句。" },
      { type: "end" },
    ]);
    const onFinal = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onFinal }));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.recording).toBe(false));
    expect(onFinal.mock.calls).toEqual([["第一句。"], ["第二句。"]]);
    expect(result.current.error).toBeNull();
  });

  it("停止：先多采一小段尾音，再结束识别；连按两次只停一次", async () => {
    const base = createMockPlatform();
    const speechStop = vi.fn(async (_session: number) => {});
    setPlatformForTesting({ ...base, speechStart: async () => 3, speechStop });
    const { result } = renderHook(() => useVoiceInput({ onFinal: () => {} }));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.recording).toBe(true));
    act(() => {
      result.current.stop();
      result.current.stop();
    });
    expect(speechStop).not.toHaveBeenCalled();
    await waitFor(() => expect(speechStop).toHaveBeenCalledTimes(1));
    expect(speechStop).toHaveBeenCalledWith(3);
  });

  it("音频带上会话编号；送不进去时提示不可用并结束这次识别", async () => {
    const base = createMockPlatform();
    let onEvent: ((e: SpeechEvent) => void) | undefined;
    const speechAudio = vi.fn(async (_session: number, _pcm: Uint8Array) => {});
    const speechStop = vi.fn(async (_session: number) => onEvent?.({ type: "end" }));
    setPlatformForTesting({
      ...base,
      speechStart: async (cb) => {
        onEvent = cb;
        return 5;
      },
      speechAudio,
      speechStop,
    });
    const { result } = renderHook(() => useVoiceInput({ onFinal: () => {} }));
    act(() => result.current.start());
    const pcm = new Uint8Array([1, 2]);
    act(() => mic.options.onPcm?.(pcm));
    await waitFor(() => expect(speechAudio).toHaveBeenCalledWith(5, pcm));
    expect(result.current.error).toBeNull();
    speechAudio.mockRejectedValueOnce(new Error("speech_audio failed"));
    act(() => mic.options.onPcm?.(pcm));
    await waitFor(() => expect(result.current.recording).toBe(false));
    expect(result.current.error?.message).toBe(strings.chat.voice.unavailable);
    expect(speechStop).toHaveBeenCalledTimes(1);
    expect(speechStop).toHaveBeenCalledWith(5);
  });

  it("旧会话迟到的发送失败不影响新会话", async () => {
    const base = createMockPlatform();
    const handlers: ((e: SpeechEvent) => void)[] = [];
    let rejectOld: ((e: Error) => void) | undefined;
    const speechAudio = vi.fn(
      (session: number, _pcm: Uint8Array) =>
        new Promise<void>((resolve, reject) => {
          if (session === 1) rejectOld = reject;
          else resolve();
        }),
    );
    const speechStop = vi.fn(async (_session: number) => {});
    setPlatformForTesting({
      ...base,
      speechStart: async (cb) => {
        handlers.push(cb);
        return handlers.length;
      },
      speechAudio,
      speechStop,
    });
    const { result } = renderHook(() => useVoiceInput({ onFinal: () => {} }));
    act(() => result.current.start());
    act(() => mic.options.onPcm?.(new Uint8Array([1])));
    await waitFor(() => expect(rejectOld).toBeDefined());
    // 旧会话结束，开始新会话
    act(() => handlers[0]?.({ type: "end" }));
    await waitFor(() => expect(result.current.recording).toBe(false));
    act(() => result.current.start());
    await waitFor(() => expect(handlers).toHaveLength(2));
    // 旧会话那次发送此时才失败
    await act(async () => rejectOld?.(new Error("late")));
    expect(result.current.recording).toBe(true);
    expect(result.current.error).toBeNull();
    expect(speechStop).not.toHaveBeenCalled();
  });

  it("识别迟迟不收尾时，停止后很快收起录音：插入已显示的临时文字，停止请求只发一次，迟到结果不再插入", async () => {
    const base = createMockPlatform();
    let onEvent: ((e: SpeechEvent) => void) | undefined;
    // 平台收到停止后一直不推 end（第一次连接慢、换模型重放）
    const speechStop = vi.fn(async (_session: number) => {});
    setPlatformForTesting({
      ...base,
      speechStart: async (cb) => {
        onEvent = cb;
        return 7;
      },
      speechStop,
    });
    const onFinal = vi.fn();
    const onEnd = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onFinal, onEnd }));
    act(() => result.current.start());
    await waitFor(() => expect(onEvent).toBeDefined());
    act(() => onEvent?.({ type: "interim", text: "你好世界" }));
    const stoppedAt = Date.now();
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.recording).toBe(false), {
      timeout: STOP_WAIT_MS + 1500,
    });
    expect(Date.now() - stoppedAt).toBeLessThan(STOP_WAIT_MS + 1000);
    expect(onFinal).toHaveBeenCalledWith("你好世界");
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(speechStop).toHaveBeenCalledTimes(1);
    expect(speechStop).toHaveBeenCalledWith(7);
    // 之后才到的定稿与结束都忽略
    act(() => {
      onEvent?.({ type: "final", text: "迟到的一句。" });
      onEvent?.({ type: "end" });
    });
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("识别及时收尾时不提前收起", async () => {
    const base = createMockPlatform();
    let onEvent: ((e: SpeechEvent) => void) | undefined;
    const speechStop = vi.fn(async (_session: number) => {
      onEvent?.({ type: "final", text: "说完了。" });
      onEvent?.({ type: "end" });
    });
    setPlatformForTesting({
      ...base,
      speechStart: async (cb) => {
        onEvent = cb;
        return 8;
      },
      speechStop,
    });
    const onFinal = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onFinal }));
    act(() => result.current.start());
    await waitFor(() => expect(onEvent).toBeDefined());
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.recording).toBe(false));
    expect(onFinal.mock.calls).toEqual([["说完了。"]]);
    expect(speechStop).toHaveBeenCalledTimes(1);
  });
});
