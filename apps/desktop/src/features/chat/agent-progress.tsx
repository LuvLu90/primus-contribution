"use client";

// 计划进度卡片（照 BoardUI「智能体任务进度」，ADR 0019）：输入框上方一块可折叠的卡片，默认收起成一行
// “进度环 还剩 N 步 → 当前步骤”，点开列出全部步骤。不引入动画库，全部用 CSS 过渡与 keyframes：
// - 卡片高度在收起（44px）与展开（45 + 38·N，超过 8 步时封顶、列表内部滚动）之间过渡；两层内容交叉淡入、模糊。
// - 总进度环按真实完成比例推进（模板按总时长线性走；真实步骤没有固定时长）；当前步骤的小环是旋转的弧线。
// - 当前步骤一行变成胶囊（细边框随当前步骤平滑移动），文字流光；完成的打勾并从左划出删除线；跳过的打斜杠。
// - 全部完成后显示“全部步骤已完成”，停 1.8 秒后淡出；之后出现新的未完成步骤时重新显示。
import { currentTodo, type TodoItem } from "@primus/protocol";
import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";

const t = strings.chat.progress;

const ROW = 32;
const GAP = 6;
const PITCH = ROW + GAP;
/** 展开时最多直接显示的步数，再多列表内部滚动 */
const MAX_ROWS = 8;
const COLLAPSED_H = 44;
/** 全部完成后停留多久再淡出 */
export const COMPLETION_DELAY_MS = 1800;
const LEAVE_MS = 320;

const finished = (s: TodoItem["status"]) => s === "completed" || s === "skipped";

/** 展开高度：头部 41 + 列表 + 底部 10（与模板 45 + 38·N 一致） */
export const expandedHeight = (n: number) => 45 + PITCH * Math.min(Math.max(n, 1), MAX_ROWS);

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

