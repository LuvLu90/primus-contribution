import type { AgentMessage } from "@primus/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { strings } from "@/lib/strings";
import { AgentTurn } from "./agent-turn";

const t = strings.chat.work;

const assistant = (content: unknown[], stopReason = "stop"): AgentMessage =>
  ({
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "ioply",
    model: "mock-large",
    usage: {},
    stopReason,
    timestamp: 2,
  }) as unknown as AgentMessage;

const toolResult = (toolCallId: string): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 3,
  }) as unknown as AgentMessage;

function renderTurn(messages: AgentMessage[], running: boolean, streaming: boolean) {
  return render(
    <AgentTurn
      messages={messages}
      toolRuns={{}}
      running={running}
      streaming={streaming}
      startedAt={1}
    />,
  );
}

describe("工作过程里的思考", () => {
  it("进行中的思考显示波纹点阵、流光的“正在思考”与计时", () => {
    const { container } = renderTurn(
      [assistant([{ type: "thinking", thinking: "先看看文件结构" }])],
      true,
      true,
    );
    const button = screen.getByRole("button", { name: new RegExp(t.thinkingNow) });
    expect(button.querySelectorAll(".think-wave-dot")).toHaveLength(9);
    expect(button.querySelector(".think-shimmer")?.textContent).toBe(t.thinkingNow);
    expect(button.textContent).toMatch(/\d+\.\ds$/);
    expect(container.querySelector('[data-icon="thinking"]')).toBeNull();
  });

  it("思考结束（后面出现正文）后不再留下思考行", () => {
    const { container } = renderTurn(
      [
        assistant([
          { type: "thinking", thinking: "先看看文件结构" },
          { type: "text", text: "好的，结论如下。" },
        ]),
      ],
      true,
      true,
    );
    expect(screen.queryByRole("button", { name: t.thinkingNow })).toBeNull();
    expect(container.querySelector('[data-icon="thinking"]')).toBeNull();
    expect(container.textContent).not.toContain(t.thinkingNow);
  });

  it("历史轮次里的思考不显示", () => {
    const { container } = renderTurn(
      [
        assistant([
          { type: "thinking", thinking: "想一想" },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ]),
        toolResult("c1"),
        assistant([{ type: "text", text: "完成" }]),
      ],
      false,
      false,
    );
    expect(container.querySelector('[data-icon="thinking"]')).toBeNull();
    expect(container.textContent).not.toContain(t.thinkingNow);
  });
});

describe("工具行的文件类型图标", () => {
  it("读取 / 写入文件时路径前显示对应类型的彩色图标，命令行不显示", () => {
    const { container } = renderTurn(
      [
        assistant([
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/app.tsx" } },
        ]),
        toolResult("c1"),
        // 中间的说明把连续的工具调用分开，每次调用单独一行
        assistant([
          { type: "text", text: "接着写文档" },
          { type: "toolCall", id: "c2", name: "write", arguments: { path: "docs/说明.md" } },
        ]),
        toolResult("c2"),
        assistant([
          { type: "text", text: "看看目录" },
          { type: "toolCall", id: "c3", name: "bash", arguments: { command: "ls" } },
        ]),
        toolResult("c3"),
        assistant([{ type: "text", text: "完成" }]),
      ],
      true,
      false,
    );
    const icons = [...container.querySelectorAll("[data-file-icon]")].map((el) =>
      el.getAttribute("data-file-icon"),
    );
    expect(icons).toEqual(["react-ts", "markdown"]);
  });
});

describe("生成图片（ADR 0018）", () => {
  it("generate_image 在工作过程里有一行，生成中另显示图片占位卡片", () => {
    renderTurn(
      [
        assistant([
          {
            type: "toolCall",
            id: "g1",
            name: "generate_image",
            arguments: { prompt: "一只橘猫", size: "1024x1536" },
          },
        ]),
      ],
      true,
      false,
    );
    // 工作过程里的一行与生成框左下角的文字
    expect(screen.getAllByText(t.tools.image.running)).toHaveLength(2);
    expect(screen.getByText("一只橘猫")).toBeTruthy();
    expect(screen.getByRole("region", { name: strings.chat.imagegen.card })).toBeTruthy();
  });

  it("失败的结果显示原因", () => {
    renderTurn(
      [
        assistant([
          { type: "toolCall", id: "g1", name: "generate_image", arguments: { prompt: "猫" } },
        ]),
        {
          role: "toolResult",
          toolCallId: "g1",
          toolName: "generate_image",
          content: [{ type: "text", text: "[failed]" }],
          details: {
            status: "failed",
            prompt: "猫",
            intent: "default",
            size: "1024x1024",
            images: [],
            error: "无法连接图片服务",
          },
          isError: true,
          timestamp: 3,
        } as unknown as AgentMessage,
        assistant([{ type: "text", text: "抱歉，图片服务暂时连不上。" }]),
      ],
      false,
      false,
    );
    expect(screen.getByText(`${strings.chat.imagegen.failed}：无法连接图片服务`)).toBeTruthy();
  });
});

