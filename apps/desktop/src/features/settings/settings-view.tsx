"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { GlassPanel } from "@/components/layout/glass-panel";
import {
  centerSeamStyle,
  OUTER_RADIUS,
  SEAM_BLEED,
  sidePanelSeamStyle,
  sideShellClass,
} from "@/components/layout/seam";
import { WindowTitleBar } from "@/components/layout/window-controls";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/glass-tabs";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { type ThemeMode, useAppearanceStore } from "@/stores/appearance-store";
import { AboutSettings } from "./about-settings";
import { AccountSettings } from "./account-models";
import { AdvancedSettings } from "./advanced-settings";
import { AgentSettings } from "./agent-settings";
import { ArchivedSettings } from "./archived-settings";
import { CapabilitySettings } from "./capability-settings";
import { Row, Section } from "./settings-section";
import { UsageSettings } from "./usage-settings";

const t = strings.settings;
export type SettingsGroup = keyof typeof t.groups;
const GROUPS = Object.keys(t.groups) as SettingsGroup[];
const GROUP_ICONS = {
  general: "settings",
  account: "user",
  usage: "chart",
  agent: "thinking",
  archived: "archive",
  capabilities: "puzzle",
  advanced: "tuning",
  about: "file-text",
} satisfies Record<SettingsGroup, IconName>;

/** 启动与通知开关的默认值（第 18 章），settings.toml 接入前只读 */
const PENDING_DEFAULTS = { tray: false, notify: true } as const;

