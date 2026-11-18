"use client";

// 对话内生成的图片（ADR 0018）。生成框复刻 BoardUI「AI 图像生成」模板（只用现有依赖，自己实现）：
// - 200×250 的圆角卡片从 0 高度展开进对话（高度 0.55s，淡入去模糊 0.35s）；
// - 框内是画布点阵波纹（一圈圈从中心扩散的亮环，9px 点距，边缘淡出），左下“正在生成图片”流光文字，右下翻页数字倒计时；
// - 完成后画布淡出，图片以羽化的径向遮罩从中心揭示（--reveal 0% → 132%，1.55s，同时去模糊）；上方出现“已生成图片”；
// - 框下是操作行（复制、保存、查看大图），操作结果在框内底部以提示条显示。
// 点开看大图（按需读原图），失败或停止时只显示一行说明（原因由模型在回复里解释）。
// 图片在数据目录里（约束 C2），经 attachment_image 在内存里读成 data URL 显示；保存走薄壳的 image_save（系统“另存为”）。

import type { ImageGenDetails, ImageGenImage } from "@primus/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { Tooltip } from "@/components/ui/tooltip";
import { getPlatform } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { ImageLightbox } from "./attachments/image-lightbox";

const t = strings.chat.imagegen;

/** 卡片里的缩略图最长边（卡片 200×250，按 2 倍屏读取，铺满裁切） */
export const TILE_EDGE = 640;
/** 大图、复制时读取的最长边：生成的图片最长 1536，读回来基本是原图 */
export const DISPLAY_EDGE = 2048;

/** 框内提示的持续时间 */
const NOTICE_MS = 2200;

/** 各意图的预计用时（秒），改图另加 15 秒；只用于倒计时显示 */
const ESTIMATE_S: Record<string, number> = { fast: 30, default: 45, quality: 60 };

/** 预计还要多少秒（不小于 0） */
export function remainingSeconds(intent: unknown, editing: boolean, elapsedMs: number): number {
  const total = (ESTIMATE_S[String(intent)] ?? ESTIMATE_S.default ?? 45) + (editing ? 15 : 0);
  return Math.max(0, Math.ceil(total - elapsedMs / 1000));
}

/** 把图片转成 PNG 写入剪贴板（剪贴板只接受 image/png） */
export async function copyImage(src: string): Promise<void> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("canvas unavailable");
  g.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("encode failed");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

// ---- 画布波纹 ----

/** 亮环宽度（高斯方差，越大环越宽；模板是 0.0112，加宽到一圈约 3–4 个点，更醒目） */
const RING_WIDTH = 0.02;

