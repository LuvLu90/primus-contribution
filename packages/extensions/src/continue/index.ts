// primus-continue：继续被停止或出错中断的回复（ADR 0021）。
// 前端点“继续”时发 `/primus-continue`；这里写入一条不显示的自定义消息并触发新一轮，
// Agent 从当前上下文（已完成的工具调用及其结果都在）接着做，而不是重发上一句用户消息。
// Core 回放给模型时会跳过被中止 / 出错的助手消息，所以提示里说明中断前的半截回复不在上下文中。
import { CONTINUE_COMMAND } from "@primus/protocol";

/** 写给模型的继续提示（模型可见、界面不显示） */
export const CONTINUE_PROMPT =
  "上一次回复被用户停止或因错误中断，中断前未完成的那段回复不会保留。请根据上面的对话和已有的工具结果，从中断前的进度继续完成当前任务；不要重复已经完成的操作，也不要从头重新回答。";

interface ContinueApi {
  registerCommand: (
    name: string,
    options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> },
  ) => void;
  sendMessage: (
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean },
  ) => Promise<void>;
}

function isContinueApi(pi: unknown): pi is ContinueApi {
  const p = pi as Partial<ContinueApi> | null | undefined;
  return typeof p?.registerCommand === "function" && typeof p.sendMessage === "function";
}

export default function primusContinue(pi: unknown): void {
  if (!isContinueApi(pi)) return;
  pi.registerCommand(CONTINUE_COMMAND, {
    description: "继续被停止或中断的回复（界面“继续”按钮用）",
    handler: async () => {
      // 命令在 prompt() 里执行，Core 要等它返回才回 handled；sendMessage 触发的新一轮要跑完才结束，
      // 所以放到下一个事件循环再开始，不阻塞命令的响应
      setTimeout(() => {
        pi.sendMessage(
          { customType: CONTINUE_COMMAND, content: CONTINUE_PROMPT, display: false },
          { triggerTurn: true },
        ).catch(() => {
          // 已有一轮在运行等情况：不处理，界面按 Core 的事件显示
        });
      }, 0);
    },
  });
}
