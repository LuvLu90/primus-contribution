"use client";

import { type ReactNode, useId, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/glass-tabs";
import { strings } from "@/lib/strings";
import { McpSettings } from "./mcp-settings";
import { SkillsSettings } from "./skills-settings";

// 设置·能力中心（ADR 0017）：技能与 MCP 两个页签。不提供市场，只管理本机已有的与用户指定来源的能力。

const t = strings.settings.capabilities;
type Tab = keyof typeof t.tabs;

export function CapabilitiesSettings() {
  const [tab, setTab] = useState<Tab>("skills");
  // 访问过的页签保持挂载（只是隐藏）：切走再回来，技能的暂存确认进度与 MCP 的编辑状态都还在
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set(["skills"]));
  const labelId = useId();
  const select = (v: Tab) => {
    setTab(v);
    setVisited((prev) => (prev.has(v) ? prev : new Set([...prev, v])));
  };
  const panels: Record<Tab, () => ReactNode> = {
    skills: () => <SkillsSettings />,
    mcp: () => <McpSettings />,
  };
  return (
    <div className="flex flex-col gap-6">
      <span id={labelId} className="sr-only">
        {t.tabsLabel}
      </span>
      <Tabs className="gap-6" value={tab} onValueChange={(v) => select(v as Tab)}>
        <TabsList aria-labelledby={labelId}>
          {(Object.keys(t.tabs) as Tab[]).map((k) => (
            <TabsTrigger key={k} value={k}>
              {t.tabs[k]}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* 页签内容用 tabpanel（与页签互相关联）；访问过的强制挂载、只隐藏，没访问过的不挂载（MCP 第一次打开才读取） */}
        {(Object.keys(t.tabs) as Tab[])
          .filter((k) => visited.has(k))
          .map((k) => (
            <TabsContent key={k} value={k} forceMount hidden={tab !== k}>
              {panels[k]()}
            </TabsContent>
          ))}
      </Tabs>
    </div>
  );
}
