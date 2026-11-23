import i18n from "@/lib/i18n";
import type { BotConfig, BotGroup, BotGroupMessage, BotRoutine, BotRoutineRun, EngineInfo } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { getNotificationPreferences, sendOSNotification, formatNotificationBody } from "@/lib/notifications";
import { missionId } from "@/features/mission/ids";
import { botById, useBotStore } from "@/features/bots/bot-store";
import { buildBotPromptBlock } from "@/features/bots/bot-block";
import { engineSupportsMemory } from "@/features/bots/memory";
import { useChatStore } from "@/features/chat/store";
import { BotTurnCancelled, runBotTurn } from "./agent-run";
import { runRotation, USER_HANDLE, type GroupMember } from "./group-chat";
import { dueSlot } from "./schedule";
import { useBotTeamStore } from "./store";

/**
 * Bot 团队的执行层：定时任务的运行 / 调度 tick、群聊发送与停止。
 *
 * 后台轮次一律带上 Bot 的提示词块（与聊天 `#` 选 Bot 时同一套拼装）和记忆
 * 工具（Bot 开着记忆且引擎支持时）；权限按 Bot 设置由后端映射，`ask`
 * 只给只读工具（见 bot_team.rs）。
 */

export function newId(prefix: string): string {
  return missionId(prefix);
}

function engines(): EngineInfo[] {
  return useChatStore.getState().engines;
}

/** 可用于后台轮次的引擎：已安装且未被停用。 */
export function usableEngines(): EngineInfo[] {
  return engines().filter((e) => e.available && e.enabled);
}

/** Bot 运行后端 → 默认引擎。direct（应用内直连）还没有后台实现，退回 claude。 */
export function defaultEngineFor(bot: BotConfig | null): string {
  const kind = bot?.runtime.kind;
  const preferred = kind === "codex" ? "codex" : "claude";
  const usable = usableEngines();
  if (usable.some((e) => e.id === preferred)) return preferred;
  return usable[0]?.id ?? preferred;
}

export function defaultWorkspaceFor(bot: BotConfig | null): string {
  const cwd = bot?.runtime.cwd?.trim();
  if (cwd) return cwd;
  return useChatStore.getState().workspaces[0]?.path ?? "";
}

/** 记忆工具：Bot 开着记忆、引擎能挂，且不是「每次询问」——后台只读轮次不写任何
 *  东西，后端同样不会挂（bot_team.rs 的 plan_for），这里保持一致，提示词里
 *  也就不写「用 memory 工具」。 */
function memoryBotFor(bot: BotConfig, engine: string): string | null {
  if (bot.runtime.permissionMode === "ask") return null;
  return bot.memory.enabled !== false && engineSupportsMemory(engines(), engine) ? bot.id : null;
}

