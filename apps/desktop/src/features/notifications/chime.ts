// 提示音（ADR 0023）：用 Web Audio 现场合成，不带音频文件、不经系统通知的声音，
// 浏览器预览与桌面端同一套。两种主要声音一听就能分开：
//   - 完成 done：上行的两个音（E5 → B5），柔和、像“叮咚”收尾；
//   - 需要处理 input：同一个音连响两下（A5、A5），短促，提醒“该你了”；
//   - 出错 error：下行的两个音（A5 → E5），与完成区分开。
// WebView 的自动播放策略要求页面先有过用户操作才能出声：primeAudio 在首次点击 / 按键时创建并唤醒音频上下文
// （用户要先发消息才会有任务完成，正常使用中总是满足）。

export type ChimeKind = "done" | "input" | "error";

interface Note {
  /** 频率（Hz） */
  freq: number;
  /** 相对开始时间（秒） */
  at: number;
  /** 衰减到静音的时长（秒） */
  dur: number;
}

export const CHIMES: Record<ChimeKind, readonly Note[]> = {
  done: [
    { freq: 659.25, at: 0, dur: 0.5 },
    { freq: 987.77, at: 0.13, dur: 0.75 },
  ],
  input: [
    { freq: 880, at: 0, dur: 0.28 },
    { freq: 880, at: 0.2, dur: 0.4 },
  ],
  error: [
    { freq: 880, at: 0, dur: 0.4 },
    { freq: 659.25, at: 0.16, dur: 0.6 },
  ],
};

/** 主音量（0–1）：系统通知音的量级，不刺耳 */
const VOLUME = 0.18;
/** 两次提示音的最短间隔：几个会话同时结束时只响一次 */
const MIN_GAP_MS = 800;

type AudioContextCtor = new () => AudioContext;

let ctx: AudioContext | null = null;
let lastPlayed = Number.NEGATIVE_INFINITY;

function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  const g = globalThis as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/**
 * 播放一种提示音。`force` 跳过最短间隔（设置里的“试听”）。返回是否发出了声音
 * （没有 Web Audio、被节流或上下文无法唤醒时为 false）
 */
export async function playChime(
  kind: ChimeKind,
  options: { force?: boolean } = {},
): Promise<boolean> {
  const now = Date.now();
  if (!options.force && now - lastPlayed < MIN_GAP_MS) return false;
  const c = audioContext();
  if (!c) return false;
  lastPlayed = now;
  if (c.state === "suspended") {
    try {
      await c.resume();
    } catch {
      return false;
    }
  }
  const start = c.currentTime + 0.02;
  const master = c.createGain();
  master.gain.setValueAtTime(VOLUME, start);
  master.connect(c.destination);
  let end = start;
  for (const note of CHIMES[kind]) {
    const t = start + note.at;
    const env = c.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t + note.dur);
    env.connect(master);
    // 基音加一点八度泛音，听起来像铃而不是纯正弦的“嘀”
    for (const [mult, level] of [
      [1, 1],
      [2, 0.22],
    ] as const) {
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(note.freq * mult, t);
      const g = c.createGain();
      g.gain.setValueAtTime(level, t);
      osc.connect(g);
      g.connect(env);
      osc.start(t);
      osc.stop(t + note.dur + 0.05);
    }
    end = Math.max(end, t + note.dur + 0.05);
  }
  // 播完断开主音量节点，振荡器停止后会被回收
  setTimeout(() => master.disconnect(), Math.ceil((end - c.currentTime) * 1000) + 100);
  return true;
}

/**
 * 首次点击或按键时创建并唤醒音频上下文（自动播放策略）。返回取消监听的函数
 */
export function primeAudio(): () => void {
  if (typeof window === "undefined") return () => {};
  const prime = () => {
    const c = audioContext();
    if (c?.state === "suspended") void c.resume().catch(() => {});
    if (c) stop();
  };
  const stop = () => {
    window.removeEventListener("pointerdown", prime, true);
    window.removeEventListener("keydown", prime, true);
  };
  window.addEventListener("pointerdown", prime, true);
  window.addEventListener("keydown", prime, true);
  return stop;
}

/** 测试用：丢掉缓存的音频上下文与节流时间 */
export function resetChimeForTest(): void {
  ctx = null;
  lastPlayed = Number.NEGATIVE_INFINITY;
}
