import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { ModalShell } from "@/components/dialogs";
import type { BotConfig, BotRoutine, RoutineSchedule } from "@/lib/ipc";
import { useChatStore } from "@/features/chat/store";
import { engineDisplayName } from "@/features/mission/components/execution-format";
import { defaultEngineFor, defaultWorkspaceFor, newId, usableEngines } from "../runtime";
import { useBotTeamStore } from "../store";
import { fieldClass, labelClass, weekdayName } from "./ui";

/** 新建 / 编辑一个定时任务。`draft` 来自一句话解析时预填，保存前由用户确认。 */
export function RoutineEditor({
  bot,
  routine,
  draft,
  onClose,
}: {
  bot: BotConfig;
  routine: BotRoutine | null;
  draft?: { name: string; prompt: string; schedule: RoutineSchedule } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const saveRoutine = useBotTeamStore((s) => s.saveRoutine);
  const workspaces = useChatStore((s) => s.workspaces);
  const engines = usableEngines();
  const base = routine ?? null;
  const initialSchedule: RoutineSchedule =
    base?.schedule ?? draft?.schedule ?? { kind: "daily", time: "09:00" };

  const [name, setName] = useState(base?.name ?? draft?.name ?? "");
  const [prompt, setPrompt] = useState(base?.prompt ?? draft?.prompt ?? "");
  const [kind, setKind] = useState<RoutineSchedule["kind"]>(initialSchedule.kind);
  const [everyMinutes, setEveryMinutes] = useState(String(initialSchedule.everyMinutes ?? 60));
  const [time, setTime] = useState(initialSchedule.time ?? "09:00");
  const [weekdays, setWeekdays] = useState<number[]>(initialSchedule.weekdays ?? [1, 2, 3, 4, 5]);
  const [engine, setEngine] = useState(base?.engine ?? defaultEngineFor(bot));
  const [workspacePath, setWorkspacePath] = useState(base?.workspacePath ?? defaultWorkspaceFor(bot));
  const [missedPolicy, setMissedPolicy] = useState<BotRoutine["missedPolicy"]>(base?.missedPolicy ?? "run_once");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleDay = (day: number) =>
    setWeekdays((days) => (days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort()));

  const submit = async () => {
    setError(null);
    const schedule: RoutineSchedule =
      kind === "interval"
        ? { kind, everyMinutes: Number(everyMinutes) }
        : kind === "daily"
          ? { kind, time }
          : { kind, time, weekdays };
    setSaving(true);
    try {
      await saveRoutine({
        id: base?.id ?? newId("routine"),
        botId: bot.id,
        name,
        prompt,
        schedule,
        engine,
        workspacePath,
        model: base?.model ?? null,
        providerId: base?.providerId ?? null,
        enabled: base?.enabled ?? true,
        missedPolicy,
        createdAt: base?.createdAt ?? 0,
        updatedAt: base?.updatedAt ?? 0,
        lastSlotAt: base?.lastSlotAt ?? null,
        lastRunAt: base?.lastRunAt ?? null,
        lastStatus: base?.lastStatus ?? null,
        lastError: base?.lastError ?? null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const workspaceKnown = workspaces.some((w) => w.path === workspacePath);

  return (
    <ModalShell
      onClose={onClose}
      label={routine ? t("botTeam.editRoutine") : t("botTeam.newRoutine")}
      className="w-[min(560px,calc(100vw-2rem))] p-6"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <h2 className="text-title-3-medium text-text-primary">
          {routine ? t("botTeam.editRoutine") : t("botTeam.newRoutine")}
          <span className="ml-2 text-body-2-regular text-text-tertiary">· {bot.name}</span>
        </h2>
        <label className="block">
          <span className={labelClass}>{t("botTeam.routineName")}</span>
          <input className={fieldClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("botTeam.routinePrompt")}</span>
          <textarea
            className={`${fieldClass} min-h-24 resize-y`}
            value={prompt}
            maxLength={10_000}
            rows={4}
            placeholder={t("botTeam.routinePromptPlaceholder")}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelClass}>{t("botTeam.frequency")}</span>
            <select className={fieldClass} value={kind} onChange={(e) => setKind(e.target.value as RoutineSchedule["kind"])}>
              <option value="interval">{t("botTeam.kindInterval")}</option>
              <option value="daily">{t("botTeam.kindDaily")}</option>
              <option value="weekly">{t("botTeam.kindWeekly")}</option>
            </select>
          </label>
          {kind === "interval" ? (
            <label className="block">
              <span className={labelClass}>{t("botTeam.intervalMinutes")}</span>
              <input
                className={fieldClass}
                type="number"
                min={5}
                max={10080}
                value={everyMinutes}
                onChange={(e) => setEveryMinutes(e.target.value)}
              />
            </label>
          ) : (
            <label className="block">
              <span className={labelClass}>{t("botTeam.time")}</span>
              <input className={fieldClass} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          )}
        </div>
        {kind === "weekly" && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("botTeam.weekdays")}>
            {[1, 2, 3, 4, 5, 6, 0].map((day) => (
              <button
                key={day}
                type="button"
                aria-pressed={weekdays.includes(day)}
                onClick={() => toggleDay(day)}
                className={
                  "cursor-pointer rounded-md border px-2.5 py-1 text-caption-1-medium transition-colors duration-150 " +
                  (weekdays.includes(day)
                    ? "border-button-primary bg-status-blue-background/20 text-button-primary"
                    : "border-border-button-default text-text-secondary hover:bg-background-secondary-hover")
                }
              >
                {weekdayName(t, day)}
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelClass}>{t("botTeam.engine")}</span>
            <select className={fieldClass} value={engine} onChange={(e) => setEngine(e.target.value)}>
              {!engines.some((e) => e.id === engine) && <option value={engine}>{engineDisplayName(engine)}</option>}
              {engines.map((info) => (
                <option key={info.id} value={info.id}>
                  {engineDisplayName(info.id)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelClass}>{t("botTeam.missedPolicy")}</span>
            <select
              className={fieldClass}
              value={missedPolicy}
              onChange={(e) => setMissedPolicy(e.target.value as BotRoutine["missedPolicy"])}
            >
              <option value="run_once">{t("botTeam.missedRunOnce")}</option>
              <option value="skip">{t("botTeam.missedSkip")}</option>
            </select>
          </label>
        </div>
        <label className="block">
          <span className={labelClass}>{t("botTeam.workspace")}</span>
          <select className={fieldClass} value={workspacePath} onChange={(e) => setWorkspacePath(e.target.value)}>
            {!workspaceKnown && <option value={workspacePath}>{workspacePath || t("botTeam.pickWorkspace")}</option>}
            {workspaces.map((w) => (
              <option key={w.id} value={w.path}>
                {w.name} — {w.path}
              </option>
            ))}
          </select>
        </label>
        <p className="text-caption-1-regular text-text-tertiary">
          {t(`botTeam.permissionNote_${bot.runtime.permissionMode}`)}
        </p>
        {error && <p className="text-caption-1-regular text-status-rose-text">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button size="small" variant="secondary" type="button" onClick={onClose}>
            {t("botTeam.cancel")}
          </Button>
          <Button
            size="small"
            type="submit"
            disabled={saving || !name.trim() || !prompt.trim() || !workspacePath}
          >
            {t("botTeam.save")}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}
