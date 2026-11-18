"use client";

// “正在思考”的指示（照 BoardUI「智能体思考状态」wave 变体，ADR 0019）：
// 3×3 个 4px 小方点，透明度沿对角线做波纹（纯 CSS：每个点同一条 keyframes，按所在对角线错开相位）；
// 文字流光 2.6s；右侧等宽计时（从出现起算，0.1 秒一跳）。减少动态效果时点阵静止、文字不流光。
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** 一轮波纹的时长（模板每 80ms 前进 1/8 周期） */
const WAVE_MS = 640;
/** 静止（及减少动态效果）时的透明度，与模板的初始帧一致 */
const REST = [0.55, 0.3, 0.15, 0.85, 0.55, 0.3, 1, 0.85, 0.55];

/** 第 i 个点（行优先）在波纹里的相位：(列 + 行) / 4 × 0.75 */
export const wavePhase = (i: number) => (((i % 3) + Math.floor(i / 3)) / 4) * 0.75;

export function ThinkingWave({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("grid shrink-0 grid-cols-[repeat(3,4px)] gap-0.5", className)}>
      {REST.map((rest, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: 固定 9 个点，位置即身份
          key={i}
          className="think-wave-dot size-1 rounded-[1px] bg-current"
          style={{ opacity: rest, animationDelay: `${-(1 - wavePhase(i)) * WAVE_MS}ms` }}
        />
      ))}
    </span>
  );
}

/** 从挂载起的用时，形如“3.4s” */
export function ElapsedTimer({ className }: { className?: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const id = window.setInterval(() => setSeconds((performance.now() - start) / 1000), 100);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span
      aria-hidden
      className={cn("shrink-0 font-mono text-2xs tabular-nums text-muted/70", className)}
    >
      {seconds.toFixed(1)}s
    </span>
  );
}
