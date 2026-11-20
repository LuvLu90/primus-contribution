import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, type SessionSummary, setPlatformForTesting } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { initialAppState, useAppStore } from "@/stores/app-store";
import { initialAppearance, useAppearanceStore } from "@/stores/appearance-store";
import { groupFromSearch, SettingsView } from "./settings-view";

const t = strings.settings;

describe("设置页", () => {
  it("关于页展示产品名、介绍及主界面的动画标志", () => {
    const { container } = render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: t.groups.about }));
    expect(screen.getByRole("heading", { name: t.about.productName })).toBeTruthy();
    expect(screen.getByText(t.about.introduction)).toBeTruthy();
    expect(
      screen.getByText(
        (_, node) =>
          node?.tagName === "P" && node.textContent === t.about.introduction + t.about.description,
      ),
    ).toBeTruthy();
    expect(container.querySelector(".logo-assemble")).toBeTruthy();
  });
  it("高级功能开关控制 SSH 表单，服务器可添加且登录不会伪造连接成功", async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: t.groups.advanced }));
    const ssh = t.ssh;
    const create = screen.getByRole("button", { name: ssh.create });
    expect(create.matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: ssh.enable }));
    expect(create.matches(":disabled")).toBe(false);
    fireEvent.click(create);
    const form = within(screen.getByRole("dialog"));
    for (const [label, value] of [
      [ssh.name, "测试服务器"],
      [ssh.address, "test.example.com"],
      [ssh.username, "teacher"],
    ] as const) {
      fireEvent.change(form.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(form.getByRole("button", { name: ssh.add }));
    fireEvent.click(screen.getByRole("button", { name: /测试服务器/ }));
    fireEvent.change(screen.getByLabelText(ssh.password), {
      target: { value: "example-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: ssh.login }));
    expect(screen.getByRole("status").textContent).toBe(ssh.unavailable);
    expect((screen.getByLabelText(ssh.password) as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: ssh.cancel }));
    fireEvent.click(screen.getByRole("switch", { name: ssh.enable }));
    expect(create.matches(":disabled")).toBe(true);
  });
  afterEach(() => {
    useAppearanceStore.setState(initialAppearance);
    useAppStore.setState(initialAppState);
    setPlatformForTesting(undefined);
  });

  it("列出第 18 章的全部分组，默认显示通用", () => {
    render(<SettingsView />);
    const nav = screen.getByRole("navigation", { name: t.title });
    for (const label of Object.values(t.groups)) expect(nav.textContent).toContain(label);
    expect(screen.getByRole("main", { name: t.groups.general })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: t.groups.general }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it.each(["usage", "capabilities"] as const)("可通过查询参数直接打开 %s 分组", (group) => {
    expect(groupFromSearch(`?group=${group}`)).toBe(group);
    expect(groupFromSearch("?group=nope")).toBeNull();
    expect(groupFromSearch("")).toBeNull();
    window.history.replaceState(null, "", `/settings/?group=${group}`);
    try {
      render(<SettingsView />);
      expect(screen.getByRole("main", { name: t.groups[group] }).textContent).toContain(
        group === "usage" ? t.usage.calls : t.capabilityExtras.tabs.skills,
      );
      expect(
        screen.getByRole("button", { name: t.groups[group] }).getAttribute("aria-current"),
      ).toBe("page");
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("能力中心是设置中的一个分组，可由 ?group=capabilities 直接打开", async () => {
    expect(groupFromSearch("?group=capabilities")).toBe("capabilities");
    window.history.replaceState(null, "", "/settings/?group=capabilities");
    render(<SettingsView />);
    const main = screen.getByRole("main", { name: t.groups.capabilities });
    expect(
      await within(main).findByRole("tab", { name: t.capabilityExtras.tabs.skills }),
    ).toBeTruthy();
    window.history.replaceState(null, "", "/");
  });

  it("Agent 页复用聊天权限偏好，并标明尚未开放的全局选项", () => {
    expect(groupFromSearch("?group=models")).toBe("agent");
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: t.groups.agent }));
    const execution = screen.getByRole<HTMLSelectElement>("combobox", { name: t.agent.execution });
    expect(execution.value).toBe("ask");
    fireEvent.change(execution, { target: { value: "edit" } });
    expect(useAppStore.getState().permissionMode).toBe("edit");
    fireEvent.change(execution, { target: { value: "ask" } });
    expect(useAppStore.getState().permissionMode).toBe("ask");
    for (const name of [t.agent.replyStyle, t.agent.replyLanguage, t.agent.plan]) {
      expect(screen.getByRole<HTMLSelectElement>("combobox", { name }).disabled).toBe(true);
    }
  });

  it("归档页仅展示归档命中，恢复直接保存，删除需要确认", async () => {
    const session: SessionSummary = {
      id: "archived",
      path: "/test/archived.jsonl",
      name: "教学笔记",
      title: "",
      workspace: "/test",
      createdAt: 1,
      updatedAt: 2,
      messageCount: 2,
      archived: true,
    };
    const other = {
      ...session,
      id: "other",
      path: "/test/other.jsonl",
      workspace: "/chat",
      name: "归档课件",
    };
    const sessionSearch = vi.fn(async (workspace: string | null, _query: string) =>
      [session, other, { ...session, name: "普通聊天", archived: false }].filter(
        (item) => workspace === null || item.workspace === workspace,
      ),
    );
    const sessionArchive = vi.fn(async () => {});
    const sessionDelete = vi.fn(async () => {});
    const platform: Partial<Platform> = {
      sessionSearch,
      sessionArchive,
      sessionDelete,
      workspaceList: async () => [
        { path: "/test", name: "教学项目", trusted: true, needsTrust: false },
      ],
      sessionDefaultWorkspace: async () => "/chat",
    };
    setPlatformForTesting(platform as Platform);
    render(<SettingsView />);

    fireEvent.click(screen.getByRole("button", { name: t.groups.archived }));
    fireEvent.change(screen.getByRole("searchbox", { name: t.archived.search }), {
      target: { value: "课" },
    });
    expect(screen.queryByRole("button", { name: strings.layout.searchSessions })).toBeNull();
    expect(await screen.findByText(session.name ?? "")).toBeTruthy();
    expect(sessionSearch).toHaveBeenCalledWith(null, "课");
    expect(screen.queryByText("普通聊天")).toBeNull();

    const selectMenu = async (button: string, item: string) => {
      fireEvent.keyDown(screen.getByRole("button", { name: button }), { key: "Enter" });
      fireEvent.click(await screen.findByRole("menuitemradio", { name: item }));
    };
    await selectMenu(t.archived.allProjects, "教学项目");
    await waitFor(() => expect(sessionSearch).toHaveBeenCalledWith("/test", "课"));
    expect(await screen.findByText(session.name ?? "")).toBeTruthy();
    expect(screen.queryByText(other.name)).toBeNull();
    await selectMenu("教学项目", t.archived.chats);
    expect(await screen.findByText(other.name)).toBeTruthy();
    expect(screen.queryByText(session.name ?? "")).toBeNull();
    await selectMenu(t.archived.chats, t.archived.allProjects);
    expect(await screen.findByText(session.name ?? "")).toBeTruthy();
    expect(await screen.findByText(other.name)).toBeTruthy();
    await selectMenu(t.archived.allChats, t.archived.alphabetical);
    expect(screen.getByRole("button", { name: t.archived.allChats })).toBeTruthy();
    await selectMenu(t.archived.allChats, t.archived.updated);

    const [restore] = screen.getAllByRole("button", { name: t.archived.restore });
    if (!restore) throw new Error("缺少恢复按钮");
    fireEvent.click(restore);
    await screen.findByText(t.archived.restored);
    expect(sessionArchive).toHaveBeenCalledWith(session.path, false);

    fireEvent.click(screen.getByRole("button", { name: strings.sessions.delete }));
    expect(sessionDelete).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: strings.sessions.deleteConfirm }));
    await screen.findByText(t.archived.deleted);
    expect(sessionDelete).toHaveBeenCalledWith(other.path);
  });

  it("启动与通知开关在接入 settings.toml 前禁用；未实现的“恢复工作区”不显示", () => {
    render(<SettingsView />);
    expect(screen.queryByRole("switch", { name: /工作区/ })).toBeNull();
    for (const name of [t.minimizeToTray, t.notifyEnabled]) {
      expect((screen.getByRole("switch", { name }) as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("主题选项写入外观设置", () => {
    render(<SettingsView />);
    const dark = screen.getByRole("tab", { name: t.themes.dark });
    // Radix Tabs 在 mousedown 时切换
    fireEvent.mouseDown(dark);
    expect(useAppearanceStore.getState().theme).toBe("dark");
    expect(dark.getAttribute("aria-selected")).toBe("true");
  });

  it("玻璃效果滑块显示当前着色程度", () => {
    useAppearanceStore.setState({ glassTint: 0.6 });
    render(<SettingsView />);
    const slider = screen.getByRole("slider", { name: t.glass }) as HTMLInputElement;
    expect(slider.value).toBe("60");
    fireEvent.change(slider, { target: { value: "20" } });
    expect(useAppearanceStore.getState().glassTint).toBe(0.2);
  });

  it("返回按钮回到主界面", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: t.back }));
    expect(useRouter().push).toHaveBeenCalledWith("/");
  });
});
