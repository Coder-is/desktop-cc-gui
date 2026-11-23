import { listenMissionAgentEvents, type EngineEventPayload } from "@/lib/events";
import { ipc } from "@/lib/ipc";
import { missionId } from "@/features/mission/ids";

/**
 * Bot 团队 ↔ 宿主 agent 管线的桥。
 *
 * 后台轮次（定时任务 / 群聊成员）走 `bot_agent_start`，一句话解析走零工具的
 * `bot_team_parse_start`；两者的事件都在 `mission-agent://event` 流上，按
 * run id 路由回来。先注册监听再 invoke，避免错过首批事件。
 *
 * 只累积原文，不做动画或截断；结束（done）时一次性交给调用方。
 */

type Listener = (event: EngineEventPayload) => void;

const listeners = new Map<string, Listener>();
let bridged = false;

function ensureBridged(): void {
  if (bridged) return;
  bridged = true;
  void listenMissionAgentEvents((events) => {
    for (const event of events) {
      const listener = listeners.get(event.runId);
      if (!listener) continue;
      listener(event);
      if (event.kind === "done") listeners.delete(event.runId);
    }
  });
}

export interface BotTurnResult {
  text: string;
  sessionId: string | null;
  /** 后端说这一轮的会话能否续接；解析轮次恒为 false。 */
  resumable: boolean;
}

export interface BotTurnHandle {
  promise: Promise<BotTurnResult>;
  /** 中断进程；promise 以「已取消」拒绝。 */
  interrupt: () => void;
}

export class BotTurnCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "BotTurnCancelled";
  }
}

type Starter = (
  runId: string,
) => Promise<{ runId: string; sessionId: string | null; resumable?: boolean }>;

function runTurn(prefix: string, start: Starter, timeoutMs: number): BotTurnHandle {
  ensureBridged();
  const runId = `${prefix}${missionId("run")}`;
  let text = "";
  let messageText = "";
  let sessionId: string | null = null;
  let resumable = false;
  let settled = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveFn!: (value: BotTurnResult) => void;
  let rejectFn!: (error: Error) => void;
  const promise = new Promise<BotTurnResult>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const cleanup = (): void => {
    listeners.delete(runId);
    if (timer !== undefined) clearTimeout(timer);
  };
  const kill = (): void => {
    if (started) void ipc.botAgentInterrupt(runId).catch(() => {});
  };
  const settle = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveFn({ text: (text.length > 0 ? text : messageText).trim(), sessionId, resumable });
  };
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectFn(error);
  };

  listeners.set(runId, (event) => {
    if (event.sessionId) sessionId = event.sessionId;
    switch (event.kind) {
      case "delta":
        text += typeof event.data === "string" ? event.data : "";
        break;
      case "message": {
        const data = event.data as { role?: string; text?: string } | null;
        if (data?.role === "assistant" && typeof data.text === "string") {
          // 多条 assistant 消息（工具调用之间）全部保留，按到达顺序拼接。
          messageText = messageText ? `${messageText}\n\n${data.text}` : data.text;
        }
        break;
      }
      case "error": {
        const data = event.data as { message?: string } | string | null;
        const message = typeof data === "string" ? data : (data?.message ?? "agent run failed");
        fail(new Error(message));
        break;
      }
      case "done":
        settle();
        break;
    }
  });

  timer = setTimeout(() => {
    kill();
    fail(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
  }, timeoutMs);

  start(runId)
    .then((result) => {
      started = true;
      resumable = result.resumable === true;
      if (result.sessionId) sessionId = result.sessionId;
      // 结果回来之前已经被取消 / 超时：补一次中断，别留孤儿进程。
      if (settled) kill();
    })
    .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));

  return {
    promise,
    interrupt: () => {
      kill();
      fail(new BotTurnCancelled());
    },
  };
}

const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const PARSE_TIMEOUT_MS = 2 * 60 * 1000;

export interface BotTurnOptions {
  engine: string;
  workspacePath: string;
  sessionId: string | null;
  prompt: string;
  model: string | null;
  providerId: string | null;
  permissionMode: string;
  memoryBot: string | null;
}

/** 一个 Bot 后台轮次（定时任务 / 群聊成员）。 */
export function runBotTurn(options: BotTurnOptions): BotTurnHandle {
  return runTurn(
    "botteam-",
    (runId) => ipc.botAgentStart({ runId, ...options }),
    TURN_TIMEOUT_MS,
  );
}

/** 零工具纯文本轮次（一句话解析定时任务）。 */
export function runParseTurn(options: {
  engine: string;
  prompt: string;
  model: string | null;
  providerId: string | null;
}): BotTurnHandle {
  return runTurn(
    "botteam-parse-",
    (runId) => ipc.botTeamParseStart({ runId, ...options }),
    PARSE_TIMEOUT_MS,
  );
}