export function AgentProgress({
  items,
  defaultExpanded = false,
  hidden = false,
  className,
}: {
  items: readonly TodoItem[];
  /** 暂时让位（工具确认、提问、计划审批）：不显示，但保留展开与完成状态 */
  hidden?: boolean;
  /** 初始是否展开（默认收起成一行） */
  defaultExpanded?: boolean;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  /** 每次展开加一：步骤行重新做依次淡入 */
  const [openCount, setOpenCount] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  /** 切换后要把焦点交给另一层的按钮（键盘操作时原按钮变成 inert） */
  const moveFocus = useRef(false);
  const current = currentTodo(items);
  const doneCount = items.filter((i) => finished(i.status)).length;
  const allDone = items.length > 0 && current === undefined;
  const phase = useLifecycle(items, allDone);
  const activeIndex = items.findIndex((i) => i.status === "in_progress");
  const left = items.length - doneCount;
  const label = allDone ? t.allDone : t.left.replace("{n}", String(left));

  // 当前步骤换了：滚进可见范围（步数超过 8 时）
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!expanded || !list || activeIndex < 0) return;
    const top = activeIndex * PITCH;
    if (top < list.scrollTop || top + ROW > list.scrollTop + list.clientHeight)
      list.scrollTo?.({
        top: Math.max(0, top - PITCH),
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
  }, [activeIndex, expanded]);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (expanded ? collapseRef : expandRef).current?.focus();
  }, [expanded]);

  const toggle = (next: boolean) => {
    const holder = next ? expandRef.current : collapseRef.current;
    moveFocus.current = holder !== null && document.activeElement === holder;
    if (next) setOpenCount((c) => c + 1);
    setExpanded(next);
  };

  if (hidden || items.length === 0 || phase === "gone") return null;

  const height = expanded ? expandedHeight(items.length) : COLLAPSED_H;
  const ratio = items.length ? doneCount / items.length : 0;
  const ring = !allDone && (
    <span className="flex h-4 w-6 shrink-0 items-center">
      <ProgressRing ratio={ratio} />
    </span>
  );

  return (
    <section
      aria-label={t.label}
      aria-live="polite"
      data-testid="agent-progress"
      data-expanded={expanded || undefined}
      style={{ height } as CSSProperties}
      className={cn(
        "agentp-in relative w-[341px] max-w-full overflow-hidden rounded-2xl border border-track-strong bg-surface shadow-[0_1px_2px_0_rgb(0_0_0/0.05)]",
        "transition-[height,opacity,filter] motion-reduce:transition-none ease-[cubic-bezier(0.22,1,0.36,1)]",
        expanded ? "duration-[650ms]" : "duration-[420ms]",
        phase === "leaving" && "opacity-0 blur-[3px]",
        className,
      )}
    >
      {/* 收起：一行，整行是展开按钮 */}
      <button
        type="button"
        aria-label={`${t.expand}：${label}${current ? `，${current.text}` : ""}`}
        aria-expanded={false}
        aria-controls={listId}
        ref={expandRef}
        onClick={() => toggle(true)}
        inert={expanded || undefined}
        className={cn(
          "group/min absolute inset-0 flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-sm font-medium outline-none transition-[opacity,filter] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] focus-visible:ring-2 focus-visible:ring-accent/40",
          expanded ? "pointer-events-none opacity-0 blur-[3px]" : "opacity-100 blur-0 delay-100",
        )}
      >
        <span className="flex min-w-0 shrink-0 items-center ps-1">
          {ring}
          <SwapLabel text={label} className="text-muted" />
        </span>
        {current && (
          <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden py-1.5 pe-6 transition-[mask-image] duration-300 group-hover/min:[mask-image:linear-gradient(to_right,#000_0%,#000_68%,transparent_94%)] group-focus-visible/min:[mask-image:linear-gradient(to_right,#000_0%,#000_68%,transparent_94%)]">
            <svg aria-hidden viewBox="0 0 14 14" className="size-3.5 shrink-0 fill-muted">
              <path d="M7.47 2.47a.75.75 0 0 1 1.06 0l4.177 4.176a.5.5 0 0 1 0 .708L8.53 11.53a.75.75 0 0 1-1.06-1.06l2.72-2.72H2a.75.75 0 0 1 0-1.5h8.19L7.47 3.53a.75.75 0 0 1 0-1.06Z" />
            </svg>
            <span className="agentp-shimmer block min-w-0 flex-1 truncate">{current.text}</span>
          </span>
        )}
        <span className="absolute top-1/2 right-2.5 size-5 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover/min:opacity-100 group-focus-visible/min:opacity-100">
          <svg aria-hidden viewBox="0 0 20 20" className="size-5">
            <rect
              x="1"
              y="1"
              width="18"
              height="18"
              rx="4"
              className="fill-black/[0.06] dark:fill-white/[0.1]"
            />
            <path
              d="M7.553 6.109a.75.75 0 0 1 .75-.75h5.907a.5.5 0 0 1 .5.5v5.906a.75.75 0 0 1-1.5 0V7.919l-5.79 5.791a.75.75 0 1 1-1.061-1.06l5.79-5.791H8.303a.75.75 0 0 1-.75-.75Z"
              className="fill-muted"
            />
          </svg>
        </span>
      </button>

      {/* 展开：头部 + 全部步骤 */}
      <div
        inert={!expanded || undefined}
        aria-hidden={!expanded || undefined}
        className={cn(
          "absolute inset-x-0 top-0 px-2.5 pt-3 pb-2.5 transition-[opacity,filter,translate] ease-[cubic-bezier(0.22,1,0.36,1)]",
          expanded
            ? "opacity-100 blur-0 duration-[220ms]"
            : "pointer-events-none -translate-y-1 opacity-0 blur-[3px] duration-[160ms]",
        )}
      >
        <div className="flex h-5 w-full items-center ps-1 text-sm font-medium">
          {ring}
          <SwapLabel text={label} className="flex-1 text-muted" />
          <button
            type="button"
            aria-label={t.collapse}
            aria-expanded
            aria-controls={listId}
            ref={collapseRef}
            onClick={() => toggle(false)}
            className="size-5 shrink-0 cursor-pointer rounded-sm outline-none transition-opacity duration-200 hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <span aria-hidden className="relative block size-5">
              <span className="absolute top-px left-px size-[18px] rounded-sm bg-black/[0.06] dark:bg-white/[0.1]" />
              <span className="absolute top-[13px] left-1 h-0.5 w-3 rounded-[3px] bg-muted" />
            </span>
          </button>
        </div>
        <ol
          id={listId}
          ref={listRef}
          key={openCount}
          className="scroll-none relative mt-[9px] flex flex-col overflow-y-auto overscroll-contain"
          style={{ gap: GAP, maxHeight: PITCH * MAX_ROWS - GAP }}
        >
          {/* 当前步骤的胶囊边框：一个元素随当前步骤上下移动（代替模板的 layoutId 共享布局动画） */}
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
                    "flex h-full w-full items-center gap-2 transition-[padding] motion-reduce:transition-none duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
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
    </section>
  );
}
