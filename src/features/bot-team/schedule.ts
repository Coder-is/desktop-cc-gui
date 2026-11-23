import type { BotRoutine, RoutineSchedule } from "@/lib/ipc";

/**
 * 定时任务的时间计算（纯函数，本地时区）。
 *
 * 三种计划：
 *  - interval：从锚点（上次认领的时刻）起每隔 N 分钟
 *  - daily：每天 HH:MM
 *  - weekly：每周选中的几天 HH:MM（0=周日）
 *
 * 调度器每次 tick 用 `dueSlot` 判断：上次认领之后是否已经过了至少一个计划
 * 时刻；过了就取「不晚于现在的最后一个时刻」——错过多次也只算一次（计划
 * §10：最多补跑一次）。离现在超过 `MISSED_GRACE_MS` 的时刻算「错过」，由
 * missedPolicy 决定补跑还是跳过。
 */

export const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** 计划时刻之后这么久还没执行，就算「错过」（客户端当时没开 / 睡眠）。 */
export const MISSED_GRACE_MS = 2 * MINUTE_MS;

function parseTime(time: string | undefined): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h < 24 && m < 60 ? { h, m } : null;
}

/** 某天（取 `day` 所在本地日期）的 HH:MM 时刻。 */
function atTime(day: number, h: number, m: number): number {
  const date = new Date(day);
  date.setHours(h, m, 0, 0);
  return date.getTime();
}

function dayMatches(schedule: RoutineSchedule, at: number): boolean {
  if (schedule.kind !== "weekly") return true;
  return (schedule.weekdays ?? []).includes(new Date(at).getDay());
}

/** 严格晚于 `after` 的下一个计划时刻；计划无效时为 null。
 *  interval 以 `after` 为锚点（调用方传上次认领的时刻）。 */
export function nextRunAfter(schedule: RoutineSchedule, after: number): number | null {
  if (schedule.kind === "interval") {
    const every = schedule.everyMinutes ?? 0;
    return every > 0 ? after + every * MINUTE_MS : null;
  }
  const time = parseTime(schedule.time);
  if (!time) return null;
  if (schedule.kind === "weekly" && (schedule.weekdays ?? []).length === 0) return null;
  // 往后最多看 8 天就一定能找到（weekly 至少有一天）。用逐日 +1 天再按
  // 本地时间重算，夏令时切换日也落在正确的钟点上。
  for (let i = 0; i <= 8; i += 1) {
    const candidate = atTime(after + i * DAY_MS, time.h, time.m);
    if (candidate > after && dayMatches(schedule, candidate)) return candidate;
  }
  return null;
}

/** 不晚于 `now`、且严格晚于 `anchor` 的最后一个计划时刻；没有则 null。 */
export function lastSlotBetween(
  schedule: RoutineSchedule,
  anchor: number,
  now: number,
): number | null {
  if (now <= anchor) return null;
  if (schedule.kind === "interval") {
    const step = (schedule.everyMinutes ?? 0) * MINUTE_MS;
    if (step <= 0) return null;
    const count = Math.floor((now - anchor) / step);
    return count >= 1 ? anchor + count * step : null;
  }
  const time = parseTime(schedule.time);
  if (!time) return null;
  for (let i = 0; i <= 8; i += 1) {
    const candidate = atTime(now - i * DAY_MS, time.h, time.m);
    if (candidate <= anchor) return null;
    if (candidate <= now && dayMatches(schedule, candidate)) return candidate;
  }
  return null;
}

export interface DueSlot {
  slotAt: number;
  /** 计划时刻已过去超过宽限期（客户端当时没在运行）。 */
  missed: boolean;
}

/** 调度器的判定：这个任务现在要不要触发、触发哪个时刻。 */
export function dueSlot(routine: BotRoutine, now: number): DueSlot | null {
  if (!routine.enabled) return null;
  const anchor = routine.lastSlotAt ?? routine.createdAt;
  const slotAt = lastSlotBetween(routine.schedule, anchor, now);
  if (slotAt === null) return null;
  return { slotAt, missed: now - slotAt > MISSED_GRACE_MS };
}

/** 下一次计划执行时间（列表与日历显示用）。 */
export function nextRunOf(routine: BotRoutine, now: number): number | null {
  if (!routine.enabled) return null;
  const anchor = Math.max(routine.lastSlotAt ?? routine.createdAt, now);
  if (routine.schedule.kind === "interval") {
    // interval 以上次认领为锚：下一个时刻 = 锚点后第一个晚于现在的步长点。
    const base = routine.lastSlotAt ?? routine.createdAt;
    const step = (routine.schedule.everyMinutes ?? 0) * MINUTE_MS;
    if (step <= 0) return null;
    const count = Math.max(1, Math.ceil((now - base) / step));
    const next = base + count * step;
    return next > now ? next : next + step;
  }
  return nextRunAfter(routine.schedule, anchor);
}

/** [from, to) 区间内的全部计划时刻（日历周视图），单个任务最多 `limit` 个。 */
export function occurrencesBetween(
  routine: BotRoutine,
  from: number,
  to: number,
  limit = 200,
): number[] {
  if (!routine.enabled || to <= from) return [];
  const out: number[] = [];
  let cursor: number | null;
  if (routine.schedule.kind === "interval") {
    const base = routine.lastSlotAt ?? routine.createdAt;
    const step = (routine.schedule.everyMinutes ?? 0) * MINUTE_MS;
    if (step <= 0) return [];
    const count = Math.max(1, Math.ceil((from - base) / step));
    cursor = base + count * step;
    while (cursor < to && out.length < limit) {
      if (cursor >= from) out.push(cursor);
      cursor += step;
    }
    return out;
  }
  cursor = nextRunAfter(routine.schedule, from - 1);
  while (cursor !== null && cursor < to && out.length < limit) {
    out.push(cursor);
    cursor = nextRunAfter(routine.schedule, cursor);
  }
  return out;
}

/** 本地日期一周的起点（周一 00:00）。 */
export function startOfWeek(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return date.getTime();
}

/** 第 i 天（相对 weekStart）的起点；按本地日历加天数，避开夏令时 23/25 小时日。 */
export function dayStart(weekStart: number, i: number): number {
  const date = new Date(weekStart);
  date.setDate(date.getDate() + i);
  return date.getTime();
}
