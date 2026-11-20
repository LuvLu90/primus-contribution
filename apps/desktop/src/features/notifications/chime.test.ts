import { afterEach, describe, expect, it, vi } from "vitest";
import { CHIMES, playChime, primeAudio, resetChimeForTest } from "./chime";

class FakeParam {
  setValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}
class FakeNode {
  connect = vi.fn();
  disconnect = vi.fn();
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakeOsc extends FakeNode {
  type = "";
  frequency = new FakeParam();
  start = vi.fn();
  stop = vi.fn();
}

const created: FakeContext[] = [];
class FakeContext {
  state = "suspended";
  currentTime = 1;
  destination = new FakeNode();
  oscillators: FakeOsc[] = [];
  resume = vi.fn(async () => {
    this.state = "running";
  });
  constructor() {
    created.push(this);
  }
  createGain() {
    return new FakeGain();
  }
  createOscillator() {
    const o = new FakeOsc();
    this.oscillators.push(o);
    return o;
  }
}

describe("提示音", () => {
  afterEach(() => {
    resetChimeForTest();
    created.length = 0;
    vi.unstubAllGlobals();
  });

  it("三种声音各不相同", () => {
    const sig = (k: keyof typeof CHIMES) => CHIMES[k].map((n) => n.freq).join(",");
    expect(new Set([sig("done"), sig("input"), sig("error")]).size).toBe(3);
  });

  it("没有 Web Audio 时什么也不做", async () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(await playChime("done")).toBe(false);
  });

  it("唤醒音频上下文后按音符排程；短时间内重复调用只响一次，试听不受限", async () => {
    vi.stubGlobal("AudioContext", FakeContext);
    expect(await playChime("input")).toBe(true);
    const ctx = created[0] as FakeContext;
    expect(ctx.resume).toHaveBeenCalled();
    // 每个音符一个基音加一个泛音
    expect(ctx.oscillators).toHaveLength(CHIMES.input.length * 2);
    expect(ctx.oscillators[0]?.frequency.setValueAtTime).toHaveBeenCalledWith(
      880,
      expect.any(Number),
    );
    expect(await playChime("done")).toBe(false);
    expect(await playChime("done", { force: true })).toBe(true);
  });

  it("首次按键时创建并唤醒音频上下文", () => {
    vi.stubGlobal("AudioContext", FakeContext);
    const stop = primeAudio();
    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(created).toHaveLength(1);
    expect(created[0]?.resume).toHaveBeenCalled();
    stop();
  });
});
