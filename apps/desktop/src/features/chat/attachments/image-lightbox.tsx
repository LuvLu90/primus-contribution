"use client";

// 图片大图预览：点开附件或已发送的图片时铺在窗口中央，点空白处、按 Esc 或右上角关闭。
// 粘贴、拖入的内存图片和消息里的 base64 图片没有路径，进不了右栏预览，只能在这里看。
import { Dialog as DialogPrimitive } from "radix-ui";
import { Icon } from "@/components/icons";
import { strings } from "@/lib/strings";

const t = strings.chat.attachments;

export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  /** 图片地址；null 时关闭 */
  src: string | null;
  alt: string;
  onClose: () => void;
}) {
  return (
    <DialogPrimitive.Root open={src !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="glass-fade fixed inset-0 z-50 bg-black/60 backdrop-blur-[8px]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
          className="glass-pop fixed inset-0 z-50 grid place-items-center p-10 outline-none [--glass-origin:center]"
        >
          <DialogPrimitive.Title className="sr-only">{alt || t.imagePreview}</DialogPrimitive.Title>
          {src && (
            // biome-ignore lint/performance/noImgElement: 静态导出，图片是内存里的 data / blob URL 或本地图片
            <img
              src={src}
              alt={alt}
              draggable={false}
              className="max-h-full max-w-full rounded-xl object-contain shadow-[0_20px_60px_-12px_rgb(0_0_0/0.5)]"
            />
          )}
          <DialogPrimitive.Close
            aria-label={t.closePreview}
            className="absolute top-4 right-4 grid size-8 place-items-center rounded-full bg-black/40 text-white outline-none hover:bg-black/55 focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <Icon name="x" size="sm" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
