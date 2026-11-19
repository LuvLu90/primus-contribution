import type { TodoItem } from "@primus/protocol";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { strings } from "@/lib/strings";
import { COMPLETION_DELAY_MS, LipProgress } from "./agent-progress";

const t = strings.chat.progress;

const items: TodoItem[] = [
  { id: "1", text: "读取项目文件", status: "completed" },
  { id: "2", text: "更新浅色主题变量", status: "skipped" },
  { id: "3", text: "实现深色主题变量", status: "in_progress" },
  { id: "4", text: "注册主题切换按钮", status: "pending" },
  { id: "5", text: "运行 lint 与生产构建", status: "pending" },
];

afterEach(() => vi.useRealTimers());

const trigger = () => screen.queryByRole("button", { name: new RegExp(`^${t.label}：`) });

describe("唇条里的计划进度", () => {
  it("一行显示剩余步数与当前步骤；悬停弹出的列表里有全部步骤", () => {
    const { container } = render(<LipProgress items={items} />);
    expect(trigger()?.getAttribute("aria-label")).toBe(`${t.label}：还剩 3 步，实现深色主题变量`);
    // 跳过的算完成：总进度环 2/5
    expect(container.querySelector("[data-progress-ring]")?.getAttribute("stroke-dasharray")).toBe(
      "40 100",
    );
    // 弹出列表只靠 CSS 悬停 / 聚焦显示
    const popover = container.querySelector("[data-lip-popover]") as HTMLElement;
    expect(popover.className).toContain("group-hover/lp:opacity-100");
    expect(popover.className).toContain("group-focus-within/lp:opacity-100");
    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(5);
    expect(steps[2]?.getAttribute("aria-current")).toBe("step");
    expect(steps[0]?.textContent).toContain("已完成：读取项目文件");
    expect(steps[1]?.textContent).toContain("已跳过：更新浅色主题变量");
    expect((container.querySelector("[data-active-border]") as HTMLElement).style.translate).toBe(
      "0 76px",
    );
  });

  it("Escape 收起弹出列表，指针与焦点离开后恢复", () => {
    vi.useFakeTimers();
    const { container } = render(<LipProgress items={items} />);
    const popover = () => container.querySelector("[data-lip-popover]") as HTMLElement;
    const button = trigger() as HTMLElement;
    button.focus();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(popover().className).not.toContain("group-focus-within/lp:opacity-100");
    expect(popover().className).not.toContain("group-hover/lp:opacity-100");
    button.blur();
    fireEvent.mouseLeave(screen.getByTestId("lip-progress"));
    act(() => vi.runAllTimers());
    expect(popover().className).toContain("group-hover/lp:opacity-100");
  });

  it("焦点在输入框、鼠标悬停进度摘要时按 Escape 也能收起，离开后恢复", () => {
    vi.useFakeTimers();
    const { container } = render(
      <div>
        <textarea aria-label="输入框" />
        <LipProgress items={items} />
      </div>,
    );
    const popover = () => container.querySelector("[data-lip-popover]") as HTMLElement;
    const textarea = screen.getByRole("textbox", { name: "输入框" });
    const root = screen.getByTestId("lip-progress");
    textarea.focus();
    fireEvent.mouseEnter(root);
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(popover().className).not.toContain("group-hover/lp:opacity-100");
    expect(popover().className).not.toContain("group-focus-within/lp:opacity-100");
    fireEvent.mouseLeave(root);
    act(() => vi.runAllTimers());
    expect(popover().className).toContain("group-hover/lp:opacity-100");
  });

  it("Escape 收起后暂时隐藏再恢复：再次悬停能正常展开", () => {
    const { container, rerender } = render(<LipProgress items={items} />);
    const popover = () => container.querySelector("[data-lip-popover]") as HTMLElement;
    fireEvent.mouseEnter(screen.getByTestId("lip-progress"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(popover().className).not.toContain("group-hover/lp:opacity-100");
    // 隐藏期间没有离开事件，也没有执行恢复
    rerender(<LipProgress items={items} hidden />);
    expect(trigger()).toBeNull();
    rerender(<LipProgress items={items} />);
    fireEvent.mouseEnter(screen.getByTestId("lip-progress"));
    expect(popover().className).toContain("group-hover/lp:opacity-100");
    expect(popover().className).toContain("group-focus-within/lp:opacity-100");
  });

  it("全部完成后显示“全部步骤已完成”，停留后淡出；又有未完成的步骤时重新出现", () => {
    vi.useFakeTimers();
    const done = items.map((i) => ({ ...i, status: "completed" as const }));
    const { rerender } = render(<LipProgress items={done} />);
    expect(trigger()?.getAttribute("aria-label")).toContain(t.allDone);
    act(() => {
      vi.advanceTimersByTime(COMPLETION_DELAY_MS);
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(trigger()).toBeNull();
    rerender(<LipProgress items={[...done, { id: "6", text: "补测试", status: "pending" }]} />);
    expect(trigger()?.getAttribute("aria-label")).toContain("还剩 1 步");
  });

  it("暂时让位时不显示，恢复后不重复显示已结束的完成提示", () => {
    vi.useFakeTimers();
    const done = items.map((i) => ({ ...i, status: "completed" as const }));
    const { rerender } = render(<LipProgress items={done} />);
    act(() => {
      vi.advanceTimersByTime(COMPLETION_DELAY_MS);
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    rerender(<LipProgress items={done} hidden />);
    rerender(<LipProgress items={done} />);
    expect(trigger()).toBeNull();
    rerender(<LipProgress items={items} hidden />);
    expect(trigger()).toBeNull();
  });

  it("没有步骤时不显示", () => {
    const { container } = render(<LipProgress items={[]} />);
    expect(container.textContent).toBe("");
  });
});
