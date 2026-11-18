"use client";

// 时间线里的一条用户消息：附件标签 + 正文气泡，下方右对齐的操作行（复制正文）。
// 操作行悬停或键盘焦点进入时显示，触屏常显；与助手回复的操作行同一套按钮与显隐规则。
import { type ImageContent, splitFileTags } from "@primus/protocol";
import { memo, useMemo } from "react";
import { Icon } from "@/components/icons";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { SentFiles, SentImages } from "./attachments/sent-files";
import { parseCapabilities } from "./composer-capabilities";
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
  const { message: raw, files } = useMemo(
    () => splitFileTags(text, { imageHints: images.length > 0 }),
    [text, images.length],
  );
  // 开头的能力说明（图片生成、技能、MCP）不显示原文，改成气泡上方的标签
  const caps = useMemo(() => parseCapabilities(raw), [raw]);
  const message = caps.body;
  return (
    <article
      aria-label={t.you}
      data-msg-index={index}
      className="msg-in group/user flex max-w-[80%] scroll-mt-6 flex-col items-end gap-1.5 self-end"
    >
      <SentImages images={images} />
      <SentFiles files={files} />
      <SentCapabilities image={caps.image} skills={caps.skills} mcp={caps.mcp} />
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

/** 随消息发送的能力标签（与输入框上方的标签同款，只读） */
function SentCapabilities({
  image,
  skills,
  mcp,
}: {
  image: boolean;
  skills: string[];
  mcp: string[];
}) {
  const s = t.capabilities;
  const tags = [
    ...(image ? [{ key: "image", icon: "image" as const, label: s.image }] : []),
    ...skills.map((n) => ({ key: `skill:${n}`, icon: "bulb" as const, label: `/${n}` })),
    ...mcp.map((n) => ({ key: `mcp:${n}`, icon: "server" as const, label: `/${n}` })),
  ];
  if (tags.length === 0) return null;
  return (
    <ul aria-label={s.sentLabel} className="flex flex-wrap justify-end gap-1.5">
      {tags.map((c) => (
        <li
          key={c.key}
          className="flex h-7 max-w-56 items-center gap-1.5 rounded-[9px] bg-accent/10 px-2 text-xs text-accent ring-1 ring-accent/20"
        >
          <Icon name={c.icon} size="sm" className="shrink-0" />
          <span className="min-w-0 truncate">{c.label}</span>
        </li>
      ))}
    </ul>
  );
}
