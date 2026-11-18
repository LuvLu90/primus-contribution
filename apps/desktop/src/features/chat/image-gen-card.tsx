"use client";

// 对话内生成的图片（ADR 0018）：模型调用 generate_image 后，在这一轮的回复里显示图片卡片。
// 生成中显示与目标尺寸同比例的占位（约 20–60 秒）；完成后显示图片，点开大图，悬停或在大图里可以保存、复制；
// 失败或停止时只显示一行说明（原因由模型在回复里解释）。
// 图片在数据目录里（约束 C2），经 attachment_image 在内存里读成 data URL 显示；保存走薄壳的 image_save（系统“另存为”）。

import type { ImageGenDetails, ImageGenImage } from "@primus/protocol";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { Tooltip } from "@/components/ui/tooltip";
import { getPlatform } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { ImageLightbox, lightboxButton } from "./attachments/image-lightbox";

const t = strings.chat.imagegen;

/** 读图时的最长边：生成的图片最长 1536，读回来基本是原图 */
export const DISPLAY_EDGE = 2048;

/** 状态提示的持续时间 */
const NOTICE_MS = 2000;

/** 尺寸参数 → 占位比例 */
export function aspectOf(size: unknown): string {
  if (size === "1536x1024") return "aspect-[3/2]";
  if (size === "1024x1536") return "aspect-[2/3]";
  return "aspect-square";
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

type Notice = { kind: "ok" | "error"; action: "save" | "copy"; text: string } | null;

/** 保存与复制：两处入口（卡片悬停、大图）共用一份状态 */
function useImageActions(path: string, src: string | null) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice]);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const platform = await getPlatform();
      const saved = await platform.imageSave(path);
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
    if (!src) return;
    try {
      await copyImage(src);
      setNotice({ kind: "ok", action: "copy", text: t.copied });
    } catch {
      setNotice({ kind: "error", action: "copy", text: t.copyFailed });
    }
  };
  return { busy, notice, save, copy };
}

function ImageTile({ image, alt, aspect }: { image: ImageGenImage; alt: string; aspect: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState(false);
  const { busy, notice, save, copy } = useImageActions(image.path, src);
  const done = (action: "save" | "copy") => notice?.kind === "ok" && notice.action === action;

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setMissing(false);
    getPlatform()
      .then((p) => p.attachmentImage(image.path, DISPLAY_EDGE))
      .then((img) => {
        if (alive) setSrc(`data:${img.mimeType};base64,${img.data}`);
      })
      .catch(() => {
        if (alive) setMissing(true);
      });
    return () => {
      alive = false;
    };
  }, [image.path]);

  const ratio =
    image.width && image.height ? { aspectRatio: `${image.width} / ${image.height}` } : undefined;

  if (missing)
    return (
      <div
        className={cn(
          "grid w-full place-items-center rounded-xl bg-hover/70 text-xs text-muted ring-1 ring-border/60",
          !ratio && aspect,
        )}
        style={ratio}
      >
        <span className="flex items-center gap-1.5">
          <Icon name="image" size="sm" />
          {t.missing}
        </span>
      </div>
    );

  return (
    <figure className="group/image relative m-0">
      <button
        type="button"
        aria-label={t.open}
        disabled={!src}
        onClick={() => setOpen(true)}
        className={cn(
          "block w-full overflow-hidden rounded-xl bg-hover/70 outline-none ring-1 ring-border/60 focus-visible:ring-2 focus-visible:ring-accent/40",
          !ratio && aspect,
          src ? "cursor-zoom-in" : "animate-pulse",
        )}
        style={ratio}
      >
        {src && (
          // biome-ignore lint/performance/noImgElement: 静态导出，图片是内存里的 data URL
          <img src={src} alt={alt} draggable={false} className="size-full object-cover" />
        )}
        {!src && <span className="sr-only">{t.loading}</span>}
      </button>
      {src && (
        <div className="absolute top-2 right-2 flex gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/image:opacity-100 [@media(hover:none)]:opacity-100">
          <Tooltip content={t.copy}>
            <button type="button" aria-label={t.copy} onClick={copy} className={lightboxButton}>
              <Icon name={done("copy") ? "check" : "copy"} size="sm" />
            </button>
          </Tooltip>
          <Tooltip content={t.save}>
            <button
              type="button"
              aria-label={busy ? t.saving : t.save}
              disabled={busy}
              onClick={save}
              className={lightboxButton}
            >
              <Icon name={busy ? "loader" : done("save") ? "check" : "download"} size="sm" />
            </button>
          </Tooltip>
        </div>
      )}
      <p
        aria-live="polite"
        className={cn(
          "mt-1 min-h-4 text-2xs",
          notice?.kind === "error" ? "text-danger" : "text-muted",
        )}
      >
        {notice?.text ?? ""}
      </p>
      <ImageLightbox
        src={open ? src : null}
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
            <button type="button" aria-label={t.copy} onClick={copy} className={lightboxButton}>
              <Icon name={done("copy") ? "check" : "copy"} size="sm" />
            </button>
            <button
              type="button"
              aria-label={busy ? t.saving : t.save}
              disabled={busy}
              onClick={save}
              className={lightboxButton}
            >
              <Icon name={busy ? "loader" : done("save") ? "check" : "download"} size="sm" />
            </button>
          </>
        }
      />
    </figure>
  );
}

export function ImageGenCard({
  args,
  details,
  running,
}: {
  /** 工具调用参数（生成中按 size 显示占位比例，按 images 区分改图） */
  args: Record<string, unknown> | undefined;
  /** 工具结果的 details；生成中没有 */
  details: ImageGenDetails | undefined;
  /** 这次调用仍在进行 */
  running: boolean;
}) {
  const size = details?.size ?? args?.size;
  const aspect = aspectOf(size);
  const prompt = details?.prompt ?? (typeof args?.prompt === "string" ? args.prompt : "");
  const alt = t.alt.replace("{prompt}", prompt);
  const count = Math.min(4, Math.max(1, Number(args?.n) || 1));
  const editing = Array.isArray(args?.images) && args.images.length > 0;

  if (details?.status === "done" && details.images.length > 0)
    return (
      <section
        aria-label={t.card}
        className={cn(
          "step-in grid max-w-[640px] gap-2",
          details.images.length > 1 ? "grid-cols-2" : "max-w-[400px] grid-cols-1",
        )}
      >
        {details.images.map((image) => (
          <ImageTile key={image.path} image={image} alt={alt} aspect={aspect} />
        ))}
      </section>
    );

  if (running && !details)
    return (
      <section
        aria-label={t.card}
        aria-busy="true"
        className={cn("grid max-w-[640px] gap-2", count > 1 ? "grid-cols-2" : "max-w-[400px]")}
      >
        {Array.from({ length: count }, (_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 占位块没有其他标识，数量不变
            key={i}
            className={cn(
              "grid w-full animate-pulse place-items-center rounded-xl bg-hover/70 ring-1 ring-border/60",
              aspect,
            )}
          >
            {i === 0 && (
              <span className="flex flex-col items-center gap-1 text-xs text-muted">
                <span className="flex items-center gap-1.5 text-pulse">
                  <Icon name="image" size="sm" />
                  {editing ? t.editing : t.generating}
                </span>
                <span className="text-2xs">{t.generatingHint}</span>
              </span>
            )}
          </div>
        ))}
      </section>
    );

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
