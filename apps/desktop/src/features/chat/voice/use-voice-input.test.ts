import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPlatformForTesting } from "@/lib/platform";
import { createMockPlatform } from "@/lib/platform/mock";
import type { SpeechEvent } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { useVoiceInput } from "./use-voice-input";

describe("语音转文字", () => {
  afterEach(() => setPlatformForTesting(undefined));

  function withEvents(events: SpeechEvent[]) {
    const base = createMockPlatform();
    setPlatformForTesting({
      ...base,
      speechStart: async (onEvent) => {
        for (const e of events) onEvent(e);
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
});
