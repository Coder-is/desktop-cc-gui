import type { TFunction } from "i18next";
import type { RoutineSchedule } from "@/lib/ipc";

/** Bot 团队界面共用的样式与格式化。 */

export const fieldClass =
  "mt-1 w-full rounded-md border border-border-button-default bg-background-primary-default px-2 py-1.5 text-body-2-regular text-text-primary outline-none focus:border-status-blue-text/60 disabled:opacity-60";

export const labelClass = "text-caption-1-medium text-text-secondary";

export function weekdayName(t: TFunction, day: number): string {
  return t(`botTeam.weekday${day}`);
}

export function describeSchedule(t: TFunction, schedule: RoutineSchedule): string {
  if (schedule.kind === "interval") {
    const minutes = schedule.everyMinutes ?? 0;
    if (minutes % 60 === 0) return t("botTeam.everyHours", { n: minutes / 60 });
    return t("botTeam.everyMinutes", { n: minutes });
  }
  if (schedule.kind === "daily") return t("botTeam.dailyAt", { time: schedule.time ?? "" });
  const days = schedule.weekdays ?? [];
  const workdays = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
  const label = workdays
    ? t("botTeam.workdays")
    : days.map((d) => weekdayName(t, d)).join("、");
  return t("botTeam.weeklyAt", { days: label, time: schedule.time ?? "" });
}

export function formatDateTime(at: number | null | undefined): string {
  if (!at) return "—";
  return new Date(at).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
