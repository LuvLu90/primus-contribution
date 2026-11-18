"use client";

// 图片大图预览：点开附件或已发送的图片时铺在窗口中央，点空白处、按 Esc 或右上角关闭。
// 粘贴、拖入的内存图片和消息里的 base64 图片没有路径，进不了右栏预览，只能在这里看。
// 对话内生成的图片（ADR 0018）另在右上角关闭按钮左边放“保存”“复制”等操作（actions）。
import { Dialog as DialogPrimitive } from "radix-ui";
import { type ReactNode, useEffect, useRef } from "react";
import { Icon } from "@/components/icons";
import { strings } from "@/lib/strings";

const t = strings.chat.attachments;

export function ImageLightbox({
  src,
  alt,
  onClose,
  actions,
}: {
  /** 图片地址；null 时关闭 */
  src: string | null;
  alt: string;
  onClose: () => void;
  /** 右上角关闭按钮左边的额外操作（用 LightboxAction） */
  actions?: ReactNode;
}) {
  // 打开控件不是 Dialog.Trigger：记下打开前的焦点，关闭后还给它（键盘打开、Esc 关闭后焦点不丢）
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (src !== null && !opener.current && document.activeElement instanceof HTMLElement)
      opener.current = document.activeElement;
  }, [src]);
  return (
    <DialogPrimitive.Root open={src !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="glass-fade fixed inset-0 z-50 bg-scrim backdrop-blur-[8px]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            opener.current?.focus();
            opener.current = null;
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
          className="glass-pop fixed inset-0 z-50 grid place-items-center overflow-hidden p-10 outline-none [--glass-origin:center]"
        >
          <DialogPrimitive.Title className="sr-only">{alt || t.imagePreview}</DialogPrimitive.Title>
          {src && (
            // biome-ignore lint/performance/noImgElement: 静态导出，图片是内存里的 data / blob URL 或本地图片
            <img
              src={src}
              alt={alt}
              draggable={false}
              // 网格行高是 auto，max-h-full 不生效（大图按原尺寸撑出窗口）：直接按视口减去四周 p-10 限制
              className="max-h-[calc(100dvh-5rem)] max-w-[calc(100vw-5rem)] rounded-xl object-contain"
            />
          )}
          <div className="absolute top-4 right-4 flex items-center gap-2">
            {actions}
            <DialogPrimitive.Close aria-label={t.closePreview} className={lightboxButton}>
              <Icon name="x" size="sm" />
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** 大图右上角的圆形按钮样式（关闭按钮与 actions 共用） */
export const lightboxButton =
  "grid size-8 place-items-center rounded-full bg-scrim text-on-scrim outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-on-scrim disabled:opacity-60";
