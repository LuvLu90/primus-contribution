"use client";

import { useEffect, useId } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/glass-tabs";
import { Switch } from "@/components/ui/switch";
import { buttonClass } from "@/features/capabilities/ui";
import { Row, Section } from "@/features/settings/settings-section";
import type { TurnCompleteNotify } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { type ChimeKind, playChime } from "./chime";
import { useNotificationSettings } from "./notification-settings-store";

// 设置·通用·通知与提示音（ADR 0023）。参照 Codex 桌面版：任务完成“从不 / 在后台时 / 始终”，
// 需要处理（确认、提问、计划审批）单独开关；另加提示音开关与试听。

const t = strings.settings.notify;
const MODES: readonly TurnCompleteNotify[] = ["never", "background", "always"];
const PREVIEWS: readonly [ChimeKind, string][] = [
  ["done", t.previewDone],
  ["input", t.previewInput],
];

export function NotificationSettingsSection() {
  const { settings, loaded, ready, error, saving, load, update } = useNotificationSettings();
  const modeLabel = useId();
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const errorText =
    error && (error === "load" ? t.loadFailed : error === "save" ? t.saveFailed : error);
  const disabled = !ready || saving;

  return (
    <Section title={strings.settings.notifications}>
      <Row label={t.turnComplete} hint={errorText ?? t.turnCompleteHint} labelId={modeLabel}>
        {loaded && !ready && (
          <button type="button" onClick={() => void load()} className={buttonClass}>
            {t.retry}
          </button>
        )}
        <Tabs
          value={settings.turnComplete}
          onValueChange={(v) => void update({ turnComplete: v as TurnCompleteNotify })}
        >
          <TabsList aria-labelledby={modeLabel}>
            {MODES.map((m) => (
              <TabsTrigger key={m} value={m} disabled={disabled}>
                {t.turnCompleteModes[m]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </Row>
      <Row label={t.needsInput} hint={t.needsInputHint}>
        <Switch
          ariaLabel={t.needsInput}
          checked={settings.needsInput}
          disabled={disabled}
          onCheckedChange={(v) => void update({ needsInput: v })}
        />
      </Row>
      <Row label={t.sound} hint={t.soundHint}>
        <div className="flex shrink-0 items-center gap-2">
          {PREVIEWS.map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              onClick={() => void playChime(kind, { force: true })}
              className={buttonClass}
            >
              {label}
            </button>
          ))}
          <Switch
            ariaLabel={t.sound}
            checked={settings.sound}
            disabled={disabled}
            onCheckedChange={(v) => void update({ sound: v })}
          />
        </div>
      </Row>
    </Section>
  );
}
