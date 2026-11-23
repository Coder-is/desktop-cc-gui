import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days";
import Info from "lucide-react/dist/esm/icons/info";
import Plus from "lucide-react/dist/esm/icons/plus";
import UsersRound from "lucide-react/dist/esm/icons/users-round";
import { Button } from "@/components/base/buttons/button";
import { ModalShell } from "@/components/dialogs";
import { BotAvatarView } from "@/features/bots/bot-avatar";
import { useBotStore, visibleBots } from "@/features/bots/bot-store";
import { useBotTeamStore, type BotTeamSelection } from "../store";
import { BotRoutinesView } from "./BotRoutinesView";
import { CalendarView } from "./CalendarView";
import { GroupChatView } from "./GroupChatView";
import { GroupEditor } from "./GroupEditor";

function same(a: BotTeamSelection | null, b: BotTeamSelection): boolean {
  if (!a || a.kind !== b.kind) return false;
  return a.kind === "calendar" || (b.kind !== "calendar" && a.id === b.id);
}

/**
 * Bot 团队（内测中心页签）：左侧像通讯录一样列出 Bot 与群聊，右侧是
 * Bot 的定时任务 / 群聊窗口 / 周日历。
 */
export function BotTeamPane() {
  const { t } = useTranslation();
  const allBots = useBotStore((s) => s.bots);
  const botsLoaded = useBotStore((s) => s.loaded);
  const refreshBots = useBotStore((s) => s.refresh);
  const bots = useMemo(() => visibleBots(allBots), [allBots]);
  const { routines, groups, selection, select, running, groupSpeaking, load, loadError, loaded } = useBotTeamStore(
    useShallow((s) => ({
      routines: s.routines,
      groups: s.groups,
      selection: s.selection,
      select: s.select,
      running: s.running,
      groupSpeaking: s.groupSpeaking,
      load: s.load,
      loadError: s.loadError,
      loaded: s.loaded,
    })),
  );
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  useEffect(() => {
    void load();
    if (!botsLoaded) void refreshBots();
  }, [load, botsLoaded, refreshBots]);

  const routineCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const routine of routines) counts.set(routine.botId, (counts.get(routine.botId) ?? 0) + 1);
    return counts;
  }, [routines]);
  const runningBots = useMemo(() => {
    const ids = new Set<string>();
    for (const routine of routines) if (running[routine.id]) ids.add(routine.botId);
    return ids;
  }, [routines, running]);

  const selectedBot = selection?.kind === "bot" ? allBots.find((b) => b.id === selection.id) ?? null : null;
  const selectedGroup = selection?.kind === "group" ? groups.find((g) => g.id === selection.id) ?? null : null;

  const rowClass = (active: boolean) =>
    "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 " +
    (active ? "bg-background-secondary-default" : "hover:bg-background-secondary-hover");

  return (
    <div className="flex h-full min-h-0 bg-background-primary-default">
      <aside className="flex w-64 shrink-0 flex-col border-r border-separator-border">
        <header className="flex items-center gap-2 px-3 py-3">
          <UsersRound className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
          <span className="flex-1 text-body-medium text-text-primary">{t("botTeam.title")}</span>
          <span className="rounded-sm border border-border-button-default px-1.5 py-0.5 text-caption-1-medium text-text-tertiary">
            {t("botTeam.betaTag")}
          </span>
          <Button
            size="xs"
            variant="ghost"
            iconOnly
            leadingIcon={Info}
            aria-label={t("botTeam.about")}
            onClick={() => setAboutOpen(true)}
          />
        </header>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label={t("botTeam.title")}>
          <button
            type="button"
            className={rowClass(same(selection, { kind: "calendar" }))}
            onClick={() => select({ kind: "calendar" })}
          >
            <CalendarDays className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
            <span className="flex-1 text-body-2-regular text-text-primary">{t("botTeam.calendar")}</span>
          </button>

          <div className="mt-3 mb-1 flex items-center justify-between px-2">
            <span className="text-caption-1-medium text-text-tertiary">{t("botTeam.groups")}</span>
            <Button
              size="xs"
              variant="ghost"
              iconOnly
              leadingIcon={Plus}
              aria-label={t("botTeam.newGroup")}
              onClick={() => setCreatingGroup(true)}
            />
          </div>
          {groups.length === 0 && (
            <p className="px-2 py-1 text-caption-1-regular text-text-tertiary">{t("botTeam.noGroups")}</p>
          )}
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className={rowClass(same(selection, { kind: "group", id: group.id }))}
              onClick={() => select({ kind: "group", id: group.id })}
            >
              <UsersRound className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-body-2-regular text-text-primary">{group.name}</span>
              {groupSpeaking[group.id] !== undefined && (
                <span className="size-2 shrink-0 rounded-full bg-status-blue-text" aria-label={t("botTeam.statusRunning")} />
              )}
              {group.needsUser && (
                <span className="rounded-sm bg-status-rose-background px-1 text-caption-1-medium text-status-rose-text">
                  {t("botTeam.needsYouShort")}
                </span>
              )}
            </button>
          ))}

          <div className="mt-3 mb-1 px-2 text-caption-1-medium text-text-tertiary">{t("botTeam.bots")}</div>
          {botsLoaded && bots.length === 0 && (
            <p className="px-2 py-1 text-caption-1-regular text-text-tertiary">{t("botTeam.noBots")}</p>
          )}
          {bots.map((bot) => (
            <button
              key={bot.id}
              type="button"
              className={rowClass(same(selection, { kind: "bot", id: bot.id }))}
              onClick={() => select({ kind: "bot", id: bot.id })}
            >
              <BotAvatarView avatar={bot.avatar} seed={bot.id} size={24} title={bot.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-2-regular text-text-primary">{bot.name}</span>
                {bot.title && <span className="block truncate text-caption-1-regular text-text-tertiary">{bot.title}</span>}
              </span>
              {runningBots.has(bot.id) && (
                <span className="size-2 shrink-0 rounded-full bg-status-blue-text" aria-label={t("botTeam.statusRunning")} />
              )}
              {(routineCount.get(bot.id) ?? 0) > 0 && (
                <span className="rounded-sm bg-background-secondary-default px-1.5 text-caption-1-medium text-text-secondary">
                  {routineCount.get(bot.id)}
                </span>
              )}
            </button>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        {loadError && (
          <p className="border-b border-separator-border px-5 py-2 text-caption-1-regular text-status-rose-text">
            {t("botTeam.loadFailed", { error: loadError })}
          </p>
        )}
        {selection?.kind === "calendar" && <CalendarView />}
        {selectedBot && <BotRoutinesView key={selectedBot.id} bot={selectedBot} />}
        {selectedGroup && <GroupChatView key={selectedGroup.id} group={selectedGroup} />}
        {!selectedBot && !selectedGroup && selection?.kind !== "calendar" && loaded && (
          <div className="flex h-full items-center justify-center px-8">
            <div className="max-w-md text-center">
              <UsersRound className="mx-auto size-8 text-foreground-icon-secondary" aria-hidden />
              <p className="mt-3 text-body-2-regular text-text-secondary">{t("botTeam.emptyHint")}</p>
            </div>
          </div>
        )}
      </main>

      {creatingGroup && <GroupEditor group={null} onClose={() => setCreatingGroup(false)} />}
      {aboutOpen && (
        <ModalShell
          onClose={() => setAboutOpen(false)}
          label={t("botTeam.about")}
          className="w-[min(580px,calc(100vw-2rem))] p-6"
        >
          <h2 className="text-title-3-medium text-text-primary">{t("botTeam.aboutTitle")}</h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-body-2-regular text-text-secondary">
            <li>{t("botTeam.aboutRoutines")}</li>
            <li>{t("botTeam.aboutGroups")}</li>
            <li>{t("botTeam.aboutPermissions")}</li>
            <li>{t("botTeam.aboutStorage")}</li>
          </ul>
          <div className="mt-5 flex justify-end">
            <Button size="small" onClick={() => setAboutOpen(false)}>
              {t("botTeam.close")}
            </Button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
