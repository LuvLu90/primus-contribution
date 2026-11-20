import type { AgentMessage } from "@primus/protocol";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionsStore } from "@/features/sessions/sessions-store";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  type Platform,
  setPlatformForTesting,
} from "@/lib/platform";
import { createMockPlatform } from "@/lib/platform/mock";
import { strings } from "@/lib/strings";
import { initialSessionState, type SessionState } from "@/stores/session-store";
import * as chime from "./chime";
import { resetNotificationSettingsForTest } from "./notification-settings-store";
import { shouldAlert, useAttentionAlerts } from "./use-attention-alerts";

const t = strings.notifications;
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 });
const done = {
  role: "assistant",
  content: [{ type: "text", text: "改好了" }],
  stopReason: "stop",
} as unknown as AgentMessage;

function setup(settings: Partial<NotificationSettings> = {}) {
  const platform: Platform = {
    ...createMockPlatform(),
    notificationSettingsGet: async () => ({ ...DEFAULT_NOTIFICATION_SETTINGS, ...settings }),
  };
  const show = vi.spyOn(platform, "notificationShow").mockResolvedValue();
  setPlatformForTesting(platform);
  return show;
}

describe("shouldAlert", () => {
  const s = DEFAULT_NOTIFICATION_SETTINGS;
  it("完成：从不 / 在后台时 / 始终", () => {
    expect(shouldAlert("done", { ...s, turnComplete: "never" }, false)).toBe(false);
    expect(shouldAlert("done", s, false)).toBe(true);
    expect(shouldAlert("done", s, true)).toBe(false);
    expect(shouldAlert("error", { ...s, turnComplete: "always" }, true)).toBe(true);
  });
  it("需要处理：开关打开且没在看", () => {
    expect(shouldAlert("input", s, false)).toBe(true);
    expect(shouldAlert("input", s, true)).toBe(false);
    expect(shouldAlert("input", { ...s, needsInput: false }, false)).toBe(false);
  });
});

describe("useAttentionAlerts", () => {
  let play: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetNotificationSettingsForTest();
    play = vi.spyOn(chime, "playChime").mockResolvedValue(true);
  });
  afterEach(() => {
    setPlatformForTesting(undefined);
    vi.restoreAllMocks();
  });

  const run = (tabId?: string) => {
    const running: SessionState = {
      ...initialSessionState,
      running: true,
      messages: [user("修登录")],
    };
    const hook = renderHook(({ s }) => useAttentionAlerts(s, tabId), {
      initialProps: { s: running },
    });
    hook.rerender({ s: { ...running, running: false, messages: [user("修登录"), done] } });
    return hook;
  };

  it("窗口不在前台时完成：发通知并响提示音", async () => {
    const show = setup();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    run();
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith({
        title: `${t.done} · 修登录`,
        body: "改好了",
        tag: "",
        attention: false,
      }),
    );
    expect(play).toHaveBeenCalledWith("done");
  });

  it("正在看这个会话时不提醒；在看别的会话时提醒，并带上标签以便点开切回", async () => {
    const show = setup();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const active = useSessionsStore.getState().activeTabId;
    run(active);
    run("tab-other");
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(show.mock.calls[0]?.[0].tag).toBe("tab-other");
  });

  it("关闭提示音时只发通知", async () => {
    const show = setup({ sound: false });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    run();
    await waitFor(() => expect(show).toHaveBeenCalled());
    expect(play).not.toHaveBeenCalled();
  });
});
