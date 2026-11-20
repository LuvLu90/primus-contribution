// 从会话状态的变化里找出需要提醒用户的时刻（ADR 0023，纯函数，便于测试）。
// 与 Codex 的两类事件对应：一轮结束（agent-turn-complete）与需要用户处理（approval-requested / 提问 / 计划审批）。
//   - 结束：两次观察之间有一轮结束（agent_settled 计数增加；get_state 校正时退化为运行中 → 空闲）。
//     用户自己停止的（agent_settled 的 aborted，或最后一条回复 stopReason 为 aborted）不提醒；出错单独一类；
//     结束时正停在提问或计划审批上，按“需要处理”提醒，不再另报完成。
//   - 需要处理：新到的确认框 / 选择框 / 输入框（primus-guard 等扩展的对话框）、新的 ask_user 提问、
//     新进入等待批准的计划。同一次变化有多件时只报一件（先到的对话框优先）。
import type { AgentMessage, AssistantMessage, ExtensionUiDialogRequest } from "@primus/protocol";
import { strings } from "@/lib/strings";
import type { SessionState } from "@/stores/session-store";

const t = strings.notifications;

export type AttentionKind = "done" | "error" | "input";

export interface AttentionEvent {
  kind: AttentionKind;
  /** 通知标题里“发生了什么” */
  headline: string;
  /** 通知正文：回复摘要、错误信息或要处理的内容 */
  detail: string;
}

/** 通知标题中会话名的长度上限 */
const TITLE_MAX = 24;
/** 通知正文的长度上限（Windows Toast 大约显示 3 行） */
const BODY_MAX = 140;

export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max
    ? text
    : `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

/** 把 Markdown 粗略去掉标记、压成一行，作为通知正文 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => ((c as { type?: string }).type === "text" ? (c as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

/** 会话在通知里的名字：首条用户消息（一行、截断）；还没有时为“新会话” */
export function sessionLabel(messages: readonly AgentMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = first ? plainText(textOf((first as { content?: unknown }).content)) : "";
  return text ? truncate(text, TITLE_MAX) : t.untitled;
}

/** 最后一条用户消息之后的最后一条助手消息（这一轮的结局） */
function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") return m as AssistantMessage;
    if (m?.role === "user") return undefined;
  }
  return undefined;
}

function dialogEvent(r: ExtensionUiDialogRequest): AttentionEvent {
  const headline = r.method === "confirm" ? t.confirm : r.method === "select" ? t.choose : t.input;
  const parts = [r.title, r.method === "confirm" ? r.message : ""].map((x) => plainText(x ?? ""));
  return {
    kind: "input",
    headline,
    detail: truncate(parts.filter(Boolean).join("：") || headline, BODY_MAX),
  };
}

const awaitingPlan = (s: SessionState) =>
  s.plan?.phase === "awaiting" && s.plan.status === "awaiting" && s.plan.id ? s.plan : undefined;

/** 这次变化里要提醒的事；没有时为 null */
export function detectAttention(prev: SessionState, next: SessionState): AttentionEvent | null {
  // 需要处理：新到的对话框
  const fresh = next.uiRequests.find((r) => !prev.uiRequests.some((p) => p.id === r.id));
  if (fresh) return dialogEvent(fresh);
  // 新的提问
  if (next.ask && next.ask.id !== prev.ask?.id) {
    const q = next.ask.questions[0];
    const detail = plainText(q?.question ?? "") || t.ask;
    return { kind: "input", headline: t.ask, detail: truncate(detail, BODY_MAX) };
  }
  // 新进入等待批准的计划
  const plan = awaitingPlan(next);
  if (plan && awaitingPlan(prev)?.id !== plan.id) {
    const detail = plainText(plan.plan?.title ?? "") || t.plan;
    return { kind: "input", headline: t.plan, detail: truncate(detail, BODY_MAX) };
  }
  // 一轮结束：同一批记录里可能已经开始又结束，只看 running 会漏掉
  if (next.running) return null;
  const settled = next.settledTurns !== prev.settledTurns;
  if (!settled && !prev.running) return null;
  // 用户停止（含工具执行期间停止：此时最后一条回复的 stopReason 是 toolUse）
  if (settled && next.lastTurnAborted) return null;
  // 停在提问或计划审批上：已按“需要处理”提醒过
  if (next.ask || plan) return null;
  const last = lastAssistant(next.messages);
  if (!last || last.stopReason === "aborted") return null;
  if (last.stopReason === "error") {
    const detail = plainText(last.errorMessage ?? "") || t.errorBody;
    return { kind: "error", headline: t.error, detail: truncate(detail, BODY_MAX) };
  }
  const detail = plainText(textOf(last.content)) || t.doneBody;
  return { kind: "done", headline: t.done, detail: truncate(detail, BODY_MAX) };
}
