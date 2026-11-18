import type { TodoItem } from "@primus/protocol";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { strings } from "@/lib/strings";
import { AgentProgress, COMPLETION_DELAY_MS, expandedHeight } from "./agent-progress";

const t = strings.chat.progress;

const items: TodoItem[] = [
  { id: "1", text: "读取项目文件", status: "completed" },
  { id: "2", text: "更新浅色主题变量", status: "skipped" },
  { id: "3", text: "实现深色主题变量", status: "in_progress" },
  { id: "4", text: "注册主题切换按钮", status: "pending" },
  { id: "5", text: "运行 lint 与生产构建", status: "pending" },
];

afterEach(() => vi.useRealTimers());

describe("计划进度卡片", () => {
  it("默认收起成一行：剩余步数与当前步骤，点击展开全部步骤", () => {
    const { container } = render(<AgentProgress items={items} />);
    const card = screen.getByRole("region", { name: t.label });
    expect(card.style.height).toBe("44px");
    const expand = screen.getByRole("button", { name: `${t.expand}：还剩 3 步，实现深色主题变量` });
    // 跳过的算完成：总进度环 2/5
    expect(container.querySelector("[data-progress-ring]")?.getAttribute("stroke-dasharray")).toBe(
      "40 100",
    );
    fireEvent.click(expand);
    expect(card.style.height).toBe(`${expandedHeight(5)}px`);
    expect(expandedHeight(5)).toBe(235);
    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(5);
    expect(steps[2]?.getAttribute("aria-current")).toBe("step");
    expect(steps[0]?.textContent).toContain("已完成：读取项目文件");
    expect(steps[1]?.textContent).toContain("已跳过：更新浅色主题变量");
    // 当前步骤的胶囊边框移到第 3 行
    expect((container.querySelector("[data-active-border]") as HTMLElement).style.translate).toBe(
      "0 76px",
    );
    fireEvent.click(screen.getByRole("button", { name: t.collapse }));
    expect(card.style.height).toBe("44px");
  });

  it("超过 8 步时展开高度封顶", () => {
    expect(expandedHeight(12)).toBe(expandedHeight(8));
  });

  it("全部完成后显示“全部步骤已完成”，停留后淡出；又有未完成的步骤时重新出现", () => {
    vi.useFakeTimers();
    const done = items.map((i) => ({ ...i, status: "completed" as const }));
    const { rerender } = render(<AgentProgress items={done} />);
    expect(screen.getByRole("region", { name: t.label }).textContent).toContain(t.allDone);
    act(() => {
      vi.advanceTimersByTime(COMPLETION_DELAY_MS);
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByRole("region", { name: t.label })).toBeNull();
    rerender(<AgentProgress items={[...done, { id: "6", text: "补测试", status: "pending" }]} />);
    expect(screen.getByRole("region", { name: t.label }).textContent).toContain("还剩 1 步");
  });

  it("键盘展开 / 收起后焦点交给另一层的按钮", () => {
    render(<AgentProgress items={items} />);
    const expand = screen.getByRole("button", { name: new RegExp(`^${t.expand}`) });
    expand.focus();
    fireEvent.click(expand);
    const collapse = screen.getByRole("button", { name: t.collapse });
    expect(document.activeElement).toBe(collapse);
    fireEvent.click(collapse);
    expect(document.activeElement).toBe(expand);
  });

  it("暂时让位时不显示，恢复后不重复显示已结束的完成提示", () => {
    vi.useFakeTimers();
    const done = items.map((i) => ({ ...i, status: "completed" as const }));
    const { rerender } = render(<AgentProgress items={done} />);
    act(() => {
      vi.advanceTimersByTime(COMPLETION_DELAY_MS);
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    rerender(<AgentProgress items={done} hidden />);
    rerender(<AgentProgress items={done} />);
    expect(screen.queryByRole("region", { name: t.label })).toBeNull();
    rerender(<AgentProgress items={items} hidden />);
    expect(screen.queryByRole("region", { name: t.label })).toBeNull();
  });

  it("没有步骤时不显示", () => {
    const { container } = render(<AgentProgress items={[]} />);
    expect(container.textContent).toBe("");
  });
});
