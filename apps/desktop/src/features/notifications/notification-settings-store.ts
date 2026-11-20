import { create } from "zustand";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  getPlatform,
  type NotificationSettings,
} from "@/lib/platform";

// 通知与提示音设置（ADR 0023）：全局一份，设置页修改、各会话提醒时读取。
// 薄壳保存在 users/<SID>/app/notifications.json；读取失败时按默认值提醒（不因读不到设置而静默）。

export interface NotificationSettingsState {
  settings: NotificationSettings;
  /** 已从薄壳读过（成功或失败）；之前提醒用默认值 */
  loaded: boolean;
  /**
   * 已成功读到设置。读取失败时 settings 只是默认值，不能拿它与修改合并保存（会覆盖用户没改的项），
   * 因此读到前设置页禁止修改、提供重试
   */
  ready: boolean;
  /** 最近一次读取或保存的错误 */
  error: string | null;
  saving: boolean;
  /** 读取设置；已在读取时复用同一次 */
  load: () => Promise<void>;
  /** 修改部分设置并保存；失败时回滚并记下错误 */
  update: (patch: Partial<NotificationSettings>) => Promise<void>;
}

let loading: Promise<void> | null = null;

function message(e: unknown): string | null {
  return e instanceof Error && e.message ? e.message : typeof e === "string" && e ? e : null;
}

export const useNotificationSettings = create<NotificationSettingsState>()((set, get) => ({
  settings: { ...DEFAULT_NOTIFICATION_SETTINGS },
  loaded: false,
  ready: false,
  error: null,
  saving: false,

  load: () => {
    loading ??= (async () => {
      try {
        const settings = await (await getPlatform()).notificationSettingsGet();
        set({ settings, loaded: true, ready: true, error: null });
      } catch (e) {
        set({ loaded: true, error: message(e) ?? "load" });
      } finally {
        loading = null;
      }
    })();
    return loading;
  },

  update: async (patch) => {
    if (!get().ready) return;
    const prev = get().settings;
    const next = { ...prev, ...patch };
    set({ settings: next, saving: true, error: null });
    try {
      const saved = await (await getPlatform()).notificationSettingsSet(next);
      set({ settings: saved, saving: false });
    } catch (e) {
      set({ settings: prev, saving: false, error: message(e) ?? "save" });
    }
  },
}));

/** 测试用：恢复初始状态 */
export function resetNotificationSettingsForTest(): void {
  loading = null;
  useNotificationSettings.setState({
    settings: { ...DEFAULT_NOTIFICATION_SETTINGS },
    loaded: false,
    ready: false,
    error: null,
    saving: false,
  });
}
