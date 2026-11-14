import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTauriRuntime } from "@/lib/platform";
import { toPcm16, useMicLevel } from "./use-mic-level";

describe("麦克风音量", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "mediaDevices", original);
    else Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("浏览器预览（mock）录音时不调用 getUserMedia，不弹麦克风权限请求", () => {
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    expect(isTauriRuntime()).toBe(false);
    const { result, rerender } = renderHook(({ active }) => useMicLevel(active, isTauriRuntime()), {
      initialProps: { active: false },
    });
    rerender({ active: true });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current()).toBeNull();
  });
});

describe("toPcm16", () => {
  const ints = (b: Uint8Array) => Array.from(new Int16Array(b.buffer.slice(0)));

  it("16 kHz 原样转成 16 位小端，超出范围的截断", () => {
    expect(ints(toPcm16(new Float32Array([0, 1, -1, 2, 0.5]), 16000))).toEqual([
      0, 32767, -32768, 32767, 16383,
    ]);
  });

  it("48 kHz 降到 16 kHz：每 3 个采样取平均", () => {
    const out = toPcm16(new Float32Array([0.3, 0.3, 0.3, -0.6, -0.6, -0.6]), 48000);
    expect(ints(out)).toEqual([9830, -19660]);
  });
});
