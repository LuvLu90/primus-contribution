"use client";

// 计划进度（唇条版，ADR 0019 修订）：收起时是唇条正中的一行“进度环 还剩 N 步 → 当前步骤”，
// 鼠标悬停（或键盘聚焦）时在唇条上方弹出全部步骤列表，移开即收起；不占输入框上方的空间。
// 不引入动画库：进度环、当前步骤的旋转弧线、完成打勾与删除线、文字流光都用 CSS 过渡与 keyframes。
// 全部完成后显示“全部步骤已完成”，停 1.8 秒后淡出；之后出现新的未完成步骤时重新显示。
import { currentTodo, type TodoItem } from "@primus/protocol";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";

const t = strings.chat.progress;

const ROW = 32;
const GAP = 6;
const PITCH = ROW + GAP;
/** 弹出列表最多直接显示的步数，再多列表内部滚动 */
const MAX_ROWS = 8;
/** 全部完成后停留多久再淡出 */
export const COMPLETION_DELAY_MS = 1800;
const LEAVE_MS = 320;

const finished = (s: TodoItem["status"]) => s === "completed" || s === "skipped";

function ProgressRing({ ratio, size = 16 }: { ratio: number; size?: number }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width={size} height={size} className="shrink-0 -rotate-90">
      <circle
        cx="8"
        cy="8"
        r="6.75"
        fill="none"
        strokeWidth="2.5"
        className="stroke-track-strong"
      />
      <circle
        data-progress-ring
        cx="8"
        cy="8"
        r="6.75"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray={`${Math.round(ratio * 1000) / 10} 100`}
        className="agentp-ring-fg transition-[stroke-dasharray] motion-reduce:transition-none duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]"
      />
    </svg>
  );
}

function StepMark({ status }: { status: TodoItem["status"] }) {
  if (status === "in_progress")
    return (
      <svg aria-hidden viewBox="0 0 14 14" className="agentp-pop size-3.5 shrink-0">
        <circle
          cx="7"
          cy="7"
          r="5.75"
          fill="none"
          strokeWidth="1.5"
          className="stroke-track-strong"
        />
        <circle
          cx="7"
          cy="7"
          r="5.75"
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray="28 100"
          className="agentp-ring-fg agentp-spin origin-center"
        />
      </svg>
    );
  if (status === "completed")
    return (
      <svg aria-hidden viewBox="0 0 14 14" className="agentp-check size-[15px] shrink-0">
        <circle cx="7" cy="7" r="7" className="fill-black/[0.08] dark:fill-white/[0.12]" />
        <path
          d="M4 7.5 5.646 9.146a.5.5 0 0 0 .708 0L10 5.5"
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          className="stroke-muted"
        />
      </svg>
    );
  if (status === "skipped")
    return (
      <svg aria-hidden viewBox="0 0 15 15" className="agentp-check size-[15px] shrink-0">
        <circle
          cx="7.5"
          cy="7.5"
          r="7"
          fill="none"
          strokeDasharray="2 2"
          className="stroke-black/[0.16] dark:stroke-white/[0.2]"
        />
        <path
          d="M5 10 10 5"
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          className="stroke-muted"
        />
      </svg>
    );
  return (
    <svg aria-hidden viewBox="0 0 15 15" className="size-[15px] shrink-0">
      <circle
        cx="7.5"
        cy="7.5"
        r="7"
        fill="none"
        strokeDasharray="2 2"
        className="stroke-black/[0.16] dark:stroke-white/[0.2]"
      />
    </svg>
  );
}

/** 标题文字：变化时新文字自下而上、去模糊出现 */
function SwapLabel({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn("relative inline-flex min-w-0 overflow-hidden", className)}>
      <span key={text} className="agentp-label-in block whitespace-nowrap">
        {text}
      </span>
    </span>
  );
}

