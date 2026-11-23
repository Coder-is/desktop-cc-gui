import { create } from "zustand";
import {
  ipc,
  type BotGroup,
  type BotGroupMessage,
  type BotRoutine,
  type BotRoutineRun,
} from "@/lib/ipc";

/**
 * Bot 团队（内测）的状态：中心页签开关、定时任务、群聊、运行中的轮次。
 *
 * 持久数据都在后端（bot_team.rs），这里是视图缓存；所有写操作先落盘、
 * 成功后再改内存，失败原样抛给调用方展示，不假装成功。
 */

export const BOT_TEAM_TAB_KEY = "bot-team:main";

export type BotTeamSelection =
  | { kind: "bot"; id: string }
  | { kind: "group"; id: string }
  | { kind: "calendar" };

export interface RunningRoutine {
  runId: string;
  interrupt: () => void;
}

interface BotTeamStoreState {
  open: boolean;
  active: boolean;
  openTab: () => void;
  activate: () => void;
  deactivate: () => void;
  close: () => void;

  loaded: boolean;
  loadError: string | null;
  routines: BotRoutine[];
  groups: BotGroup[];
  selection: BotTeamSelection | null;
  select: (selection: BotTeamSelection | null) => void;

  runsByRoutine: Record<string, BotRoutineRun[]>;
  /** 正在执行的定时任务（routine id → 句柄）。 */
  running: Record<string, RunningRoutine>;
  messagesByGroup: Record<string, BotGroupMessage[]>;
  /** 正在轮转的群聊（group id → 正在发言的成员 id，null = 轮转中但无人在说）。 */
  groupSpeaking: Record<string, string | null>;
  /** 被「@x 停」暂停的成员（group id → bot ids）；只存在内存里。 */
  pausedByGroup: Record<string, string[]>;

  load: () => Promise<void>;
  saveRoutine: (routine: BotRoutine) => Promise<BotRoutine>;
  deleteRoutine: (id: string) => Promise<void>;
  replaceRoutine: (routine: BotRoutine) => void;
  loadRuns: (routineId: string) => Promise<void>;
  upsertRun: (run: BotRoutineRun) => void;
  setRunning: (routineId: string, handle: RunningRoutine | null) => void;

  saveGroup: (group: BotGroup) => Promise<BotGroup>;
  deleteGroup: (id: string) => Promise<void>;
  loadMessages: (groupId: string) => Promise<void>;
  appendMessages: (groupId: string, messages: BotGroupMessage[]) => void;
  clearMessages: (groupId: string) => Promise<void>;
  setSpeaking: (groupId: string, speaking: string | null | undefined) => void;
  setPaused: (groupId: string, botIds: string[]) => void;
}

/** 同一时刻只有一次 load 在飞。 */
let loadInFlight: Promise<void> | null = null;

export const useBotTeamStore = create<BotTeamStoreState>()((set, get) => ({
  open: false,
  active: false,
  openTab: () => set({ open: true, active: true }),
  activate: () => set({ active: true }),
  deactivate: () => {
    if (!get().active) return;
    set({ active: false });
  },
  close: () => set({ open: false, active: false }),

  loaded: false,
  loadError: null,
  routines: [],
  groups: [],
  selection: null,
  select: (selection) => set({ selection }),

  runsByRoutine: {},
  running: {},
  messagesByGroup: {},
  groupSpeaking: {},
  pausedByGroup: {},

  load: () => {
    if (loadInFlight) return loadInFlight;
    const p = ipc
      .botTeamLoad()
      .then((state) => set({ routines: state.routines, groups: state.groups, loaded: true, loadError: null }))
      .catch((error: unknown) => {
        set({ loaded: true, loadError: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        loadInFlight = null;
      });
    loadInFlight = p;
    return p;
  },

  saveRoutine: async (routine) => {
    const saved = await ipc.botRoutineSave(routine);
    get().replaceRoutine(saved);
    return saved;
  },
  deleteRoutine: async (id) => {
    get().running[id]?.interrupt();
    await ipc.botRoutineDelete(id);
    set((s) => {
      const runsByRoutine = { ...s.runsByRoutine };
      delete runsByRoutine[id];
      return { routines: s.routines.filter((r) => r.id !== id), runsByRoutine };
    });
  },
  replaceRoutine: (routine) =>
    set((s) => {
      const exists = s.routines.some((r) => r.id === routine.id);
      return {
        routines: exists
          ? s.routines.map((r) => (r.id === routine.id ? routine : r))
          : [...s.routines, routine],
      };
    }),
  loadRuns: async (routineId) => {
    const runs = await ipc.botRoutineRuns(routineId);
    set((s) => ({ runsByRoutine: { ...s.runsByRoutine, [routineId]: runs } }));
  },
  upsertRun: (run) =>
    set((s) => {
      const list = s.runsByRoutine[run.routineId] ?? [];
      const next = list.some((r) => r.id === run.id)
        ? list.map((r) => (r.id === run.id ? run : r))
        : [...list, run];
      return { runsByRoutine: { ...s.runsByRoutine, [run.routineId]: next } };
    }),
  setRunning: (routineId, handle) =>
    set((s) => {
      const running = { ...s.running };
      if (handle) running[routineId] = handle;
      else delete running[routineId];
      return { running };
    }),

  saveGroup: async (group) => {
    const saved = await ipc.botGroupSave(group);
    set((s) => {
      const exists = s.groups.some((g) => g.id === saved.id);
      return {
        groups: exists ? s.groups.map((g) => (g.id === saved.id ? saved : g)) : [...s.groups, saved],
      };
    });
    return saved;
  },
  deleteGroup: async (id) => {
    await ipc.botGroupDelete(id);
    set((s) => {
      const messagesByGroup = { ...s.messagesByGroup };
      delete messagesByGroup[id];
      const selection =
        s.selection?.kind === "group" && s.selection.id === id ? null : s.selection;
      return { groups: s.groups.filter((g) => g.id !== id), messagesByGroup, selection };
    });
  },
  loadMessages: async (groupId) => {
    const messages = await ipc.botGroupMessages(groupId);
    set((s) => ({ messagesByGroup: { ...s.messagesByGroup, [groupId]: messages } }));
  },
  appendMessages: (groupId, messages) =>
    set((s) => {
      const list = s.messagesByGroup[groupId] ?? [];
      const byId = new Map(list.map((m) => [m.id, m] as const));
      for (const message of messages) byId.set(message.id, message);
      return { messagesByGroup: { ...s.messagesByGroup, [groupId]: [...byId.values()] } };
    }),
  clearMessages: async (groupId) => {
    await ipc.botGroupMessagesClear(groupId);
    set((s) => ({ messagesByGroup: { ...s.messagesByGroup, [groupId]: [] } }));
  },
  setSpeaking: (groupId, speaking) =>
    set((s) => {
      const groupSpeaking = { ...s.groupSpeaking };
      if (speaking === undefined) delete groupSpeaking[groupId];
      else groupSpeaking[groupId] = speaking;
      return { groupSpeaking };
    }),
  setPaused: (groupId, botIds) =>
    set((s) => ({ pausedByGroup: { ...s.pausedByGroup, [groupId]: botIds } })),
}));
