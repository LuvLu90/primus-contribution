"use client";

// 时间线里用户消息的附件：消息末尾的 `<file>` 引用（Core 原生格式）解析成文件标签，
// 不把路径与内联的文件内容原样铺在气泡里。悬停看完整路径；内联了内容的文本文件注明“已附上内容”。
// 文件标签点开在右栏预览；图片缩略图点开大图预览。
import type { FileTag, ImageContent } from "@primus/protocol";
import { useContext, useState } from "react";
import { FileIcon } from "@/components/icons";
import { Tooltip } from "@/components/ui/tooltip";
import { showPreview } from "@/features/files/preview-store";
import { strings } from "@/lib/strings";
import { fileIconForName, resolveFileRefPath } from "../file-ref";
import { FileRefBase } from "../file-ref-actions";
import { ImageLightbox } from "./image-lightbox";

const t = strings.chat.attachments;

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function SentFiles({ files }: { files: FileTag[] }) {
  const base = useContext(FileRefBase);
  if (files.length === 0) return null;
  return (
    <ul aria-label={t.sent} className="flex max-w-full flex-wrap justify-end gap-1.5">
      {files.map((f, i) => {
        const name = baseName(f.path);
        const inlined = f.content !== undefined;
        return (
          <Tooltip
            // 同一路径可能出现两次（重发），按位置区分
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表只随消息整体替换，不会重排
            key={`${i}-${f.path}`}
            content={inlined ? `${f.path}\n${t.inlined}` : f.path}
          >
            <li aria-label={inlined ? `${name}（${t.inlined}）` : name} className="flex max-w-56">
              <SentFileButton name={name} path={resolveFileRefPath(f.path, base)} />
            </li>
          </Tooltip>
        );
      })}
    </ul>
  );
}

function SentFileButton({ name, path }: { name: string; path: string | null }) {
  return (
    <button
      type="button"
      aria-label={t.open.replace("{name}", name)}
      disabled={!path}
      title={path ? undefined : t.cannotPreview}
      onClick={() => path && showPreview(path)}
      className="flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-[9px] bg-tile px-2 text-xs outline-none ring-1 ring-tile-ring transition-colors enabled:hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default"
    >
      <FileIcon name={fileIconForName(name)} size="sm" />
      <span className="min-w-0 truncate">{name}</span>
    </button>
  );
}

/**
 * 随消息发给模型的图片（Core 存进用户消息的 image 块）。粘贴或拖入的图片没有路径，只有这里能显示；
 * 有路径的图片同时保留 `<file>` 标签：image 块不带路径，无法确认哪张缩略图对应哪个标签
 * （如读取失败的图片与粘贴的图片同时发送），按数量推断会把失败文件的引用藏掉
 */
export function SentImages({ images }: { images: readonly ImageContent[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (images.length === 0) return null;
  return (
    <ul aria-label={t.sentImages} className="flex max-w-full flex-wrap justify-end gap-1.5">
      {images.map((img, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 列表只随消息整体替换，不会重排
        <li key={i} className="overflow-hidden rounded-[9px] ring-1 ring-tile-ring">
          <button
            type="button"
            aria-label={t.open.replace("{name}", t.sentImage)}
            onClick={() => setOpen(`data:${img.mimeType};base64,${img.data}`)}
            className="block cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {/* biome-ignore lint/performance/noImgElement: 静态导出，图片是消息里的 base64 */}
            <img
              src={`data:${img.mimeType};base64,${img.data}`}
              alt={t.sentImage}
              draggable={false}
              className="block size-16 bg-tile object-cover"
            />
          </button>
        </li>
      ))}
      <ImageLightbox src={open} alt={t.sentImage} onClose={() => setOpen(null)} />
    </ul>
  );
}
