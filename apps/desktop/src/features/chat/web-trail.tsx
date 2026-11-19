"use client";

import type { WebFetchDetails, WebSearchDetails, WebSearchResult } from "@primus/protocol";
import { WEBFETCH_TOOL } from "@primus/protocol";
import { useId, useState } from "react";
import { useExternalLinkConfirm } from "@/components/external-link-confirm";
import { Icon } from "@/components/icons";
import { Tooltip } from "@/components/ui/tooltip";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { Collapse, StepButton } from "./work-step";

// 联网步骤（ADR 0020）：工作过程里的“研究轨迹”，参考 BoardUI 的 Web Search 组件按本项目重新实现。
// 每次搜索一行“已搜索 <关键词>”，搜到结果时下面跟一行来源：站点标记重叠成一排（最多 6 个，其余显示数字），
// 悬停显示标题与域名，点击经外链确认用系统浏览器打开；点这一行展开完整的来源列表。
// 每次读取网页一行“已阅读 <标题或域名>”，展开显示地址与读到的范围。
// 不加载在线 favicon（只用本地静态资源）：站点标记是域名首字母。

const t = strings.chat.work;
const tw = t.web;

/** 一排里最多显示的站点标记（结果按网址去重，网址可作 key） */
const MAX_MARKS = 6;

type Status = "running" | "done" | "error";

