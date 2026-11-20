import type { AgentMessage, AssistantMessage, ExtensionUiDialogRequest } from "@primus/protocol";
import { describe, expect, it } from "vitest";
import { strings } from "@/lib/strings";
import { initialSessionState, type SessionState } from "@/stores/session-store";
import { detectAttention, plainText, sessionLabel, truncate } from "./attention";

const t = strings.notifications;

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 });
const assistant = (
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "p",
    model: "m",
    usage: {},
    stopReason,
    errorMessage,
    timestamp: 0,
  }) as unknown as AgentMessage;

const state = (patch: Partial<SessionState> = {}): SessionState => ({
  ...initialSessionState,
  ...patch,
});

const confirm: ExtensionUiDialogRequest = {
  type: "extension_ui_request",
  id: "ui-1",
  method: "confirm",
  title: "运行命令",
  message: "rm -rf build",
} as ExtensionUiDialogRequest;

describe("detectAttention", () => {
  it("一轮正常结束：完成，正文是最后一条回复的纯文本", () => {
    const prev = state({ running: true, messages: [user("修复登录")] });
    const next = state({
      running: false,
      messages: [user("修复登录"), assistant("已修复 **登录超时**，见 `auth.ts`")],
    });
    expect(detectAttention(prev, next)).toEqual({
      kind: "done",
      headline: t.done,
      detail: "已修复 登录超时，见 auth.ts",
    });
  });

  it("用户自己停止的不提醒；出错单独一类", () => {
    const prev = state({ running: true, messages: [user("a")] });
    expect(
      detectAttention(prev, state({ messages: [user("a"), assistant("", "aborted")] })),
    ).toBeNull();
    expect(
      detectAttention(
        prev,
        state({ messages: [user("a"), assistant("", "error", "429 Too Many Requests")] }),
      ),
    ).toEqual({ kind: "error", headline: t.error, detail: "429 Too Many Requests" });
  });

  it("没有结束、或结束时没有新回复，不提醒", () => {
    const running = state({ running: true, messages: [user("a")] });
    expect(
      detectAttention(running, { ...running, messages: [user("a"), assistant("x")] }),
    ).toBeNull();
    expect(detectAttention(running, state({ messages: [user("a")] }))).toBeNull();
    expect(detectAttention(state(), state({ messages: [user("a"), assistant("x")] }))).toBeNull();
  });

  it("新到的确认框：需要处理，正文是标题与内容", () => {
    const prev = state({ running: true });
    const next = state({ running: true, uiRequests: [confirm] });
    expect(detectAttention(prev, next)).toEqual({
      kind: "input",
      headline: t.confirm,
      detail: "运行命令：rm -rf build",
    });
    // 同一个确认框不重复提醒
    expect(detectAttention(next, { ...next })).toBeNull();
  });

  it("选择框与输入框的标题", () => {
    const select = {
      ...confirm,
      id: "s",
      method: "select",
      options: ["a"],
    } as ExtensionUiDialogRequest;
    const input = { ...confirm, id: "i", method: "input" } as ExtensionUiDialogRequest;
    expect(detectAttention(state(), state({ uiRequests: [select] }))?.headline).toBe(t.choose);
    expect(detectAttention(state(), state({ uiRequests: [input] }))?.headline).toBe(t.input);
  });

  it("新的提问：需要处理，正文是第一个问题", () => {
    const ask = { id: "a1", questions: [{ id: "q", question: "用哪个数据库？", options: [] }] };
    expect(detectAttention(state({ running: true }), state({ running: true, ask }))).toEqual({
      kind: "input",
      headline: t.ask,
      detail: "用哪个数据库？",
    });
  });

  it("计划进入等待批准：需要处理，且不再另报完成", () => {
    const plan = {
      phase: "awaiting" as const,
      id: "p1",
      status: "awaiting" as const,
      plan: { title: "迁移到 PostgreSQL", summary: "", steps: [], verification: [] },
    };
    const prev = state({ running: true, messages: [user("a")] });
    const next = state({ messages: [user("a"), assistant("计划如下")], plan });
    expect(detectAttention(prev, next)).toEqual({
      kind: "input",
      headline: t.plan,
      detail: "迁移到 PostgreSQL",
    });
    // 已在等待批准的计划，之后的结束不再提醒
    expect(detectAttention({ ...next, running: true }, next)).toBeNull();
  });
});

describe("文本处理", () => {
  it("去掉 Markdown 标记、压成一行", () => {
    expect(plainText("# 标题\n\n- 一项 [链接](http://x)\n```js\ncode\n```\n> 引用")).toBe(
      "标题 一项 链接 引用",
    );
  });

  it("按字符截断（不拆开汉字与表情）", () => {
    expect(truncate("一二三四五", 5)).toBe("一二三四五");
    expect(truncate("一二三四五六", 5)).toBe("一二三四…");
    expect(truncate("😀😀😀", 2)).toBe("😀…");
  });

  it("会话名取首条用户消息，没有时为新会话", () => {
    expect(sessionLabel([])).toBe(t.untitled);
    expect(sessionLabel([user("帮我把登录页的超时时间改成三十秒并补上测试"), assistant("x")])).toBe(
      "帮我把登录页的超时时间改成三十秒并补上测试",
    );
  });
});
