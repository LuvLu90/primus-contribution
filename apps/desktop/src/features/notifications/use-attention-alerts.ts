"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useSessionsStore } from "@/features/sessions/sessions-store";
import { getPlatform, type NotificationSettings } from "@/lib/platform";
import type { SessionState } from "@/stores/session-store";
import {
  type AttentionEvent,
  type AttentionKind,
  detectAttention,
  sessionLabel,
} from "./attention";
import { playChime, primeAudio } from "./chime";
import { useNotificationSettings } from "./notification-settings-store";

// 任务完成与需要用户处理时的系统通知与提示音（ADR 0023，参照 Codex 的 agent-turn-complete / approval-requested）。
// 是否提醒由前端判断（薄壳只负责弹通知、点开后把窗口拉到前台）：
//   - “在看”：窗口在前台且有焦点、主界面可见（不在设置等页面）、这个会话是当前会话；
//   - 任务完成 / 出错：按设置“从不 / 在后台时 / 始终”；
//   - 需要处理：开关打开且用户没在看这个会话时（在看时卡片就在眼前）。
// 提醒时同时播放提示音（设置可关）；需要处理的通知在窗口不在前台时还会闪烁任务栏按钮。

/** 窗口在前台、有焦点，且主界面（会话所在的页面）可见 */
export function isAppForeground(): boolean {
  if (typeof document === "undefined") return false;
  const path = window.location.pathname;
  const home = path === "/" || path === "";
  return home && document.visibilityState === "visible" && document.hasFocus();
}

export function shouldAlert(
  kind: AttentionKind,
  settings: NotificationSettings,
  viewing: boolean,
): boolean {
  if (kind === "input") return settings.needsInput && !viewing;
  if (settings.turnComplete === "always") return true;
  return settings.turnComplete === "background" && !viewing;
}

/** 通知所属会话：标签关掉后点通知，靠它重新打开会话（只记最近的若干条） */
interface NotifiedSession {
  sessionPath: string | null;
  sessionId: string | null;
  workspace: string | null;
}
const NOTIFIED_MAX = 50;
const notified = new Map<string, NotifiedSession>();

function rememberSession(tabId: string): void {
  const tab = useSessionsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  notified.delete(tabId);
  notified.set(tabId, {
    sessionPath: tab.sessionPath,
    sessionId: tab.sessionId,
    workspace: tab.workspace,
  });
  while (notified.size > NOTIFIED_MAX) {
    const oldest = notified.keys().next().value;
    if (oldest === undefined) break;
    notified.delete(oldest);
  }
}

/** 新会话的标签只有会话 ID：在会话列表的前几页里找到它的文件 */
async function findSessionPath(id: string): Promise<{ path: string; workspace: string } | null> {
  const platform = await getPlatform();
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const { items, nextCursor } = await platform.sessionList(null, cursor);
    const hit = items.find((s) => s.id === id);
    if (hit) return { path: hit.path, workspace: hit.workspace };
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return null;
}

/**
 * 点通知后切到它的会话：标签还在就切过去；标签已关闭则重新打开那个会话（标签已满打不开时，
 * 会话列表会提示）；会话还没落盘、找不到文件时只回到主界面
 */
export async function activateNotification(tag: string): Promise<void> {
  const sessions = useSessionsStore.getState();
  if (sessions.tabs.some((t) => t.id === tag)) {
    sessions.activate(tag);
    return;
  }
  const info = notified.get(tag);
  if (!info) return;
  let path = info.sessionPath;
  let workspace = info.workspace;
  if (!path && info.sessionId) {
    const found = await findSessionPath(info.sessionId).catch(() => null);
    path = found?.path ?? null;
    workspace = found?.workspace ?? workspace;
  }
  if (!path) return;
  useSessionsStore
    .getState()
    .openSession({ path, id: info.sessionId ?? "", workspace: workspace ?? "" });
}

/** 测试用 */
export function resetNotifiedSessionsForTest(): void {
  notified.clear();
}

async function alert(event: AttentionEvent, state: SessionState, tabId: string | undefined) {
  const store = useNotificationSettings.getState();
  if (!store.loaded) await store.load();
  const { settings } = useNotificationSettings.getState();
  const active = useSessionsStore.getState().activeTabId;
  const viewing = isAppForeground() && (tabId === undefined || tabId === active);
  if (!shouldAlert(event.kind, settings, viewing)) return;
  if (settings.sound) void playChime(event.kind);
  if (tabId) rememberSession(tabId);
  try {
    await (await getPlatform()).notificationShow({
      title: `${event.headline} · ${sessionLabel(state.messages)}`,
      body: event.detail,
      tag: tabId ?? "",
      attention: event.kind === "input",
    });
  } catch {
    // 系统通知失败（通知被系统关闭、开发模式没有注册应用 ID 等）不影响对话；提示音已经响过
  }
}

/** 每个会话面板调用：会话状态变化时判断要不要提醒 */
export function useAttentionAlerts(state: SessionState, tabId: string | undefined): void {
  const prev = useRef(state);
  useEffect(() => {
    const before = prev.current;
    prev.current = state;
    if (before === state) return;
    const event = detectAttention(before, state);
    if (event) void alert(event, state, tabId);
  }, [state, tabId]);
}

/**
 * 主界面常驻处调用一次：预读设置、在首次操作时唤醒音频（自动播放策略），
 * 订阅通知点击——薄壳已把窗口拉到前台，这里切到对应会话并回到主界面
 */
export function useNotificationActivation(): void {
  const router = useRouter();
  useEffect(() => {
    const stopPrime = primeAudio();
    void useNotificationSettings.getState().load();
    let active = true;
    void getPlatform()
      .then((p) =>
        p.notificationWatch((tag) => {
          if (!active) return;
          if (tag) void activateNotification(tag);
          const path = window.location.pathname;
          if (path !== "/" && path !== "") router.push("/");
        }),
      )
      .catch(() => {});
    return () => {
      active = false;
      stopPrime();
    };
  }, [router]);
}
