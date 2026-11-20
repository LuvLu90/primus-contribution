"use client";

// 对话内生成的图片（ADR 0018）。生成框是“粒子成像”（只用现有依赖，Canvas 2D 自己实现）：
// - 最大 360×450 的圆角卡片从 0 高度展开进对话（高度 0.55s，淡入去模糊 0.35s）；
// - 框内约 4500 颗浅色方点（6px 格距）先铺在深色框底，随后升成一团在原地轻晃的粒子云（与演示页 Wensity 粒子成像同一算法）；框下一行是“正在生成图片”流光文字与正向计时（如 12s）；
// - 出图后每颗粒子取对应格子的颜色，边落边长大铺满格子（上面的行先落），约 2.3 秒后原图淡入盖住；上方出现“已生成图片”；
// - 出图后框下那一行换成操作行（复制、保存、查看大图），操作结果在框内底部以提示条显示。
// 点开看大图（按需读原图），失败或停止时只显示一行说明（原因由模型在回复里解释）。
// 图片在数据目录里（约束 C2），经 attachment_image 在内存里读成 data URL 显示；保存走薄壳的 image_save（系统“另存为”）。

import type { ImageGenDetails, ImageGenImage } from "@primus/protocol";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { Tooltip } from "@/components/ui/tooltip";
import { getPlatform } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { ImageLightbox } from "./attachments/image-lightbox";

const t = strings.chat.imagegen;

/** 卡片里的缩略图最长边（卡片最大 360×450，按 2 倍屏读取） */
export const TILE_EDGE = 1024;
/** 大图、复制时读取的最长边：生成的图片最长 1536，读回来基本是原图 */
export const DISPLAY_EDGE = 2048;

/** 卡片框的最大宽高：图片按自身比例缩放塞进来、不裁切，也不超过这个尺寸（2026-11-18 按用户要求由 200×250 逐步调大） */
export const FRAME_MAX_W = 360;
export const FRAME_MAX_H = 450;

