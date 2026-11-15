"use client";

// 时间线里的一条用户消息：附件标签 + 正文气泡，下方右对齐的操作行（复制正文）。
// 操作行悬停或键盘焦点进入时显示，触屏常显；与助手回复的操作行同一套按钮与显隐规则。
import { type ImageContent, splitFileTags } from "@primus/protocol";
import { memo, useMemo } from "react";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { SentFiles, SentImages } from "./attachments/sent-files";
import { CopyButton, revealOnUserHover } from "./copy-button";

const t = strings.chat;
const NO_IMAGES: readonly ImageContent[] = [];

export const UserBubble = memo(function UserBubble({
  text,
  index,
  images = NO_IMAGES,
}: {
  text: string;
  index: number;
  /** 随消息发给模型的图片（用户消息里的 image 块） */
  images?: readonly ImageContent[];
}) {
  // 末尾的 `<file>` 引用显示成文件标签（内联的文件内容不铺在气泡里）；图片另显示成缩略图。
  // image 块不带路径，对不上是哪个文件，所以文件标签全部保留
  const { message, files } = useMemo(
    () => splitFileTags(text, { imageHints: images.length > 0 }),
    [text, images.length],
  );
  return (
    <article
      aria-label={t.you}
      data-msg-index={index}
      className="msg-in group/user flex max-w-[80%] scroll-mt-6 flex-col items-end gap-1.5 self-end"
    >
      <SentImages images={images} />
      <SentFiles files={files} />
      {message && (
        <p
          data-copy-pre=""
          className="whitespace-pre-wrap rounded-[18px] rounded-br-md bg-bubble px-3.5 py-2 text-base text-fg"
        >
          {message}
        </p>
      )}
      {/* 操作行：只复制正文（不含附件的 `<file>` 引用），与助手回复的复制按钮一致 */}
      {message && (
        <div className={cn("-mt-1 -mr-1.5 flex", revealOnUserHover)}>
          <CopyButton text={message} />
        </div>
      )}
    </article>
  );
});
