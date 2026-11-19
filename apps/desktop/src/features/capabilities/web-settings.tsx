"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Row, Section } from "@/features/settings/settings-section";
import { getPlatform } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { buttonClass } from "./ui";

// 设置·能力中心·联网（ADR 0020）：是否允许 AI 联网搜索（web_search）与读取网页（web_fetch），默认开。
// 薄壳写 users/<SID>/app/web.json，Core 的 primus-web 在每轮对话开始前读取，不需要重启内核。

const t = strings.settings.capabilities.web;

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : typeof e === "string" && e ? e : fallback;
}

export function WebSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const s = await (await getPlatform()).webSettingsGet();
      if (seq !== seqRef.current) return;
      setEnabled(s.enabled);
    } catch (e) {
      if (seq !== seqRef.current) return;
      // 读取失败时状态未知（Core 可能仍沿用上次缓存的开启状态），不要显示成“已关闭”
      setEnabled(null);
      setError(errorText(e, t.loadFailed));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      seqRef.current += 1;
    };
  }, [load]);

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

  const unknown = enabled === null && !loading && error !== null;

  return (
    <Section title={t.title}>
      <Row label={t.enabled} hint={error ?? t.hint}>
        {unknown ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void load()}
              className={buttonClass}
            >
              {t.retry}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void change(false)}
              className={buttonClass}
            >
              {t.disable}
            </button>
          </div>
        ) : (
          <Switch
            ariaLabel={t.enabled}
            checked={enabled ?? true}
            disabled={enabled === null || loading || saving}
            onCheckedChange={(v) => void change(v)}
          />
        )}
      </Row>
    </Section>
  );
}
