import { CONTINUE_COMMAND } from "@primus/protocol";
import { describe, expect, it, vi } from "vitest";
import primusContinue, { CONTINUE_PROMPT } from "./index.ts";

describe("primus-continue", () => {
  it("注册命令；执行后在下一个事件循环写入不显示的继续消息并触发新一轮", async () => {
    vi.useFakeTimers();
    try {
      const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
      const sendMessage = vi.fn((): void => undefined);
      primusContinue({
        registerCommand: (name: string, o: { handler: (a: string, c: unknown) => Promise<void> }) =>
          commands.set(name, o.handler),
        sendMessage,
      });
      const handler = commands.get(CONTINUE_COMMAND);
      expect(handler).toBeDefined();
      await handler?.("", {});
      // 命令先返回，不等新一轮跑完
      expect(sendMessage).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(sendMessage).toHaveBeenCalledWith(
        { customType: CONTINUE_COMMAND, content: CONTINUE_PROMPT, display: false },
        { triggerTurn: true },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("sendMessage 同步抛错时不在定时器里抛出未捕获异常", async () => {
    vi.useFakeTimers();
    try {
      const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
      const sendMessage = vi.fn((): void => {
        throw new Error("inactive");
      });
      primusContinue({
        registerCommand: (name: string, o: { handler: (a: string, c: unknown) => Promise<void> }) =>
          commands.set(name, o.handler),
        sendMessage,
      });
      await commands.get(CONTINUE_COMMAND)?.("", {});
      await expect(vi.runAllTimersAsync()).resolves.not.toThrow();
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("API 不完整时不注册", () => {
    const registerCommand = vi.fn();
    primusContinue({ registerCommand });
    expect(registerCommand).not.toHaveBeenCalled();
  });
});