/** 全部完成后的显示状态：按步骤清单的内容判断是否“同一份计划” */
function useLifecycle(items: readonly TodoItem[], allDone: boolean) {
  const signature = items.map((i) => `${i.id}\u0000${i.text}`).join("\u0001");
  const [state, setState] = useState<{ sig: string; phase: "shown" | "leaving" | "gone" }>({
    sig: signature,
    phase: "shown",
  });
  // 换了一份计划，或又有未完成的步骤：重新显示
  const phase = state.sig !== signature || !allDone ? "shown" : state.phase;
  if (phase !== state.phase || state.sig !== signature) {
    setState({ sig: signature, phase });
  }
  // 计时按计划内容区分：换成另一份已完成的计划时重新计时，同一份计划的重复快照不重置
  useEffect(() => {
    if (!allDone || phase !== "shown") return;
    const id = window.setTimeout(
      () => setState((s) => (s.sig === signature ? { ...s, phase: "leaving" } : s)),
      COMPLETION_DELAY_MS,
    );
    return () => window.clearTimeout(id);
  }, [allDone, phase, signature]);
  useEffect(() => {
    if (phase !== "leaving") return;
    const id = window.setTimeout(() => setState((s) => ({ ...s, phase: "gone" })), LEAVE_MS);
    return () => window.clearTimeout(id);
  }, [phase]);
  return phase;
}

