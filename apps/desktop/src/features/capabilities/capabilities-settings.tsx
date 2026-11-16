"use client";

import { useId, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/glass-tabs";
import { strings } from "@/lib/strings";
import { McpSettings } from "./mcp-settings";
import { SkillsSettings } from "./skills-settings";

// 设置·能力中心（ADR 0017）：技能与 MCP 两个页签。不提供市场，只管理本机已有的与用户指定来源的能力。

const t = strings.settings.capabilities;
type Tab = keyof typeof t.tabs;

export function CapabilitiesSettings() {
  const [tab, setTab] = useState<Tab>("skills");
  const labelId = useId();
  return (
    <div className="flex flex-col gap-6">
      <span id={labelId} className="sr-only">
        {t.tabsLabel}
      </span>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList aria-labelledby={labelId}>
          {(Object.keys(t.tabs) as Tab[]).map((k) => (
            <TabsTrigger key={k} value={k}>
              {t.tabs[k]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {tab === "skills" ? <SkillsSettings /> : <McpSettings />}
    </div>
  );
}