describe("联网步骤（ADR 0020）", () => {
  const webResult = (toolCallId: string, toolName: string, details: unknown, isError = false) =>
    ({
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: "…" }],
      details,
      isError,
      timestamp: 3,
    }) as unknown as AgentMessage;

  const results = Array.from({ length: 8 }, (_, i) => ({
    title: `结果 ${i + 1}`,
    url: `https://www.site${i + 1}.com/p`,
    site: `www.site${i + 1}.com`,
  }));

  function renderWeb() {
    return renderTurn(
      [
        assistant([
          {
            type: "toolCall",
            id: "s1",
            name: "web_search",
            arguments: { query: "Rust 1.99 发布" },
          },
          {
            type: "toolCall",
            id: "f1",
            name: "web_fetch",
            arguments: { url: "https://blog.rust-lang.org/x" },
          },
        ]),
        webResult("s1", "web_search", { status: "done", query: "Rust 1.99 发布", results }),
        webResult("f1", "web_fetch", {
          status: "done",
          url: "https://blog.rust-lang.org/x",
          finalUrl: "https://blog.rust-lang.org/x",
          title: "Announcing Rust 1.99",
          contentType: "text/html",
          totalChars: 5000,
          range: [0, 5000],
        }),
      ],
      true,
      false,
    );
  }

  it("搜索一行“已搜索 关键词”，下面一排站点标记（最多 6 个，其余显示数字）", () => {
    renderWeb();
    const row = screen.getByRole("button", { name: /已搜索/ });
    expect(row.textContent).toContain(t.tools.web.done);
    expect(row.textContent).toContain("Rust 1.99 发布");
    expect(row.querySelector('[data-icon="globe"]')).toBeTruthy();
    const marks = screen.getAllByRole("button", { name: /^结果 \d（site\d\.com）$/ });
    expect(marks).toHaveLength(6);
    expect(marks[0]?.textContent).toBe("S");
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("读取网页一行“已阅读 标题”，不与搜索合并成汇总行", () => {
    renderWeb();
    const row = screen.getByRole("button", { name: /已阅读/ });
    expect(row.textContent).toContain("Announcing Rust 1.99");
    expect(row.textContent).toContain("blog.rust-lang.org");
    expect(screen.queryByText(t.groups.web.done)).toBeNull();
  });

  it("点来源先确认再打开外部链接", async () => {
    renderWeb();
    fireEvent.click(
      screen.getAllByRole("button", { name: /^结果 1（site1\.com）$/ })[0] as HTMLElement,
    );
    expect(await screen.findByText(t.web.linkDescription)).toBeTruthy();
    expect(screen.getByText("https://www.site1.com/p")).toBeTruthy();
  });

  it("失败的搜索标红并在展开后显示原因", async () => {
    renderTurn(
      [
        assistant([{ type: "toolCall", id: "s2", name: "web_search", arguments: { query: "x" } }]),
        webResult(
          "s2",
          "web_search",
          { status: "failed", query: "x", results: [], error: "无法连接搜索服务" },
          true,
        ),
      ],
      true,
      false,
    );
    const row = screen.getByRole("button", { name: /已搜索/ });
    expect(row.textContent).toContain(t.web.failed);
    fireEvent.click(row);
    expect(await screen.findByText("无法连接搜索服务")).toBeTruthy();
  });

  it("失败但没有 details 时，展开后显示工具结果文字", async () => {
    renderTurn(
      [
        assistant([
          { type: "toolCall", id: "f2", name: "web_fetch", arguments: { url: "https://a.com" } },
        ]),
        {
          role: "toolResult",
          toolCallId: "f2",
          toolName: "web_fetch",
          content: [{ type: "text", text: "[failed] 工具未注册" }],
          isError: true,
          timestamp: 3,
        } as unknown as AgentMessage,
      ],
      true,
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: /已阅读/ }));
    expect(await screen.findByText("工具未注册")).toBeTruthy();
  });

  it("已取消的搜索与网页读取只显示已停止，不标成失败", async () => {
    renderTurn(
      [
        assistant([
          { type: "toolCall", id: "sc", name: "web_search", arguments: { query: "q" } },
          { type: "toolCall", id: "fc", name: "web_fetch", arguments: { url: "https://a.com" } },
        ]),
        webResult("sc", "web_search", { status: "cancelled", query: "q", results: [] }, true),
        webResult("fc", "web_fetch", { status: "cancelled", url: "https://a.com" }, true),
      ],
      true,
      false,
    );
    const searchRow = screen.getByRole("button", { name: /已搜索/ });
    const fetchRow = screen.getByRole("button", { name: /已阅读/ });
    expect(searchRow.textContent).toContain(t.web.cancelled);
    expect(searchRow.textContent).not.toContain(t.web.failed);
    expect(fetchRow.textContent).toContain(t.web.cancelled);
    expect(fetchRow.textContent).not.toContain(t.web.failed);
    fireEvent.click(searchRow);
    fireEvent.click(fetchRow);
    expect(screen.queryByText(t.web.failed)).toBeNull();
  });
});