async function botPromptBlock(bot: BotConfig, engine: string): Promise<string> {
  return buildBotPromptBlock(bot, { memoryToolAvailable: memoryBotFor(bot, engine) !== null });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function notify(kind: "done" | "error", title: string, body: string, tag: string): Promise<void> {
  try {
    const prefs = await getNotificationPreferences();
    if (!prefs.enabled || !(kind === "done" ? prefs.onCompletion : prefs.onError)) return;
    await sendOSNotification({
      title,
      body: formatNotificationBody(body, 160, title),
      tag,
      onClick: () => useBotTeamStore.getState().openTab(),
    });
  } catch (error) {
    console.warn("[bot-team] notification failed", error);
  }
}

// ------------------------------------------------------------ routines ---

/** 同一个 Bot 的定时任务依次执行（计划 §10），不并行。 */
const botQueues = new Map<string, Promise<void>>();

export type RoutineTrigger = BotRoutineRun["trigger"];

/**
 * 执行一次定时任务。调度触发的调用方必须先拿到 claim；手动「立即运行」
 * 不占计划时刻，直接执行。返回时运行记录已落盘。
 */
export function runRoutine(routine: BotRoutine, trigger: RoutineTrigger): Promise<void> {
  const previous = botQueues.get(routine.botId) ?? Promise.resolve();
  const next = previous.then(() => executeRoutine(routine, trigger)).catch((error) => {
    console.warn("[bot-team] routine run failed", error);
  });
  botQueues.set(routine.botId, next);
  void next.finally(() => {
    if (botQueues.get(routine.botId) === next) botQueues.delete(routine.botId);
  });
  return next;
}

async function executeRoutine(routine: BotRoutine, trigger: RoutineTrigger): Promise<void> {
  const store = useBotTeamStore.getState();
  if (store.running[routine.id]) return;
  const run: BotRoutineRun = {
    id: newId("run"),
    routineId: routine.id,
    botId: routine.botId,
    trigger,
    startedAt: Date.now(),
    status: "running",
    output: "",
  };
  const persist = async (value: BotRoutineRun) => {
    useBotTeamStore.getState().upsertRun(value);
    await ipc.botRoutineRunSave(value).catch((error) => console.warn("[bot-team] save run failed", error));
  };
  await persist(run);

  const finish = async (status: "ok" | "error" | "cancelled", output: string, error: string | null, sessionId: string | null) => {
    useBotTeamStore.getState().setRunning(routine.id, null);
    await persist({ ...run, status, output, error, sessionId, finishedAt: Date.now() });
    const updated = await ipc.botRoutineFinish(routine.id, status, error).catch(() => null);
    if (updated) useBotTeamStore.getState().replaceRoutine(updated);
  };

  if (!useBotStore.getState().loaded) await useBotStore.getState().refresh();
  const bot = botById(routine.botId);
  if (!bot) {
    await finish("error", "", i18n.t("botTeam.botMissing"), null);
    return;
  }
  const engine = routine.engine || defaultEngineFor(bot);
  let handle: ReturnType<typeof runBotTurn> | null = null;
  try {
    const block = await botPromptBlock(bot, engine);
    handle = runBotTurn({
      engine,
      workspacePath: routine.workspacePath,
      sessionId: null,
      prompt: `${routine.prompt}${block}`,
      model: routine.model ?? bot.runtime.model ?? null,
      providerId: routine.providerId ?? null,
      permissionMode: bot.runtime.permissionMode,
      memoryBot: memoryBotFor(bot, engine),
    });
    useBotTeamStore.getState().setRunning(routine.id, { runId: run.id, interrupt: handle.interrupt });
    const result = await handle.promise;
    await finish("ok", result.text, null, result.sessionId);
    void notify("done", `${bot.name} · ${routine.name}`, result.text || i18n.t("botTeam.runDoneEmpty"), `routine-${routine.id}`);
  } catch (error) {
    if (error instanceof BotTurnCancelled) {
      await finish("cancelled", "", null, null);
      return;
    }
    await finish("error", "", errorText(error), null);
    void notify("error", `${bot.name} · ${routine.name}`, errorText(error), `routine-${routine.id}`);
  }
}

export function cancelRoutine(routineId: string): void {
  useBotTeamStore.getState().running[routineId]?.interrupt();
}

/**
 * 调度器的一次 tick：重读存储（别的窗口可能改过），对每个到点的任务先
 * claim 再执行。错过的时刻按 missedPolicy：skip 只推进 lastSlotAt，
 * run_once 补跑一次（错过多次也只补一次）。
 */
export async function schedulerTick(now = Date.now()): Promise<void> {
  const store = useBotTeamStore.getState();
  await store.load();
  for (const routine of useBotTeamStore.getState().routines) {
    const due = dueSlot(routine, now);
    if (!due) continue;
    const claimed = await ipc.botRoutineClaim(routine.id, due.slotAt).catch((error) => {
      console.warn("[bot-team] claim failed", error);
      return null;
    });
    if (!claimed) continue;
    useBotTeamStore.getState().replaceRoutine(claimed);
    if (due.missed && claimed.missedPolicy === "skip") continue;
    void runRoutine(claimed, due.missed ? "catchup" : "schedule");
  }
}

// --------------------------------------------------------------- groups ---

const groupStops = new Map<string, { stopped: boolean; interrupt: (() => void) | null }>();

export function groupMembers(group: BotGroup): GroupMember[] {
  return group.memberBotIds
    .map((id) => botById(id))
    .filter((bot): bot is BotConfig => bot !== null)
    .map((bot) => ({ id: bot.id, slug: bot.slug, name: bot.name, description: bot.description }));
}

/** 用户在群里发一条消息，然后跑完整的轮转。 */
export async function sendGroupMessage(groupId: string, text: string): Promise<void> {
  const store = useBotTeamStore.getState();
  let group = store.groups.find((g) => g.id === groupId);
  if (!group || !text.trim()) return;
  if (store.groupSpeaking[groupId] !== undefined) return;
  if (!useBotStore.getState().loaded) await useBotStore.getState().refresh();
  const members = groupMembers(group);
  if (members.length < 2) throw new Error(i18n.t("botTeam.groupMembersMissing"));

  const control = { stopped: false, interrupt: null as (() => void) | null };
  groupStops.set(groupId, control);
  store.setSpeaking(groupId, null);
  try {
    if (!store.messagesByGroup[groupId]) await store.loadMessages(groupId);
    const userMessage: BotGroupMessage = {
      id: newId("msg"),
      groupId,
      author: USER_HANDLE,
      text: text.trim(),
      createdAt: Date.now(),
      status: "ok",
    };
    await ipc.botGroupMessagesAppend(groupId, [userMessage]);
    useBotTeamStore.getState().appendMessages(groupId, [userMessage]);
    if (group.needsUser) group = await useBotTeamStore.getState().saveGroup({ ...group, needsUser: false });

    const messages = [...(useBotTeamStore.getState().messagesByGroup[groupId] ?? [])];
    const sessions: Record<string, string> = { ...group.memberSessions };
    const current = group;
    const outcome = await runRotation(
      {
        group: current,
        members,
        messages,
        newMessageId: () => newId("msg"),
        now: () => Date.now(),
        shouldStop: () => control.stopped,
        onSpeaking: (id) => useBotTeamStore.getState().setSpeaking(groupId, id),
        append: async (message) => {
          await ipc.botGroupMessagesAppend(groupId, [message]);
          useBotTeamStore.getState().appendMessages(groupId, [message]);
        },
        runMember: async (member, prompt) => {
          const bot = botById(member.id);
          if (!bot) throw new Error(i18n.t("botTeam.botMissing"));
          const engine = current.engine || defaultEngineFor(bot);
          const sessionId = sessions[member.id] ?? null;
          // 第一次在本群发言时带上 Bot 的提示词块；续接的会话里已经有了（冻结快照）。
          const block = sessionId ? "" : await botPromptBlock(bot, engine);
          const handle = runBotTurn({
            engine,
            workspacePath: current.workspacePath,
            sessionId,
            prompt: `${prompt}${block}`,
            model: current.model ?? bot.runtime.model ?? null,
            providerId: current.providerId ?? null,
            permissionMode: bot.runtime.permissionMode,
            memoryBot: memoryBotFor(bot, engine),
          });
          control.interrupt = handle.interrupt;
          try {
            const result = await handle.promise;
            // 只有能续接的会话才记住：不能续接时下次照样带提示词块、开新会话。
            if (result.resumable && result.sessionId) sessions[member.id] = result.sessionId;
            else delete sessions[member.id];
            return result.text;
          } finally {
            control.interrupt = null;
          }
        },
      },
      userMessage,
      store.pausedByGroup[groupId] ?? [],
    );
    useBotTeamStore.getState().setPaused(groupId, outcome.paused);
    const latest = useBotTeamStore.getState().groups.find((g) => g.id === groupId);
    if (latest) {
      await useBotTeamStore.getState().saveGroup({
        ...latest,
        memberSessions: sessions,
        needsUser: outcome.needsUser,
      });
    }
    if (outcome.needsUser) {
      void notify("done", group.name, i18n.t("botTeam.needsYou"), `group-${groupId}`);
    }
  } finally {
    groupStops.delete(groupId);
    useBotTeamStore.getState().setSpeaking(groupId, undefined);
  }
}

export function stopGroup(groupId: string): void {
  const control = groupStops.get(groupId);
  if (!control) return;
  control.stopped = true;
  control.interrupt?.();
}

/** 清空群消息时一并丢掉成员会话：下一次发言重新带上提示词块、从头开始。 */
export async function resetGroup(groupId: string): Promise<void> {
  const store = useBotTeamStore.getState();
  await store.clearMessages(groupId);
  const group = store.groups.find((g) => g.id === groupId);
  if (group) await store.saveGroup({ ...group, memberSessions: {}, needsUser: false });
  store.setPaused(groupId, []);
}
