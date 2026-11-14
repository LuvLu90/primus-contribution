"use client";

// 全局的选中复制处理（见 lib/clean-copy.ts）：只复制选中的纯文本，不带格式、不加任何内容，文件引用为完整路径。
import { useEffect } from "react";
import { handleCopy } from "@/lib/clean-copy";

export function CleanCopy() {
  useEffect(() => {
    document.addEventListener("copy", handleCopy);
    return () => document.removeEventListener("copy", handleCopy);
  }, []);
  return null;
}