export interface WebCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 工具结果里的文字（没有结构化 details 时的错误原因），去掉 `[failed]` 前缀，最多 300 字 */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return typeof content === "string" ? content : undefined;
  const text = content
    .map((b) =>
      b && typeof b === "object" && (b as { type?: unknown }).type === "text"
        ? String((b as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n")
    .replace(/^\[(failed|cancelled)\]\s*/, "")
    .trim();
  return text ? text.slice(0, 300) : undefined;
}

/** `www.example.com` → `example.com` */
const bareSite = (site: string) => site.replace(/^www\d?\./i, "");

/** 站点标记的字母：去掉 www 后的域名首字母（大写） */
export function markLetter(site: string): string {
  const s = bareSite(site);
  return (s[0] ?? "?").toUpperCase();
}

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (all, k: string) => (k in values ? String(values[k]) : all));

const argText = (call: WebCall, key: string) => {
  const v = call.arguments?.[key];
  return typeof v === "string" ? v.trim() : "";
};

/** 一个站点标记：圆形首字母，悬停显示标题与域名，点击打开 */
function SiteMark({
  result,
  onOpen,
  index,
}: {
  result: WebSearchResult;
  onOpen: (url: string) => void;
  index: number;
}) {
  return (
    <Tooltip content={fill(tw.source, { title: result.title, site: bareSite(result.site) })}>
      <button
        type="button"
        aria-label={`${result.title}（${bareSite(result.site)}）`}
        onClick={() => onOpen(result.url)}
        style={{ zIndex: MAX_MARKS - index }}
        className={cn(
          "relative flex size-5 shrink-0 items-center justify-center rounded-full bg-surface text-2xs font-semibold text-muted ring-1 ring-border outline-none transition-[translate,color] duration-200 hover:z-10 hover:-translate-y-0.5 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60",
          index > 0 && "-ml-1.5",
        )}
      >
        {markLetter(result.site)}
      </button>
    </Tooltip>
  );
}

/** 一次搜索：一行关键词 + 一行来源，点击展开来源列表 */
function SearchRow({
  call,
  status,
  details,
  errorText,
  onOpen,
}: {
  call: WebCall;
  status: Status;
  details?: WebSearchDetails;
  /** 没有结构化错误时的错误原因（工具结果文字） */
  errorText?: string;
  onOpen: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const running = status === "running";
  const query = details?.query || argText(call, "query");
  const results = details?.status === "done" ? details.results : [];
  const cancelled = details?.status === "cancelled";
  const failed = !cancelled && (status === "error" || details?.status === "failed");
  return (
    <div>
      <StepButton
        open={open}
        onToggle={() => setOpen((o) => !o)}
        controls={id}
        icon="globe"
        live={running}
        failed={failed}
      >
        {running ? t.tools.web.running : t.tools.web.done}
        {query && <span className="ml-1.5 text-fg/80">{query}</span>}
        {failed && <span className="ml-1.5 text-danger">{tw.failed}</span>}
        {cancelled && <span className="ml-1.5">{tw.cancelled}</span>}
      </StepButton>
      {results.length > 0 && (
        <div className="step-in mt-0.5 mb-0.5 ml-[7px] flex items-center gap-2 border-border/80 border-l pl-3">
          <span className="text-2xs text-muted">{tw.sources}</span>
          <div className="flex items-center py-0.5">
            {results.slice(0, MAX_MARKS).map((r, i) => (
              <SiteMark key={r.url} result={r} index={i} onOpen={onOpen} />
            ))}
          </div>
          <span className="text-2xs text-muted tabular-nums">
            {results.length > MAX_MARKS
              ? `+${results.length - MAX_MARKS}`
              : fill(tw.results, { n: results.length })}
          </span>
        </div>
      )}
      <Collapse open={open} id={id}>
        <div className="mt-1 mb-1.5 overflow-hidden rounded-xl bg-hover/70 ring-1 ring-border/60">
          {failed || cancelled ? (
            <p className={cn("px-3 py-2 text-xs", failed ? "text-danger" : "text-muted")}>
              {details?.error ?? (cancelled ? tw.cancelled : (errorText ?? tw.failed))}
            </p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted">{running ? "…" : tw.noResults}</p>
          ) : (
            <ul className="max-h-64 overflow-auto py-1">
              {results.map((r) => (
                <li key={r.url}>
                  <button
                    type="button"
                    onClick={() => onOpen(r.url)}
                    className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs outline-none transition-colors hover:bg-hover focus-visible:bg-hover"
                  >
                    <span
                      aria-hidden
                      className="flex size-4 shrink-0 items-center justify-center rounded-full bg-surface text-2xs font-semibold text-muted ring-1 ring-border"
                    >
                      {markLetter(r.site)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-fg">{r.title}</span>
                    <span className="shrink-0 text-muted">{bareSite(r.site)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Collapse>
    </div>
  );
}

/** 一次读取网页：一行“已阅读 <标题或域名>”，展开显示地址与读到的范围 */
function FetchRow({
  call,
  status,
  details,
  errorText,
  onOpen,
}: {
  call: WebCall;
  status: Status;
  details?: WebFetchDetails;
  /** 没有结构化错误时的错误原因（工具结果文字） */
  errorText?: string;
  onOpen: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const running = status === "running";
  const url = details?.finalUrl || details?.url || argText(call, "url");
  let site = "";
  try {
    site = bareSite(new URL(url).hostname);
  } catch {}
  const cancelled = details?.status === "cancelled";
  const failed = !cancelled && (status === "error" || details?.status === "failed");
  const find = argText(call, "find");
  const label = details?.title || site || url;
  const info =
    details?.status === "done"
      ? find && details.matches !== undefined
        ? fill(tw.matches, { find, n: details.matches })
        : details.range && details.totalChars
          ? fill(tw.range, {
              start: details.range[0],
              end: details.range[1],
              total: details.totalChars,
            })
          : ""
      : "";
  return (
    <div>
      <StepButton
        open={open}
        onToggle={() => setOpen((o) => !o)}
        controls={id}
        icon="link"
        live={running}
        failed={failed}
      >
        {running ? t.tools.fetch.running : t.tools.fetch.done}
        {label && <span className="ml-1.5 text-fg/80">{label}</span>}
        {site && details?.title && <span className="ml-1.5 text-2xs opacity-70">{site}</span>}
        {failed && <span className="ml-1.5 text-danger">{tw.failed}</span>}
        {cancelled && <span className="ml-1.5">{tw.cancelled}</span>}
      </StepButton>
      <Collapse open={open} id={id}>
        <div className="mt-1 mb-1.5 flex flex-col gap-1 rounded-xl bg-hover/70 px-3 py-2 text-xs ring-1 ring-border/60">
          {url && (
            <button
              type="button"
              onClick={() => onOpen(url)}
              className="flex min-w-0 items-center gap-1.5 self-start rounded text-left text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <span className="min-w-0 truncate font-mono">{url}</span>
              <Icon name="external-link" size="xs" className="shrink-0 text-muted" />
            </button>
          )}
          {info && <span className="text-muted tabular-nums">{info}</span>}
          {(failed || cancelled) && (
            <span className={failed ? "text-danger" : "text-muted"}>
              {details?.error ?? (cancelled ? tw.cancelled : (errorText ?? tw.failed))}
            </span>
          )}
        </div>
      </Collapse>
    </div>
  );
}

/** 连续的联网步骤：按顺序一行一行显示（不像其他工具那样合并成一行汇总） */
export function WebTrail<C extends WebCall>({
  calls,
  infoOf,
}: {
  calls: C[];
  infoOf: (call: C) => { status: Status; details?: unknown; content?: unknown };
}) {
  const link = useExternalLinkConfirm(tw.linkDescription);
  return (
    <div className="flex flex-col gap-0.5">
      {calls.map((call) => {
        const info = infoOf(call);
        const errorText = info.status === "error" ? contentText(info.content) : undefined;
        return (
          <div key={call.id} className="step-in">
            {call.name === WEBFETCH_TOOL ? (
              <FetchRow
                call={call}
                status={info.status}
                details={info.details as WebFetchDetails | undefined}
                errorText={errorText}
                onOpen={link.confirm}
              />
            ) : (
              <SearchRow
                call={call}
                status={info.status}
                details={info.details as WebSearchDetails | undefined}
                errorText={errorText}
                onOpen={link.confirm}
              />
            )}
          </div>
        );
      })}
      {link.ui}
    </div>
  );
}