/** 把 w×h 按比例缩进 FRAME_MAX_W×FRAME_MAX_H 内（不放大超过该框）；宽高缺失（含 auto）时按方图，与工具默认尺寸 1024x1024 一致 */
export function frameBox(w?: number, h?: number): { w: number; h: number } {
  if (!w || !h || w <= 0 || h <= 0) return frameBox(1024, 1024);
  const scale = Math.min(FRAME_MAX_W / w, FRAME_MAX_H / h);
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

/** 从请求尺寸字符串（如 1024x1536）解析宽高；auto 或无法解析时为 undefined */
function parseSize(size: string | undefined): { w: number; h: number } | undefined {
  const m = /^(\d+)x(\d+)$/.exec(size ?? "");
  return m ? { w: Number(m[1]), h: Number(m[2]) } : undefined;
}

/** 框内提示的持续时间 */
const NOTICE_MS = 2200;

/** 生成已用的整秒数（不小于 0） */
export function elapsedSeconds(elapsedMs: number): number {
  return Math.max(0, Math.floor(elapsedMs / 1000));
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

// ---- 粒子成像 ----
// 与演示页里的“Wensity · 粒子成像”同一套算法：
// 生成中：深色底，浅色方点先铺在框底一条细带里，0.6–1.9 秒内错峰升起，汇成框中偏上的一团高斯粒子云，
// 每颗在自己的位置附近轻轻晃动（幅度 16×11px）；
// 出图时：每颗粒子沿直线落到自己的格子，边落边变大到铺满格子（0.84 格），颜色从浅灰过渡到该格像素色，
// 上面的行先落（错峰 0–1 秒，每颗再加 0–0.5 秒随机），约 2.3 秒后原图在 1 秒内淡入盖住。

/** 粒子格距（CSS 像素）：360×450 的框约 60×75 = 4500 颗 */
export const PARTICLE_GAP = 6;
/** 画布底色与粒子静止色 */
const FLOOR_COLOR = "#0b0b0f";
const INK: [number, number, number] = [228, 230, 240];
/** 升起：开始时刻、随机错峰上限、单颗用时（秒） */
const RISE_AT_S = 0.6;
const RISE_JITTER_S = 0.7;
const RISE_S = 1.2;
/** 框底细带高度（CSS 像素） */
const FLOOR_BAND_PX = 7;
/** 粒子云：中心（占框高比例）、高斯标准差（占框宽、框高比例）、晃动幅度（CSS 像素） */
const CLOUD_Y = 0.45;
const CLOUD_SX = 0.2;
const CLOUD_SY = 0.15;
const WOBBLE_X = 16;
const WOBBLE_Y = 11;
/** 落位：单颗用时、按行错峰、随机错峰（秒）；原图淡入的开始与用时（秒，相对出图） */
const FLY_S = 1.2;
const FLY_ROW_S = 0.5;
const FLY_JITTER_S = 0.5;
const REVEAL_AT_S = 2.3;
const REVEAL_S = 1;
/** 落位后方点占格子的比例 */
const DOT_FILL = 0.84;

/** 框内能放下的粒子行列数 */
export function particleGrid(
  w: number,
  h: number,
  gap = PARTICLE_GAP,
): { cols: number; rows: number } {
  return { cols: Math.max(1, Math.floor(w / gap)), rows: Math.max(1, Math.floor(h / gap)) };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** smoothstep */
export const smooth = (x: number) => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};

/** 单颗粒子的落位进度（0–1）：错峰 delay 之后在 FLY_S 内落完 */
export function flyProgress(sinceAssemble: number, delay: number): number {
  return smooth((sinceAssemble - delay) / FLY_S);
}

/** 标准正态样本（Box–Muller），截到 ±3 */
function gauss(): number {
  const v = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(Math.random() * Math.PI * 2);
  return Math.max(-3, Math.min(3, v));
}

type Particle = {
  /** 框底位置 */
  fx: number;
  fy: number;
  /** 云里的位置与晃动相位 */
  cx: number;
  cy: number;
  ph: number;
  /** 升起错峰、落位错峰 */
  d1: number;
  d2: number;
  /** 格子中心与像素色 */
  tx: number;
  ty: number;
  rgb: [number, number, number];
  /** 出图那一刻的位置 */
  sx: number;
  sy: number;
};

/** 粒子在云里的位置（t 秒时）：在 (cx, cy) 附近晃动，幅度 WOBBLE_X × WOBBLE_Y */
export function cloudPoint(
  p: Pick<Particle, "cx" | "cy" | "ph">,
  t: number,
): { x: number; y: number } {
  return {
    x: p.cx + WOBBLE_X * Math.sin(t * 0.9 + p.ph),
    y: p.cy + WOBBLE_Y * Math.cos(t * 1.1 + p.ph * 1.3),
  };
}

/** 图片按 object-cover 放进 w×h 时的源矩形 */
function coverRect(iw: number, ih: number, w: number, h: number) {
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  return { sx: (iw - sw) / 2, sy: (ih - sh) / 2, sw, sh };
}

/**
 * 粒子画布。返回画布 ref 与 assemble(img, onDone)：
 * 把已载入的图片拼出来，拼好后调 onDone；画布不可用、减少动态效果或粒子未就绪时返回 false（调用方直接显示图片）。
 */
function useParticles(running: boolean) {
  const ref = useRef<HTMLCanvasElement>(null);
  const assembleRef = useRef<(img: HTMLImageElement, onDone: () => void) => boolean>(() => false);
  useEffect(() => {
    const canvas = ref.current;
    const box = canvas?.parentElement;
    const g = canvas?.getContext("2d");
    if (!canvas || !box || !g || !running) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const start = performance.now();
    let rect = box.getBoundingClientRect();
    let dirty = true;
    let frame = 0;
    let parts: Particle[] = [];
    let gridKey = "";
    let cell = PARTICLE_GAP;
    /** 出图的时刻（秒，相对 start）；未出图为 -1 */
    let assembleAt = -1;
    let image: HTMLImageElement | null = null;
    let onDone: (() => void) | null = null;

    const ro = new ResizeObserver(() => {
      rect = box.getBoundingClientRect();
      dirty = true;
    });
    ro.observe(box);

    /** 按框大小铺粒子（出图后不再重铺） */
    const build = () => {
      const { cols, rows } = particleGrid(rect.width, rect.height);
      const key = `${cols}x${rows}`;
      if (key === gridKey || assembleAt >= 0) return;
      gridKey = key;
      cell = Math.min(rect.width / cols, rect.height / rows);
      const ox = (rect.width - cols * cell) / 2;
      const oy = (rect.height - rows * cell) / 2;
      parts = [];
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          parts.push({
            fx: Math.random() * rect.width,
            fy: rect.height - 3 - Math.random() * FLOOR_BAND_PX,
            cx: rect.width / 2 + gauss() * rect.width * CLOUD_SX,
            cy: rect.height * CLOUD_Y + gauss() * rect.height * CLOUD_SY,
            ph: Math.random() * Math.PI * 2,
            d1: Math.random() * RISE_JITTER_S,
            d2: Math.random() * FLY_JITTER_S + (row / rows) * FLY_ROW_S * 2,
            tx: ox + (col + 0.5) * cell,
            ty: oy + (row + 0.5) * cell,
            rgb: INK,
            sx: 0,
            sy: 0,
          });
        }
      }
    };

    /** 生成中粒子的位置：在框底轻轻抖，升起后在云里晃动 */
    const livePoint = (p: Particle, t: number) => {
      const rp = smooth((t - RISE_AT_S - p.d1) / RISE_S);
      const c = cloudPoint(p, t);
      const jig = (1 - rp) * Math.sin(t * 7 + p.ph) * 0.8;
      return { x: p.fx + (c.x - p.fx) * rp, y: p.fy + jig + (c.y - p.fy) * rp };
    };

    const draw = (now: number) => {
      if (dirty) {
        dirty = false;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const w = Math.max(1, Math.round(rect.width * dpr));
        const h = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        build();
      }
      // 减少动态效果：画一帧已升成云的静止画面
      const t = still ? RISE_AT_S + RISE_JITTER_S + RISE_S : (now - start) / 1000;
      g.globalAlpha = 1;
      g.fillStyle = FLOOR_COLOR;
      g.fillRect(0, 0, rect.width, rect.height);

      if (assembleAt < 0) {
        // 生成中：同色方点，一条路径一次填充
        g.fillStyle = `rgb(${INK[0]} ${INK[1]} ${INK[2]})`;
        g.beginPath();
        for (const p of parts) {
          const { x, y } = livePoint(p, t);
          g.rect(x - 1, y - 1, 2, 2);
        }
        g.fill();
        if (!still) frame = requestAnimationFrame(draw);
        return;
      }

      const since = t - assembleAt;
      for (const p of parts) {
        const sp = flyProgress(since, p.d2);
        const x = p.sx + (p.tx - p.sx) * sp;
        const y = p.sy + (p.ty - p.sy) * sp;
        const size = 2 + (cell * DOT_FILL - 2) * sp;
        const [r, gg, b] = p.rgb;
        g.fillStyle = `rgb(${Math.round(INK[0] + (r - INK[0]) * sp)} ${Math.round(INK[1] + (gg - INK[1]) * sp)} ${Math.round(INK[2] + (b - INK[2]) * sp)})`;
        g.fillRect(x - size / 2, y - size / 2, size, size);
      }
      // 原图淡入盖住方点；完全盖住后交给真图
      const f = smooth((since - REVEAL_AT_S) / REVEAL_S);
      if (image && f > 0) {
        const c = coverRect(
          image.naturalWidth || rect.width,
          image.naturalHeight || rect.height,
          rect.width,
          rect.height,
        );
        g.globalAlpha = f;
        g.drawImage(image, c.sx, c.sy, c.sw, c.sh, 0, 0, rect.width, rect.height);
        g.globalAlpha = 1;
      }
      if (since >= REVEAL_AT_S + REVEAL_S) {
        const done = onDone;
        onDone = null;
        done?.();
        return;
      }
      frame = requestAnimationFrame(draw);
    };

    assembleRef.current = (img, done) => {
      if (still || assembleAt >= 0 || !parts.length) return false;
      const { cols, rows } = particleGrid(rect.width, rect.height);
      if (cols * rows !== parts.length) return false;
      // 把图片按框的比例（object-cover）缩到 cols×rows，每格一个像素即该格的平均色
      const off = document.createElement("canvas");
      off.width = cols;
      off.height = rows;
      const og = off.getContext("2d", { willReadFrequently: true });
      if (!og) return false;
      const c = coverRect(img.naturalWidth || cols, img.naturalHeight || rows, cols, rows);
      let data: Uint8ClampedArray;
      try {
        og.imageSmoothingQuality = "high";
        og.drawImage(img, c.sx, c.sy, c.sw, c.sh, 0, 0, cols, rows);
        data = og.getImageData(0, 0, cols, rows).data;
      } catch {
        return false;
      }
      const t = (performance.now() - start) / 1000;
      parts.forEach((p, i) => {
        p.rgb = [data[i * 4] ?? 0, data[i * 4 + 1] ?? 0, data[i * 4 + 2] ?? 0];
        const pos = livePoint(p, t);
        p.sx = pos.x;
        p.sy = pos.y;
      });
      image = img;
      assembleAt = t;
      onDone = done;
      return true;
    };

    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      assembleRef.current = () => false;
    };
  }, [running]);
  return { ref, assemble: assembleRef };
}

