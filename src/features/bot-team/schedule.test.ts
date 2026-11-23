import { describe, expect, it } from "vitest";
import type { BotRoutine } from "@/lib/ipc";
import {
  MINUTE_MS,
  dueSlot,
  lastSlotBetween,
  nextRunAfter,
  nextRunOf,
  occurrencesBetween,
  startOfWeek,
} from "./schedule";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

function routine(partial: Partial<BotRoutine>): BotRoutine {
  return {
    id: "r1",
    botId: "b1",
    name: "r",
    prompt: "p",
    schedule: { kind: "daily", time: "09:00" },
    engine: "claude",
    workspacePath: "/tmp",
    enabled: true,
    missedPolicy: "run_once",
    createdAt: at(2026, 11, 2, 8, 0),
    updatedAt: 0,
    ...partial,
  };
}

describe("nextRunAfter", () => {
  it("daily picks today when the time is still ahead, else tomorrow", () => {
    const schedule = { kind: "daily" as const, time: "09:00" };
    expect(nextRunAfter(schedule, at(2026, 11, 2, 8, 0))).toBe(at(2026, 11, 2, 9, 0));
    expect(nextRunAfter(schedule, at(2026, 11, 2, 9, 0))).toBe(at(2026, 11, 3, 9, 0));
  });

  it("weekly skips days that are not selected", () => {
    // 2026-11-06 is a Friday; next Monday 09:00 is 11-09.
    const schedule = { kind: "weekly" as const, time: "09:00", weekdays: [1] };
    expect(nextRunAfter(schedule, at(2026, 11, 6, 10, 0))).toBe(at(2026, 11, 9, 9, 0));
  });

  it("returns null for invalid schedules", () => {
    expect(nextRunAfter({ kind: "weekly", time: "09:00", weekdays: [] }, 0)).toBeNull();
    expect(nextRunAfter({ kind: "daily", time: "25:00" }, 0)).toBeNull();
    expect(nextRunAfter({ kind: "interval", everyMinutes: 0 }, 0)).toBeNull();
  });
});

describe("lastSlotBetween / dueSlot", () => {
  it("collapses many missed slots into the latest one", () => {
    const schedule = { kind: "daily" as const, time: "09:00" };
    const anchor = at(2026, 11, 2, 9, 0);
    // Three days later at noon: the latest slot is 11-05 09:00, only once.
    expect(lastSlotBetween(schedule, anchor, at(2026, 11, 5, 12, 0))).toBe(at(2026, 11, 5, 9, 0));
  });

  it("interval slots are multiples of the step from the anchor", () => {
    const schedule = { kind: "interval" as const, everyMinutes: 30 };
    const anchor = at(2026, 11, 2, 9, 0);
    expect(lastSlotBetween(schedule, anchor, anchor + 29 * MINUTE_MS)).toBeNull();
    expect(lastSlotBetween(schedule, anchor, anchor + 95 * MINUTE_MS)).toBe(anchor + 90 * MINUTE_MS);
  });

  it("is due right after the slot and flags slots past the grace period as missed", () => {
    const r = routine({ lastSlotAt: at(2026, 11, 2, 8, 0) });
    expect(dueSlot(r, at(2026, 11, 2, 8, 59))).toBeNull();
    expect(dueSlot(r, at(2026, 11, 2, 9, 0, ))).toEqual({ slotAt: at(2026, 11, 2, 9, 0), missed: false });
    expect(dueSlot(r, at(2026, 11, 2, 9, 30))).toEqual({ slotAt: at(2026, 11, 2, 9, 0), missed: true });
  });

  it("never fires a slot that was already claimed, nor disabled routines", () => {
    const claimed = routine({ lastSlotAt: at(2026, 11, 2, 9, 0) });
    expect(dueSlot(claimed, at(2026, 11, 2, 9, 1))).toBeNull();
    expect(dueSlot(routine({ enabled: false }), at(2026, 11, 3, 9, 0))).toBeNull();
  });
});

describe("nextRunOf / occurrencesBetween", () => {
  it("interval next run follows the claim anchor", () => {
    const anchor = at(2026, 11, 2, 9, 0);
    const r = routine({ schedule: { kind: "interval", everyMinutes: 60 }, lastSlotAt: anchor });
    expect(nextRunOf(r, anchor + 10 * MINUTE_MS)).toBe(anchor + 60 * MINUTE_MS);
    expect(nextRunOf(r, anchor + 60 * MINUTE_MS)).toBe(anchor + 120 * MINUTE_MS);
  });

  it("lists a workday routine five times in a week", () => {
    const r = routine({ schedule: { kind: "weekly", time: "09:00", weekdays: [1, 2, 3, 4, 5] } });
    const week = startOfWeek(at(2026, 11, 4, 12, 0));
    expect(week).toBe(at(2026, 11, 2));
    const list = occurrencesBetween(r, week, week + 7 * 24 * 60 * MINUTE_MS);
    expect(list).toHaveLength(5);
    expect(list[0]).toBe(at(2026, 11, 2, 9, 0));
    expect(list[4]).toBe(at(2026, 11, 6, 9, 0));
  });

  it("disabled routines have no next run", () => {
    expect(nextRunOf(routine({ enabled: false }), at(2026, 11, 2))).toBeNull();
  });
});