function GeneralSettings() {
  const theme = useAppearanceStore((s) => s.theme);
  const setTheme = useAppearanceStore((s) => s.setTheme);
  const glassTint = useAppearanceStore((s) => s.glassTint);
  const setGlassTint = useAppearanceStore((s) => s.setGlassTint);
  // 启动与通知开关要写入 settings.toml（薄壳 settings_get/settings_set），接入前显示默认值并禁用
  const pending = PENDING_DEFAULTS;
  const themeLabel = useId();

  return (
    <div className="flex flex-col gap-6">
      <Section title={t.appearance}>
        <Row label={t.theme} labelId={themeLabel}>
          <Tabs value={theme} onValueChange={(v) => setTheme(v as ThemeMode)}>
            <TabsList aria-labelledby={themeLabel}>
              {(["system", "light", "dark"] as const).map((m) => (
                <TabsTrigger key={m} value={m}>
                  {t.themes[m]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </Row>
        <Row label={t.glass}>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span>{t.glassClear}</span>
            <Slider
              ariaLabel={t.glass}
              min={0}
              max={100}
              value={Math.round(glassTint * 100)}
              onValueChange={(v) => setGlassTint(v / 100)}
            />
            <span>{t.glassTinted}</span>
          </div>
        </Row>
        <Row label={t.language}>
          <span className="text-sm text-muted">{t.languageValue}</span>
        </Row>
      </Section>
      <Section title={t.startup}>
        <Row label={t.minimizeToTray}>
          <Switch ariaLabel={t.minimizeToTray} checked={pending.tray} disabled />
        </Row>
      </Section>
      <Section title={t.notifications}>
        <Row label={t.notifyEnabled}>
          <Switch ariaLabel={t.notifyEnabled} checked={pending.notify} disabled />
        </Row>
      </Section>
    </div>
  );
}

/** 地址中的 `?group=<分组>`（如侧栏菜单的“用量”打开 `/settings/?group=usage`）；无效值返回 null */
export function groupFromSearch(search: string): SettingsGroup | null {
  const g = new URLSearchParams(search).get("group");
  if (g === "models") return "agent";
  if (g === "update") return "about";
  return g && (GROUPS as string[]).includes(g) ? (g as SettingsGroup) : null;
}

export function SettingsView() {
  const router = useRouter();
  const [advancedEnabled, setAdvancedEnabled] = useState(false);
  const [group, setGroup] = useState<SettingsGroup>("general");
  // 静态导出没有服务端：在客户端读查询参数选中分组（不用 useSearchParams，免去 Suspense 边界）
  useEffect(() => {
    const g = groupFromSearch(window.location.search);
    if (g) setGroup(g);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden px-2 pb-2 text-fg">
      {/* 主窗口没有系统标题栏：顶部细条可拖动窗口，窗口按钮贴在右上角（浏览器预览中只留上边距） */}
      <WindowTitleBar className="-mx-2 mb-1" />
      <div className="flex min-h-0 flex-1 flex-col gap-2 sm:flex-row sm:gap-0">
        <div
          className={cn(sideShellClass, "min-w-0 max-sm:[--nr:0px]! max-sm:rounded-2xl! sm:w-52")}
          style={sidePanelSeamStyle("left")}
        >
          <GlassPanel
            className="w-full shrink-0 shadow-none sm:w-[calc(13rem+var(--settings-seam-bleed))] sm:rounded-r-none! sm:pr-(--settings-seam-bleed)"
            style={{ "--settings-seam-bleed": `${SEAM_BLEED}px` } as React.CSSProperties}
          >
            <nav
              aria-label={t.title}
              className="flex h-full min-h-0 flex-col gap-2 p-3 sm:gap-5 sm:pt-5"
            >
              <div className="flex items-center gap-2 px-1">
                <button
                  type="button"
                  aria-label={t.back}
                  onClick={() => router.push("/")}
                  className="inline-flex size-8 items-center justify-center rounded-lg border border-border bg-surface text-muted hover:bg-bubble hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <Icon name="chevron-left" size="lg" />
                </button>
                <h1 className="text-lg font-semibold tracking-tight">{t.title}</h1>
              </div>
              <ul className="scroll-thin flex min-h-0 gap-1 overflow-x-auto sm:flex-1 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto">
                {GROUPS.map((g) => (
                  <li key={g}>
                    <button
                      type="button"
                      aria-current={g === group ? "page" : undefined}
                      onClick={() => setGroup(g)}
                      className={cn(
                        "relative flex min-h-9 w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-3 text-left text-sm text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                        g === group &&
                          "bg-surface font-semibold text-fg ring-1 ring-inset ring-border hover:bg-surface before:absolute before:inset-y-2.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent",
                      )}
                    >
                      <Icon name={GROUP_ICONS[g]} size="md" />
                      {t.groups[g]}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          </GlassPanel>
        </div>
        <main
          aria-label={t.groups[group]}
          className="seam-mask relative isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-sm:[--nl:0px]! max-sm:rounded-2xl!"
          style={centerSeamStyle(true, false)}
        >
          {/* 与导航同款液态玻璃；接缝一侧外扩 SEAM_BLEED 由外层裁掉，接缝不露高光线 */}
          <GlassPanel
            aria-hidden
            radius={OUTER_RADIUS}
            className="-z-10 pointer-events-none absolute inset-y-0 shadow-none"
            style={{ position: "absolute", left: -SEAM_BLEED, right: 0 }}
          />
          <header className="scroll-thin shrink-0 overflow-y-auto border-b border-border bg-surface [scrollbar-gutter:stable]">
            <div className="mx-auto flex w-full min-w-0 max-w-4xl items-center gap-3 px-4 py-4 sm:px-7 sm:py-5">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bubble text-accent">
                <Icon name={GROUP_ICONS[group]} size="lg" />
              </span>
              <h2
                className={cn(
                  "text-2xl tracking-tight",
                  group === "agent" ? "font-[720]" : "font-semibold",
                )}
              >
                {t.groups[group]}
              </h2>
              {group === "advanced" && (
                <Switch
                  className="ml-auto"
                  ariaLabel={strings.settings.ssh.enable}
                  checked={advancedEnabled}
                  onCheckedChange={setAdvancedEnabled}
                />
              )}
            </div>
          </header>
          <div
            key={group}
            className="scroll-thin min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
          >
            <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-6 px-4 py-5 sm:px-7 sm:py-7">
              {group === "general" ? (
                <GeneralSettings />
              ) : group === "account" ? (
                <AccountSettings />
              ) : group === "usage" ? (
                <UsageSettings />
              ) : group === "agent" ? (
                <AgentSettings />
              ) : group === "archived" ? (
                <ArchivedSettings />
              ) : group === "capabilities" ? (
                <CapabilitySettings />
              ) : group === "advanced" ? (
                <AdvancedSettings enabled={advancedEnabled} />
              ) : (
                <AboutSettings />
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