const smoothstep = (a: number, b: number, x: number) => {
  const k = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** 波纹强度：每 1.3 秒从中心发出一圈，约 2.6 秒扩到边缘，出生与消失都平滑过渡 */
export function rippleAt(x: number, y: number, time: number, aspect: number): number {
  const dx = (x - 0.5) * aspect;
  const dy = y - 0.5;
  const dist = Math.sqrt(dx * dx + dy * dy) / 0.5;
  const life = 1.8 / 0.7;
  const phase = time % 1.3;
  const rings = Math.ceil(life / 1.3) + 1;
  let v = 0;
  for (let i = 0; i < rings; i += 1) {
    const r = (phase + 1.3 * i) / life;
    if (r > 1) continue;
    const d = dist - r;
    v += Math.exp(-(d * d) / RING_WIDTH) * smoothstep(0, 0.1, r) * (1 - smoothstep(0.62, 1, r));
  }
  return Math.min(1, v);
}

/** 点阵间距（CSS 像素） */
const DOT_GAP = 10;

/** 减少动态效果时画的静止亮环 */
function stillRing(x: number, y: number, aspect: number): number {
  const d = Math.sqrt(((x - 0.5) * aspect) ** 2 + (y - 0.5) ** 2) / 0.5 - 0.45;
  return Math.exp(-(d * d) / RING_WIDTH);
}

/** 点阵波纹画布：颜色取主题的前景色与次要色（每 0.5 秒重读一次，跟随深浅色切换） */
function useRipple(stopped: boolean) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const box = canvas?.parentElement;
    const g = canvas?.getContext("2d");
    if (!canvas || !box || !g || stopped) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const start = performance.now();
    let rect = box.getBoundingClientRect();
    let dirty = true;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      rect = box.getBoundingClientRect();
      dirty = true;
    });
    ro.observe(box);
    // 底点用次要文字色；亮环用彩虹色，深色外观下提亮。每 0.5 秒重读一次，跟随深浅色切换
    const readTheme = () => ({
      neutral: getComputedStyle(box).getPropertyValue("--color-muted").trim() || "#6e6e73",
      dark: document.documentElement.classList.contains("dark"),
    });
    let theme = readTheme();
    let themeAt = start;
    let dpr = 1;
    const draw = (now: number) => {
      if (dirty) {
        dirty = false;
        dpr = Math.min(window.devicePixelRatio || 1, 3);
        const w = Math.max(1, Math.round(rect.width * dpr));
        const h = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      if (now - themeAt > 500) {
        theme = readTheme();
        themeAt = now;
      }
      const elapsed = (now - start) / 1000;
      const light = theme.dark ? 66 : 52;
      const cols = Math.ceil(rect.width / DOT_GAP) + 1;
      const rows = Math.ceil(rect.height / DOT_GAP) + 1;
      const ox = (rect.width - (cols - 1) * DOT_GAP) / 2;
      const oy = (rect.height - (rows - 1) * DOT_GAP) / 2;
      const aspect = rect.width / rect.height;
      // 点心对齐到物理像素中心：Windows 125% / 150% 缩放下不再被抗锯齿糊成一团
      const snap = (v: number) => (Math.round(v * dpr - 0.5) + 0.5) / dpr;
      g.clearRect(0, 0, rect.width, rect.height);
      for (let r = 0; r < rows; r += 1) {
        const y = snap(oy + DOT_GAP * r);
        const ny = y / rect.height;
        for (let c = 0; c < cols; c += 1) {
          const x = snap(ox + DOT_GAP * c);
          const nx = x / rect.width;
          const v = still ? stillRing(nx, ny, aspect) : rippleAt(nx, ny, elapsed, aspect);
          const edge = Math.max(0, Math.min(1, 6 * nx, (1 - nx) * 6, 6 * ny, (1 - ny) * 6));
          if (v > 0.12) {
            // 色相随角度绕中心分布并缓慢旋转，外圈略偏移，形成流动的彩虹环
            const angle = Math.atan2(ny - 0.5, (nx - 0.5) * aspect);
            const hue = ((angle * 180) / Math.PI + elapsed * 60 + 360) % 360;
            g.globalAlpha = edge * Math.min(1, 0.35 + 0.65 * v);
            g.fillStyle = `hsl(${hue.toFixed(0)} 90% ${light}%)`;
            g.beginPath();
            g.arc(x, y, 1.1 + 1.1 * v, 0, Math.PI * 2);
          } else {
            g.globalAlpha = edge * 0.22;
            g.fillStyle = theme.neutral;
            g.beginPath();
            g.arc(x, y, 1, 0, Math.PI * 2);
          }
          g.fill();
        }
      }
      g.globalAlpha = 1;
      if (!still) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [stopped]);
  return ref;
}

// ---- 翻页数字倒计时 ----

function DigitHalf({ digit, half }: { digit: string; half: "top" | "bottom" }) {
  return (
    <span className="block h-2 overflow-hidden bg-track">
      <span
        className={cn(
          "block h-4 text-center leading-4 text-fg tabular-nums",
          half === "bottom" && "-mt-2",
        )}
      >
        {digit}
      </span>
    </span>
  );
}

/** 一位翻页数字：数字变化时上半页落下、新数字的下半页翻起 */
function FlipDigit({ digit }: { digit: string }) {
  const [state, setState] = useState({ settled: digit, from: digit, key: 0 });
  if (state.settled !== digit)
    setState({ settled: digit, from: state.settled, key: state.key + 1 });
  const changing = state.settled !== digit;
  const from = changing ? state.settled : state.from;
  const key = changing ? state.key + 1 : state.key;
  return (
    <span
      aria-hidden="true"
      className="relative block w-[11px] overflow-hidden rounded-[3px] bg-track [perspective:70px]"
    >
      <DigitHalf digit={digit} half="top" />
      <DigitHalf digit={from} half="bottom" />
      {key > 0 && (
        <span key={key} className="pointer-events-none absolute inset-0">
          <span className="imggen-flap-fall absolute inset-x-0 top-0">
            <DigitHalf digit={from} half="top" />
          </span>
          <span className="imggen-flap-rise absolute inset-x-0 bottom-0">
            <DigitHalf digit={digit} half="bottom" />
          </span>
        </span>
      )}
    </span>
  );
}

function Countdown({ seconds }: { seconds: number }) {
  return (
    <span className="flex shrink-0 items-center gap-px">
      {String(seconds)
        .split("")
        .map((d, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 按位置翻页，位置就是标识
          <FlipDigit key={i} digit={d} />
        ))}
      <span aria-hidden="true">s</span>
      <span className="sr-only">{t.remaining.replace("{s}", String(seconds))}</span>
    </span>
  );
}

/** 每秒刷新的倒计时（从卡片出现时算起） */
function useCountdown(active: boolean, intent: unknown, editing: boolean): number {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return remainingSeconds(intent, editing, now - start);
}