export function LipProgress({
  items,
  hidden = false,
  className,
}: {
  items: readonly TodoItem[];
  /** 暂时让位（工具确认、提问、计划审批）：不显示，但保留完成状态 */
  hidden?: boolean;
  className?: string;
}) {
  const listId = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const current = currentTodo(items);
  const doneCount = items.filter((i) => finished(i.status)).length;
  const allDone = items.length > 0 && current === undefined;
  const phase = useLifecycle(items, allDone);
  const activeIndex = items.findIndex((i) => i.status === "in_progress");
  const left = items.length - doneCount;
  const label = allDone ? t.allDone : t.left.replace("{n}", String(left));

  // 当前步骤换了，或让位结束重新显示：列表里滚到它（步数超过 8 时；弹出列表未展开时也保持在位置上）
  // biome-ignore lint/correctness/useExhaustiveDependencies: hidden / phase 变化时列表重新挂载，需要重新定位
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || activeIndex < 0) return;
    const top = activeIndex * PITCH;
    if (top < list.scrollTop || top + ROW > list.scrollTop + list.clientHeight)
      list.scrollTo?.({ top: Math.max(0, top - PITCH) });
  }, [activeIndex, hidden, phase]);

  // Escape 收起弹出列表（不必移开焦点或指针，WCAG 1.4.13）；指针与焦点都离开整块后恢复，下次悬停 / 聚焦再展开
  const [dismissed, setDismissed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const restore = () => {
    const root = rootRef.current;
    if (root && (root.matches(":hover") || root.contains(document.activeElement))) return;
    setDismissed(false);
  };

  if (hidden || items.length === 0 || phase === "gone") return null;

  const ratio = items.length ? doneCount / items.length : 0;

  return (
    // 悬停 / 聚焦在整块（触发行 + 弹出列表）上都保持展开：鼠标从触发行移到列表上不会收起。纯 CSS（group-hover / focus-within）
    // biome-ignore lint/a11y/noStaticElementInteractions: 只接住内部按钮冒泡的 Escape，不是独立的交互元素
    <div
      ref={rootRef}
      data-testid="lip-progress"
      data-dismissed={dismissed || undefined}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || dismissed) return;
        e.stopPropagation();
        setDismissed(true);
      }}
      onMouseLeave={() => setTimeout(restore)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTimeout(restore);
      }}
      className={cn(
        "group/lp lip-item-in relative flex min-w-0 items-center transition-[opacity,filter] duration-300",
        phase === "leaving" && "opacity-0 blur-[2px]",
        className,
      )}
    >
      <button
        type="button"
        aria-describedby={listId}
        aria-label={`${t.label}：${label}${current ? `，${current.text}` : ""}`}
        className="flex min-w-0 cursor-default items-center gap-1.5 rounded-md outline-none transition-colors group-hover/lp:text-fg focus-visible:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {!allDone && <ProgressRing ratio={ratio} size={13} />}
        <span aria-live="polite" className="shrink-0">
          <SwapLabel text={label} />
        </span>
        {current && (
          <>
            <svg aria-hidden viewBox="0 0 14 14" className="size-3 shrink-0 fill-current">
              <path d="M7.47 2.47a.75.75 0 0 1 1.06 0l4.177 4.176a.5.5 0 0 1 0 .708L8.53 11.53a.75.75 0 0 1-1.06-1.06l2.72-2.72H2a.75.75 0 0 1 0-1.5h8.19L7.47 3.53a.75.75 0 0 1 0-1.06Z" />
            </svg>
            <span className="agentp-shimmer min-w-0 max-w-64 truncate">{current.text}</span>
          </>
        )}
      </button>

      {/* 弹出的全部步骤：贴着唇条上沿向上展开，底部留 8px 透明桥接，鼠标移上去不会断开悬停 */}
      <div
        data-lip-popover
        className={cn(
          "pointer-events-none absolute bottom-full left-1/2 z-30 -translate-x-1/2 translate-y-1 pb-2 opacity-0 blur-[2px] transition-[opacity,translate,filter] duration-[160ms] motion-reduce:transition-none ease-[cubic-bezier(0.22,1,0.36,1)]",
          !dismissed &&
            "group-hover/lp:pointer-events-auto group-hover/lp:translate-y-0 group-hover/lp:opacity-100 group-hover/lp:blur-0 group-hover/lp:duration-[220ms]",
          !dismissed &&
            "group-focus-within/lp:pointer-events-auto group-focus-within/lp:translate-y-0 group-focus-within/lp:opacity-100 group-focus-within/lp:blur-0",
        )}
      >
        <div className="w-[320px] max-w-[calc(100vw-3rem)] rounded-2xl border border-track-strong bg-surface px-2.5 pt-3 pb-2.5 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.3)]">
          <div className="flex h-5 items-center gap-2 ps-1 text-sm font-medium text-muted">
            {!allDone && <ProgressRing ratio={ratio} />}
            <span>{label}</span>
          </div>
          <ol
            id={listId}
            ref={listRef}
            className="scroll-none relative mt-[9px] flex flex-col overflow-y-auto overscroll-contain"
            style={{ gap: GAP, maxHeight: PITCH * MAX_ROWS - GAP }}
          >
            {activeIndex >= 0 && (
              <span
                aria-hidden
                data-active-border
                className="pointer-events-none absolute inset-x-0 top-0 rounded-full border border-track-strong transition-[translate] motion-reduce:transition-none duration-[450ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
                style={{ height: ROW, translate: `0 ${activeIndex * PITCH}px` }}
              />
            )}
            {items.map((item, i) => {
              const active = item.status === "in_progress";
              const done = finished(item.status);
              return (
                <li
                  key={item.id}
                  aria-current={active ? "step" : undefined}
                  className="agentp-step-in relative shrink-0"
                  style={{ height: ROW, animationDelay: `${i * 35}ms` }}
                >
                  <span
                    className={cn(
                      "flex h-full w-full items-center gap-2",
                      active ? "ps-[9px] pe-[13px]" : "px-1",
                    )}
                  >
                    <span className="flex size-3.5 shrink-0 items-center justify-center">
                      <StepMark key={item.status} status={item.status} />
                    </span>
                    <span
                      className={cn(
                        "relative block min-w-0 max-w-full truncate text-sm font-medium transition-colors duration-300",
                        active ? "agentp-shimmer text-fg" : "text-muted",
                      )}
                    >
                      <span className="sr-only">{`${strings.chat.todoStatus[item.status]}：`}</span>
                      {item.text}
                      <span
                        aria-hidden
                        data-strike
                        className={cn(
                          "absolute inset-x-0 top-1/2 h-px origin-left bg-current transition-[scale,opacity] motion-reduce:transition-none duration-[380ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                          done ? "scale-x-100 opacity-80" : "scale-x-0 opacity-0",
                        )}
                      />
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}
