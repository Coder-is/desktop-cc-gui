import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { Button } from "@/components/base/buttons/button";
import { BotAvatarView } from "@/features/bots/bot-avatar";
import { useBotStore } from "@/features/bots/bot-store";
import { dayStart, occurrencesBetween, startOfWeek } from "../schedule";
import { useBotTeamStore } from "../store";
import { formatTime, weekdayName } from "./ui";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 周日历：所有启用的定时任务在这一周的计划时刻。点一项跳到对应 Bot。 */
export function CalendarView() {
  const { t } = useTranslation();
  const routines = useBotTeamStore((s) => s.routines);
  const select = useBotTeamStore((s) => s.select);
  const bots = useBotStore((s) => s.bots);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(Date.now()));

  const days = useMemo(() => {
    const out = Array.from({ length: 7 }, (_, i) => ({
      start: dayStart(weekStart, i),
      items: [] as { at: number; routineId: string; botId: string; name: string }[],
    }));
    const weekEnd = dayStart(weekStart, 7);
    for (const routine of routines) {
      for (const at of occurrencesBetween(routine, weekStart, weekEnd, 60)) {
        const index = out.findIndex((d, i) => at >= d.start && at < (out[i + 1]?.start ?? weekEnd));
        if (index >= 0) out[index].items.push({ at, routineId: routine.id, botId: routine.botId, name: routine.name });
      }
    }
    for (const day of out) day.items.sort((a, b) => a.at - b.at);
    return out;
  }, [routines, weekStart]);

  const today = startOfWeek(Date.now()) === weekStart ? new Date().setHours(0, 0, 0, 0) : null;
  const label = `${new Date(weekStart).toLocaleDateString()} – ${new Date(dayStart(weekStart, 6)).toLocaleDateString()}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-separator-border px-5 py-3">
        <span className="flex-1 text-body-medium text-text-primary">{t("botTeam.calendar")}</span>
        <Button
          size="small"
          variant="ghost"
          iconOnly
          leadingIcon={ChevronLeft}
          aria-label={t("botTeam.prevWeek")}
          onClick={() => setWeekStart((w) => startOfWeek(w - DAY_MS))}
        />
        <span className="min-w-44 text-center text-caption-1-medium text-text-secondary">{label}</span>
        <Button
          size="small"
          variant="ghost"
          iconOnly
          leadingIcon={ChevronRight}
          aria-label={t("botTeam.nextWeek")}
          onClick={() => setWeekStart((w) => startOfWeek(dayStart(w, 7) + 1))}
        />
        <Button size="small" variant="secondary" onClick={() => setWeekStart(startOfWeek(Date.now()))}>
          {t("botTeam.thisWeek")}
        </Button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-7 divide-x divide-separator-border overflow-y-auto">
        {days.map((day) => {
          const date = new Date(day.start);
          return (
            <section key={day.start} className="min-w-0 px-1.5 py-2" aria-label={date.toLocaleDateString()}>
              <h3
                className={
                  "mb-2 text-center text-caption-1-medium " +
                  (today === day.start ? "text-button-primary" : "text-text-tertiary")
                }
              >
                {weekdayName(t, date.getDay())} {date.getMonth() + 1}/{date.getDate()}
              </h3>
              <ul className="space-y-1">
                {day.items.map((item) => {
                  const bot = bots.find((b) => b.id === item.botId);
                  return (
                    <li key={`${item.routineId}-${item.at}`}>
                      <button
                        type="button"
                        onClick={() => select({ kind: "bot", id: item.botId })}
                        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md bg-background-secondary-default px-1.5 py-1 text-left transition-colors hover:bg-background-secondary-hover"
                        title={`${bot?.name ?? ""} · ${item.name}`}
                      >
                        <BotAvatarView avatar={bot?.avatar} seed={item.botId} size={16} title={bot?.name} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-caption-1-medium text-text-secondary">{formatTime(item.at)}</span>
                          <span className="block truncate text-caption-1-regular text-text-primary">{item.name}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
