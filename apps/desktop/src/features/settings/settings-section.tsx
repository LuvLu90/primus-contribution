import type { ReactNode } from "react";

/** 设置分组共用同一表面，行之间用细线区分。 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="px-1 text-sm font-semibold text-fg">{title}</h3>
      <div className="divide-y divide-border rounded-xl border border-border bg-surface">
        {children}
      </div>
    </section>
  );
}

export function Row({
  label,
  hint,
  labelId,
  children,
}: {
  label: string;
  hint?: string;
  labelId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-32 flex-1">
        <p id={labelId} className="text-sm font-medium">
          {label}
        </p>
        {hint && <p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
