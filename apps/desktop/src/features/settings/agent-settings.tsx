"use client";

import { useEffect, useState } from "react";
import { getPlatform } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { useAppStore } from "@/stores/app-store";
import { ModelSettings } from "./account-models";
import { ProviderSettings } from "./providers-settings";
import { Row, Section } from "./settings-section";

const t = strings.settings.agent;
const permissions = strings.chat.permissions;
const fieldClass =
  "max-w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm disabled:text-muted";

function UnavailableSelect({ label, options }: { label: string; options: readonly string[] }) {
  return (
    <select aria-label={label} className={fieldClass} defaultValue="" disabled>
      <option value="">{t.unavailable}</option>
      {options.map((option) => (
        <option key={option}>{option}</option>
      ))}
    </select>
  );
}

export function AgentSettings() {
  const permissionMode = useAppStore((state) => state.permissionMode);
  const setPermissionMode = useAppStore((state) => state.setPermissionMode);
  const [voiceAvailable, setVoiceAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    getPlatform()
      .then((platform) => platform.speechAvailable())
      .then((available) => {
        if (active) setVoiceAvailable(available);
      })
      .catch(() => {
        if (active) setVoiceAvailable(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <ProviderSettings />
      <ModelSettings />
      <Section title={t.preferenceTitle}>
        <Row label={t.replyStyle}>
          <UnavailableSelect label={t.replyStyle} options={t.replyStyles} />
        </Row>
        <Row label={t.replyLanguage}>
          <UnavailableSelect label={t.replyLanguage} options={t.replyLanguages} />
        </Row>
      </Section>
      <Section title={t.executionTitle}>
        <Row label={t.execution} hint={permissions[permissionMode].hint}>
          <select
            aria-label={t.execution}
            className={fieldClass}
            value={permissionMode}
            onChange={(event) => {
              const mode = event.currentTarget.value;
              if (mode === "ask" || mode === "edit") setPermissionMode(mode);
            }}
          >
            <option value="ask">{t.confirmFirst}</option>
            <option value="edit">{t.automaticExecution}</option>
            {permissionMode === "full" && (
              <option value="full" disabled>
                {permissions.full.label}
              </option>
            )}
          </select>
        </Row>
        <Row label={t.plan} hint={t.planHint}>
          <UnavailableSelect label={t.plan} options={t.planOptions} />
        </Row>
        <Row label={t.context} hint={t.contextHint}>
          <span className="shrink-0 text-sm text-muted">{t.inChat}</span>
        </Row>
        <Row label={t.voice} hint={t.voiceHint}>
          <span role="status" className="shrink-0 text-sm text-muted">
            {voiceAvailable === null ? t.checking : voiceAvailable ? t.available : t.unavailable}
          </span>
        </Row>
      </Section>
    </>
  );
}
