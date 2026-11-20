"use client";

import { type ReactNode, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { cn } from "@/lib/utils";

// 工作过程里一行步骤的公共部件（agent-turn 与联网步骤 web-trail 共用）：平滑展开 / 收起，以及可展开的一行。

/** 高度平滑展开/收起：grid 行从 0fr 过渡到 1fr，内容同时淡入 */
export function Collapse({
  open,
  id,
  children,
}: {
  open: boolean;
  id?: string;
  children: ReactNode;
}) {
  // 收起时不渲染内容：长工作过程里成百上千行输出不必常驻 DOM（等收起动画结束再卸载）
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), 400);
    return () => clearTimeout(timer);
  }, [open]);
  return (
    <div id={id} className="collapse-grid" data-open={open || undefined} inert={!open}>
      <div className="min-h-0 overflow-hidden">{(open || mounted) && children}</div>
    </div>
  );
}

export function StepButton({
  open,
  onToggle,
  controls,
  icon,
  children,
  live,
  failed,
  lead,
  trailing,
  labelClass,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  icon: IconName;
  children: ReactNode;
  live?: boolean;
  failed?: boolean;
  /** 代替图标显示在行首（思考进行中的波纹点阵） */
  lead?: ReactNode;
  /** 文字后面的附加内容（思考计时） */
  trailing?: ReactNode;
  /** 文字的额外类（思考进行中的流光；给了就不再用 live 的呼吸） */
  labelClass?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="group/step -mx-1.5 flex max-w-full items-center gap-2 rounded-lg px-1.5 py-[3px] text-left text-sm text-muted outline-none transition-colors duration-200 hover:bg-hover/60 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {lead ?? <Icon name={icon} size="sm" className={cn(failed && "text-danger")} />}
      <span className={cn("min-w-0 truncate", labelClass ?? (live && "text-pulse"))}>
        {children}
      </span>
      {trailing}
      <Icon
        name="chevron-right"
        size="sm"
        className={cn(
          "text-muted opacity-0 transition-[rotate,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/step:opacity-100 group-focus-visible/step:opacity-100",
          open && "rotate-90 opacity-100",
        )}
      />
    </button>
  );
}