// ---- 一张图 ----

type Notice = { kind: "ok" | "error"; action: "save" | "copy"; text: string } | null;

/** 读一张图成 data URL */
async function readImage(path: string, edge: number): Promise<string> {
  const img = await (await getPlatform()).attachmentImage(path, edge);
  return `data:${img.mimeType};base64,${img.data}`;
}

/** 框下操作行的按钮（同模板：浅底圆角、16px 图标） */
function ActionButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="flex items-center rounded-lg bg-hover p-1.5 text-muted outline-none transition-colors duration-150 hover:bg-track-strong hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
      >
        <Icon name={icon} size="sm" />
      </button>
    </Tooltip>
  );
}

function ImageFrame({
  image,
  alt,
  label,
  seconds,
  animateIn,
}: {
  /** 生成好的图片；生成中没有 */
  image: ImageGenImage | undefined;
  alt: string;
  /** 生成中左下角的文字 */
  label: string;
  /** 倒计时秒数；0 时不显示 */
  seconds: number;
  /** 生成中出现的卡片：展开进入、揭示动画；历史消息里直接显示 */
  animateIn: boolean;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [fullSrc, setFullSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const fullRef = useRef<Promise<string> | null>(null);
  const path = image?.path;
  const canvasRef = useRipple(shown || missing);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    let alive = true;
    setThumb(null);
    setShown(false);
    setFullSrc(null);
    setMissing(false);
    fullRef.current = null;
    if (!path) return;
    readImage(path, TILE_EDGE)
      .then((src) => {
        if (alive) setThumb(src);
      })
      .catch(() => {
        if (alive) setMissing(true);
      });
    return () => {
      alive = false;
    };
  }, [path]);

  const full = useCallback(() => {
    if (!path) return Promise.reject(new Error(t.missing));
    if (fullRef.current) return fullRef.current;
    // 只认当前路径的结果；失败时清掉缓存，下次复制或看大图重新读
    const request: Promise<string> = readImage(path, DISPLAY_EDGE).then(
      (src) => {
        if (fullRef.current === request) setFullSrc(src);
        return src;
      },
      (e: unknown) => {
        if (fullRef.current === request) fullRef.current = null;
        throw e;
      },
    );
    fullRef.current = request;
    return request;
  }, [path]);

  const save = async () => {
    if (busy || !path) return;
    setBusy(true);
    try {
      const saved = await (await getPlatform()).imageSave(path);
      if (saved) setNotice({ kind: "ok", action: "save", text: t.saved });
    } catch (e) {
      setNotice({
        kind: "error",
        action: "save",
        text: t.saveFailed.replace("{reason}", e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await copyImage(await full());
      setNotice({ kind: "ok", action: "copy", text: t.copied });
    } catch {
      setNotice({ kind: "error", action: "copy", text: t.copyFailed });
    }
  };
  const openLightbox = () => {
    setOpen(true);
    full().catch(() => undefined);
  };
  const done = (action: "save" | "copy") => notice?.kind === "ok" && notice.action === action;
  const generating = !image;

  const toast = notice && (
    <div
      key={`${notice.action}-${notice.text}`}
      role="status"
      className={cn(
        "imggen-toast absolute inset-x-3 bottom-3 truncate rounded-lg bg-scrim px-2.5 py-1.5 text-center text-xs font-medium backdrop-blur-sm",
        notice.kind === "error" ? "text-danger" : "text-on-scrim",
      )}
    >
      {notice.text}
    </div>
  );

  return (
    <div className="group/frame flex w-[200px] flex-col items-start gap-2">
      <div className={cn("w-[200px] overflow-hidden", animateIn ? "imggen-unfold" : "h-[250px]")}>
        <div
          role="group"
          aria-live="polite"
          aria-label={shown ? alt : generating ? label : t.loading}
          className="relative h-[250px] w-[200px] overflow-hidden rounded-2xl border border-track-strong bg-surface shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]"
        >
          <canvas
            ref={canvasRef}
            className={cn(
              "absolute inset-0 size-full transition-opacity duration-300",
              shown ? "opacity-0" : "opacity-100",
            )}
          />
          <div
            aria-hidden={!generating || undefined}
            className={cn(
              "absolute inset-x-3 bottom-3 flex items-center justify-between gap-3 text-xs font-medium transition-opacity duration-300",
              generating ? "opacity-100" : "opacity-0",
            )}
          >
            <span className="imggen-shimmer inline-block truncate">{label}</span>
            {generating && seconds > 0 && <Countdown seconds={seconds} />}
          </div>
          {missing && (
            <span className="absolute inset-0 grid place-items-center text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <Icon name="image" size="sm" />
                {t.missing}
              </span>
            </span>
          )}
          {thumb && (
            <button
              type="button"
              aria-label={t.open}
              onClick={openLightbox}
              data-shown={shown || undefined}
              className={cn(
                "absolute inset-0 cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                animateIn && "imggen-reveal",
              )}
            >
              {/* biome-ignore lint/performance/noImgElement: 静态导出，图片是内存里的 data URL */}
              <img
                src={thumb}
                alt={alt}
                draggable={false}
                onLoad={() => requestAnimationFrame(() => setShown(true))}
                className="size-full object-cover"
              />
            </button>
          )}
          {toast}
        </div>
      </div>
      {image && thumb && (
        // 操作行只在鼠标移到图片（或键盘聚焦到按钮）时显示，位置常驻，不让下方内容跳动
        <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-150 group-focus-within/frame:opacity-100 group-hover/frame:opacity-100">
          <ActionButton icon={done("copy") ? "check" : "copy"} label={t.copy} onClick={copy} />
          <ActionButton
            icon={busy ? "loader" : done("save") ? "check" : "download"}
            label={busy ? t.saving : t.save}
            disabled={busy}
            onClick={save}
          />
          <ActionButton icon="maximize" label={t.open} onClick={openLightbox} />
        </div>
      )}
      <ImageLightbox
        src={open ? (fullSrc ?? thumb) : null}
        alt={alt}
        onClose={() => setOpen(false)}
        actions={
          <>
            {notice && (
              <span
                role="status"
                className={cn(
                  "rounded-full bg-scrim px-3 py-1.5 text-xs",
                  notice.kind === "error" ? "text-danger" : "text-on-scrim",
                )}
              >
                {notice.text}
              </span>
            )}
            <Tooltip content={t.copy}>
              <button
                type="button"
                aria-label={t.copy}
                onClick={copy}
                className="grid size-8 place-items-center rounded-full bg-scrim text-on-scrim outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-on-scrim"
              >
                <Icon name={done("copy") ? "check" : "copy"} size="sm" />
              </button>
            </Tooltip>
            <Tooltip content={t.save}>
              <button
                type="button"
                aria-label={busy ? t.saving : t.save}
                disabled={busy}
                onClick={save}
                className="grid size-8 place-items-center rounded-full bg-scrim text-on-scrim outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-on-scrim disabled:opacity-60"
              >
                <Icon name={busy ? "loader" : done("save") ? "check" : "download"} size="sm" />
              </button>
            </Tooltip>
          </>
        }
      />
    </div>
  );
}

export function ImageGenCard({
  args,
  details,
  running,
}: {
  /** 工具调用参数（张数、意图，按 images 区分改图） */
  args: Record<string, unknown> | undefined;
  /** 工具结果的 details；生成中没有 */
  details: ImageGenDetails | undefined;
  /** 这次调用仍在进行 */
  running: boolean;
}) {
  // 卡片出现时还在生成：之后的完成要展开进入、揭示；打开历史会话时直接显示
  const [animateIn] = useState(() => running && !details);
  const prompt = details?.prompt ?? (typeof args?.prompt === "string" ? args.prompt : "");
  const alt = t.alt.replace("{prompt}", prompt);
  const editing = Array.isArray(args?.images) && args.images.length > 0;
  const generating = running && !details;
  const doneImages = details?.status === "done" ? details.images : [];
  const seconds = useCountdown(generating, args?.intent, editing);

  if (generating || doneImages.length > 0) {
    const count = generating ? Math.min(4, Math.max(1, Number(args?.n) || 1)) : doneImages.length;
    return (
      <section
        aria-label={t.card}
        aria-busy={generating || undefined}
        className="flex w-full flex-col items-start gap-2"
      >
        <p className="flex h-5 items-baseline text-sm text-fg">
          {!generating && <span className="step-in">{t.generated}</span>}
        </p>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: count }, (_, i) => (
            <ImageFrame
              // biome-ignore lint/suspicious/noArrayIndexKey: 生成框按位置对应结果里的第 i 张图
              key={i}
              image={doneImages[i]}
              alt={alt}
              label={editing ? t.editing : t.generating}
              seconds={seconds}
              animateIn={animateIn}
            />
          ))}
        </div>
      </section>
    );
  }

  // 失败、停止，或这一轮结束时没有结果（中途停止）
  const failed = details?.status === "failed";
  return (
    <p
      className={cn(
        "flex items-center gap-1.5 self-start text-xs",
        failed ? "text-danger" : "text-muted",
      )}
    >
      <Icon name={failed ? "alert-circle" : "image"} size="sm" />
      {failed ? `${t.failed}${details?.error ? `：${details.error}` : ""}` : t.cancelled}
    </p>
  );
}
