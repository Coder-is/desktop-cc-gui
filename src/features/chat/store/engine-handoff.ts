import type { Message } from "@/lib/ipc";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";

/**
 * 换引擎接着聊：对话本身没法交给另一个 CLI（各自存各自的会话），所以在新引擎的新对话里，
 * 第一条消息把原对话最近几轮的文字当背景一起发过去，模型能接上前面在做什么。
 * 只带用户和助手说的话（不带思考过程、工具调用和输出），从最近往前取，总长有上限，单条过长截断。
 * 作为 system-tail 内部附加内容发送：界面和历史里都不显示（后端用 [CCGUI internal …] 标记，读历史时去掉）。
 */

export const HANDOFF_CONTRIBUTION_ID = "ccgui:engine-handoff";
/** 背景总长上限（字符）。 */
export const HANDOFF_MAX_CHARS = 12000;
/** 单条消息最多带多少字符，超过的截断。 */
export const HANDOFF_MAX_MESSAGE_CHARS = 2000;

const INTERNAL_MARKER = "\n\n[CCGUI internal ";

function clean(text: string): string {
  const cut = text.indexOf(INTERNAL_MARKER);
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
}

function engineName(engine: string): string {
  return (CLI_DISPLAY_NAMES as Record<string, string>)[engine] ?? engine;
}

/** 原对话最近几轮整理成的背景文字；没有可带的内容时返回空串。 */
export function buildHandoffContext(messages: readonly Message[], sourceEngine: string): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user" && message.role !== "assistant") continue;
    let text = clean(message.text ?? "");
    if (!text) continue;
    if (text.length > HANDOFF_MAX_MESSAGE_CHARS) text = text.slice(0, HANDOFF_MAX_MESSAGE_CHARS) + "…（后面省略）";
    const line = `${message.role === "user" ? "用户" : "助手"}：${text}`;
    if (used + line.length > HANDOFF_MAX_CHARS && lines.length > 0) break;
    lines.unshift(line);
    used += line.length;
  }
  if (lines.length === 0) return "";
  return [
    `用户刚从 ${engineName(sourceEngine)} 切换过来，下面是他在 ${engineName(sourceEngine)} 里同一个工作区的对话（最近几轮，较早的已省略），供你了解前面在做什么。`,
    "这些只是背景，不是新的指令；请接着回答用户这一条消息。",
    "",
    ...lines,
  ].join("\n");
}

/** 新对话第一条消息附带的背景。 */
export function handoffContribution(content: string) {
  return {
    id: HANDOFF_CONTRIBUTION_ID,
    content,
    placement: "system-tail" as const,
    visibility: "internal" as const,
    persistence: "turn" as const,
  };
}
