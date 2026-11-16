// 能力中心两个页签共用的样式与文案填充（与设置·模型渠道一致）

export const buttonClass =
  "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-sm ring-1 ring-border transition-colors enabled:hover:bg-hover disabled:opacity-50 motion-reduce:transition-none";
export const iconButtonClass =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50 motion-reduce:transition-none";
export const inputClass =
  "w-full rounded-xl bg-black/[0.04] px-3 py-2 text-sm text-fg outline-none ring-1 ring-border transition-shadow placeholder:text-muted focus:ring-2 focus:ring-accent/50 aria-[invalid=true]:ring-danger/60 motion-reduce:transition-none dark:bg-white/[0.06]";
export const primaryButtonClass =
  "rounded-full bg-fg px-4 py-1.5 font-medium text-surface disabled:opacity-40";
export const cardClass =
  "rounded-2xl bg-white/70 shadow-[0_1px_2px_rgb(0_0_0/0.04)] ring-1 ring-black/[0.06] dark:bg-white/[0.06] dark:ring-white/[0.08]";

export const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));
