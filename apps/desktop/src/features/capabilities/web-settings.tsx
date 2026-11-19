"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Row, Section } from "@/features/settings/settings-section";
import { getPlatform } from "@/lib/platform";
import { strings } from "@/lib/strings";

// 设置·能力中心·联网（ADR 0020）：是否允许 AI 联网搜索（web_search）与读取网页（web_fetch），默认开。
// 薄壳写 users/<SID>/app/web.json，Core 的 primus-web 在每轮对话开始前读取，不需要重启内核。

const t = strings.settings.capabilities.web;

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : typeof e === "string" && e ? e : fallback;
}

export function WebSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getPlatform()
      .then((p) => p.webSettingsGet())
      .then(
        (s) => alive && setEnabled(s.enabled),
        (e) => {
          if (!alive) return;
          setEnabled(true);
          setError(errorText(e, t.loadFailed));
        },
      );
    return () => {
      alive = false;
    };
  }, []);

  const change = async (next: boolean) => {
    const prev = enabled;
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      const s = await (await getPlatform()).webSettingsSet(next);
      setEnabled(s.enabled);
    } catch (e) {
      setEnabled(prev);
      setError(errorText(e, t.saveFailed));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title={t.title}>
      <Row label={t.enabled} hint={error ?? t.hint}>
        <Switch
          ariaLabel={t.enabled}
          checked={enabled ?? true}
          disabled={enabled === null || saving}
          onCheckedChange={(v) => void change(v)}
        />
      </Row>
    </Section>
  );
}
