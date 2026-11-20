import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Platform, setPlatformForTesting } from "@/lib/platform";
import { createMockPlatform } from "@/lib/platform/mock";
import { strings } from "@/lib/strings";
import * as chime from "./chime";
import { NotificationSettingsSection } from "./notification-settings";
import {
  resetNotificationSettingsForTest,
  useNotificationSettings,
} from "./notification-settings-store";

const t = strings.settings.notify;

function setup(patch: Partial<Platform> = {}) {
  const platform = { ...createMockPlatform(), ...patch };
  setPlatformForTesting(platform);
  render(<NotificationSettingsSection />);
  return platform;
}

describe("设置·通知与提示音", () => {
  beforeEach(() => resetNotificationSettingsForTest());
  afterEach(() => {
    setPlatformForTesting(undefined);
    vi.restoreAllMocks();
  });

  it("读取失败：不能修改（避免用默认值覆盖已保存的设置），重试成功后可改", async () => {
    let fail = true;
    const base = createMockPlatform();
    const platform = setup({
      notificationSettingsGet: async () => {
        if (fail) throw new Error("load");
        return base.notificationSettingsGet();
      },
    });
    const save = vi.spyOn(platform, "notificationSettingsSet");
    const retry = await screen.findByRole("button", { name: t.retry });
    const sound = screen.getByRole("switch", { name: t.sound }) as HTMLInputElement;
    expect(sound.disabled).toBe(true);
    await useNotificationSettings.getState().update({ sound: false });
    expect(save).not.toHaveBeenCalled();
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(sound.disabled).toBe(false));
    expect(screen.queryByRole("button", { name: t.retry })).toBeNull();
  });

  it("读取后可修改并保存", async () => {
    const platform = setup();
    const save = vi.spyOn(platform, "notificationSettingsSet");
    const sound = (await screen.findByRole("switch", { name: t.sound })) as HTMLInputElement;
    await waitFor(() => expect(sound.disabled).toBe(false));
    expect(sound.checked).toBe(true);
    fireEvent.click(sound);
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        turnComplete: "background",
        needsInput: true,
        sound: false,
      }),
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: t.turnCompleteModes.always }));
    await waitFor(() =>
      expect(useNotificationSettings.getState().settings.turnComplete).toBe("always"),
    );
  });

  it("保存失败时回滚并提示", async () => {
    setup({ notificationSettingsSet: async () => Promise.reject(new Error("磁盘已满")) });
    const needs = (await screen.findByRole("switch", { name: t.needsInput })) as HTMLInputElement;
    await waitFor(() => expect(needs.disabled).toBe(false));
    fireEvent.click(needs);
    expect(await screen.findByText("磁盘已满")).toBeTruthy();
    expect(useNotificationSettings.getState().settings.needsInput).toBe(true);
  });

  it("试听两种提示音", async () => {
    const play = vi.spyOn(chime, "playChime").mockResolvedValue(true);
    setup();
    fireEvent.click(screen.getByRole("button", { name: t.previewDone }));
    fireEvent.click(screen.getByRole("button", { name: t.previewInput }));
    expect(play).toHaveBeenNthCalledWith(1, "done", { force: true });
    expect(play).toHaveBeenNthCalledWith(2, "input", { force: true });
  });
});
