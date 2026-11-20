import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { strings } from "@/lib/strings";
import { type ModelCall, UsageSettings } from "./usage-settings";

const t = strings.settings.usage;

function todayOffset(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function call(id: string, days: number, model: string, total: number): ModelCall {
  return {
    id,
    timestamp: todayOffset(days),
    model,
    input: total,
    output: 0,
    total,
    cost: { amount: 0.01, currency: "USD", estimated: true },
    status: "success",
  };
}

describe("用量设置", () => {
  it("无统计来源时显示空状态，并以浅蓝显示日历", () => {
    render(<UsageSettings />);

    expect(screen.getAllByText(t.noData)).toHaveLength(5);
    expect(screen.getAllByRole("img", { name: /请求次数：暂无数据/ })[0]?.className).toContain(
      "bg-usage-0",
    );
  });

  it("当前月在首位，显示完整十二个月且隐藏星期标注", () => {
    render(<UsageSettings />);
    const heatmap = within(screen.getByRole("region", { name: t.heatmap }));
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("zh-CN", { month: "short" });
    const months = Array.from({ length: 12 }, (_, offset) =>
      formatter.format(new Date(now.getFullYear(), now.getMonth() - offset, 1)),
    );
    expect(
      heatmap.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent),
    ).toEqual(months);
    const dayCount = Array.from({ length: 12 }, (_, offset) =>
      new Date(now.getFullYear(), now.getMonth() - offset + 1, 0).getDate(),
    ).reduce((total, days) => total + days, 0);
    expect(heatmap.getAllByRole("img")).toHaveLength(dayCount);
    for (const weekday of t.weekdays) {
      expect(heatmap.queryByText(weekday)).toBeNull();
    }
  });

  it("表头日历仅过滤调用记录，统计卡保持周期总量", () => {
    render(
      <UsageSettings
        calls={[call("recent", -1, "Recent", 100), call("older", -180, "Older", 200)]}
        completedAt={[todayOffset(-180)]}
      />,
    );

    const table = within(screen.getByRole("table", { name: t.calls }));
    expect(table.getByText("Older")).toBeTruthy();
    expect(screen.getByText("300")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getAllByText(/USD.*估算/)).toHaveLength(3);

    expect(screen.queryByRole("combobox", { name: t.model })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t.time }));
    expect(screen.getByLabelText(t.date, { selector: "input" }).getAttribute("value")).toBe(
      screen.getByLabelText(t.date, { selector: "input" }).getAttribute("max"),
    );
    expect(screen.queryByRole("button", { name: t.date })).toBeNull();
    expect(screen.queryByRole("button", { name: t.clearDate })).toBeNull();
    expect(screen.getByRole("button", { name: t.time })).toBeTruthy();
    expect(table.getByText(t.noMatchingCalls)).toBeTruthy();
    expect(screen.getByText("300")).toBeTruthy();
  });

  it("每日和累计总量按真实 Token 计算", () => {
    render(
      <UsageSettings calls={[call("light", -1, "First", 5), call("heavy", -2, "Second", 100)]} />,
    );
    const key = new Date(todayOffset(-1));
    const date = [
      key.getFullYear(),
      String(key.getMonth() + 1).padStart(2, "0"),
      String(key.getDate()).padStart(2, "0"),
    ].join("-");
    const heatmap = within(screen.getByRole("region", { name: t.heatmap }));
    const cell = () =>
      heatmap.getAllByRole("img").find((node) => node.getAttribute("aria-label")?.startsWith(date));
    expect(cell()?.className).toContain("bg-usage-1");
    fireEvent.mouseDown(screen.getByRole("tab", { name: t.metrics.cumulative }));
    expect(cell()?.getAttribute("aria-label")).toContain("Token 消耗：105");
    expect(cell()?.className).toContain("bg-usage-4");
    fireEvent.mouseDown(screen.getByRole("tab", { name: t.metrics.weekly }));
    expect(cell()?.getAttribute("aria-label")).toContain("每周：");
  });
});