// ---- 生成计时 ----

/** 每秒刷新的正向计时（从卡片出现时算起，停止后定格） */
function useElapsed(active: boolean): number {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return elapsedSeconds(now - start);
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
  size,
}: {
  /** 生成好的图片；生成中没有 */
  image: ImageGenImage | undefined;
  /** 请求的尺寸（1024x1536 等），生成中据此预留与结果一致的框，避免出图时跳动 */
  size?: string;
  alt: string;
  /** 生成中框下的文字 */
  label: string;
  /** 已用秒数（框下的计时） */
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
  // 粒子只在生成中出现的卡片里跑；历史消息直接显示图片
  const particles = useParticles(animateIn && !shown && !missing);
  const imgRef = useRef<HTMLImageElement>(null);
  // 框按图片自身比例缩放（不裁切、不超过默认大小）：有结果用结果宽高，生成中用请求尺寸预留
  const natural =
    image?.width && image?.height ? { w: image.width, h: image.height } : parseSize(size);
  const box = frameBox(natural?.w, natural?.h);

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
    <div className="group/frame flex flex-col items-start gap-2" style={{ width: box.w }}>
      <div
        className={cn("overflow-hidden", animateIn && "imggen-unfold")}
        style={{ width: box.w, height: box.h, "--imggen-h": `${box.h}px` } as CSSProperties}
      >
        <fieldset
          aria-live="polite"
          aria-label={shown ? alt : generating ? label : t.loading}
          style={{ width: box.w, height: box.h }}
          className="relative m-0 min-w-0 overflow-hidden rounded-2xl border border-track-strong bg-surface p-0 shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]"
        >
          <canvas
            ref={particles.ref}
            className={cn(
              "absolute inset-0 size-full transition-opacity duration-500",
              shown ? "opacity-0" : "opacity-100",
            )}
          />
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
                ref={imgRef}
                onLoad={() =>
                  requestAnimationFrame(() => {
                    const img = imgRef.current;
                    // 粒子拼好再换真图；拼不了（无画布、减少动态效果）就直接显示
                    if (!img || !particles.assemble.current(img, () => setShown(true)))
                      setShown(true);
                  })
                }
                className="size-full object-cover"
              />
            </button>
          )}
          {toast}
        </fieldset>
      </div>
      {/* 框下一行：生成中是“正在生成图片 12s”，图片出来后换成操作行（复制、保存、查看大图） */}
      {image && thumb && (shown || !animateIn) ? (
        // 操作行只在鼠标移到图片（或键盘聚焦到按钮）时显示，位置常驻，不让下方内容跳动
        <div className="flex h-7 items-center gap-1.5 opacity-0 transition-opacity duration-150 group-focus-within/frame:opacity-100 group-hover/frame:opacity-100">
          <ActionButton icon={done("copy") ? "check" : "copy"} label={t.copy} onClick={copy} />
          <ActionButton
            icon={busy ? "loader" : done("save") ? "check" : "download"}
            label={busy ? t.saving : t.save}
            disabled={busy}
            onClick={save}
          />
          <ActionButton icon="maximize" label={t.open} onClick={openLightbox} />
        </div>
      ) : (
        (generating || (animateIn && !missing)) && (
          <p className="flex h-7 items-center gap-1.5 text-xs font-medium">
            <span className="imggen-shimmer inline-block truncate">{label}</span>
            <span aria-hidden="true" className="shrink-0 text-muted tabular-nums">
              {seconds}s
            </span>
            <span className="sr-only">{t.elapsed.replace("{s}", String(seconds))}</span>
          </p>
        )
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

/** 多图时的轮播：一次只显示一张，左右箭头 + 底部圆点切换，水平滑动过渡（参考 Codex 的多图展示） */
function ImageCarousel({
  images,
  count,
  size,
  alt,
  label,
  seconds,
  animateIn,
}: {
  images: (ImageGenImage | undefined)[];
  count: number;
  size?: string;
  alt: string;
  label: string;
  seconds: number;
  animateIn: boolean;
}) {
  const [index, setIndex] = useState(0);
  const active = Math.min(index, count - 1);
  // 各张尺寸一致（同一次请求），用第一张已知尺寸或请求尺寸定框
  const firstDims = images.find((im) => im?.width && im?.height);
  const natural =
    firstDims?.width && firstDims?.height
      ? { w: firstDims.width, h: firstDims.height }
      : parseSize(size);
  const box = frameBox(natural?.w, natural?.h);
  const go = (delta: number) => setIndex((i) => Math.max(0, Math.min(count - 1, i + delta)));

  return (
    <div className="flex flex-col items-center gap-2" style={{ width: box.w }}>
      <div className="group/carousel relative overflow-hidden" style={{ width: box.w }}>
        <div
          className="flex transition-transform duration-300 ease-out motion-reduce:transition-none"
          style={{ transform: `translateX(-${active * box.w}px)` }}
        >
          {images.map((image, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 轮播项按位置对应第 i 张图
              key={i}
              className="shrink-0"
              style={{ width: box.w }}
              inert={i !== active}
            >
              <ImageFrame
                image={image}
                size={size}
                alt={alt}
                label={label}
                seconds={seconds}
                animateIn={animateIn}
              />
            </div>
          ))}
        </div>
        {/* 张数角标 */}
        <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-scrim px-2 py-0.5 text-2xs font-medium text-on-scrim tabular-nums">
          {active + 1}/{count}
        </span>
        {/* 左右箭头：悬停时出现，到头时隐藏 */}
        {active > 0 && (
          <button
            type="button"
            aria-label={t.prev}
            onClick={() => go(-1)}
            style={{ top: box.h / 2 }}
            className="absolute left-2 grid size-7 -translate-y-1/2 place-items-center rounded-full bg-scrim text-on-scrim opacity-0 outline-none transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-on-scrim group-hover/carousel:opacity-100"
          >
            <Icon name="chevron-left" size="sm" />
          </button>
        )}
        {active < count - 1 && (
          <button
            type="button"
            aria-label={t.next}
            onClick={() => go(1)}
            style={{ top: box.h / 2 }}
            className="absolute right-2 grid size-7 -translate-y-1/2 place-items-center rounded-full bg-scrim text-on-scrim opacity-0 outline-none transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-on-scrim group-hover/carousel:opacity-100"
          >
            <Icon name="chevron-right" size="sm" />
          </button>
        )}
      </div>
      {/* 底部圆点 */}
      <div className="flex items-center justify-center gap-1.5">
        {Array.from({ length: count }, (_, i) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: 圆点按位置对应第 i 张图
            key={i}
            type="button"
            aria-label={t.goTo.replace("{n}", String(i + 1))}
            aria-current={i === active || undefined}
            onClick={() => setIndex(i)}
            className={cn(
              "size-1.5 rounded-full outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/40",
              i === active ? "bg-fg" : "bg-track-strong hover:bg-muted",
            )}
          />
        ))}
      </div>
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
  const seconds = useElapsed(generating);
  const size = details?.size ?? (typeof args?.size === "string" ? args.size : undefined);

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
        {count > 1 ? (
          <ImageCarousel
            images={Array.from({ length: count }, (_, i) => doneImages[i])}
            count={count}
            size={size}
            alt={alt}
            label={editing ? t.editing : t.generating}
            seconds={seconds}
            animateIn={animateIn}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <ImageFrame
              image={doneImages[0]}
              size={size}
              alt={alt}
              label={editing ? t.editing : t.generating}
              seconds={seconds}
              animateIn={animateIn}
            />
          </div>
        )}
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
