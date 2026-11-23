import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Play from "lucide-react/dist/esm/icons/play";
import Plus from "lucide-react/dist/esm/icons/plus";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import Square from "lucide-react/dist/esm/icons/square";
import { Button } from "@/components/base/buttons/button";
import { ConfirmDialog } from "@/components/dialogs";
import type { BotConfig, BotRoutine, RoutineSchedule } from "@/lib/ipc";
import { BotAvatarView } from "@/features/bots/bot-avatar";
import { useBotStore } from "@/features/bots/bot-store";
import { runParseTurn } from "../agent-run";
import { buildParsePrompt, parseRoutineDraft } from "../parse-routine";
import { cancelRoutine, defaultEngineFor, runRoutine, usableEngines } from "../runtime";
import { nextRunOf } from "../schedule";
import { useBotTeamStore } from "../store";
import { RoutineEditor } from "./RoutineEditor";
import { describeSchedule, formatDateTime } from "./ui";

type EditorState =
  | { routine: BotRoutine | null; draft?: { name: string; prompt: string; schedule: RoutineSchedule } | null }
  | null;

/** 一个 Bot 的详情：一句话创建、定时任务列表、运行记录。 */
export function BotRoutinesView({ bot }: { bot: BotConfig }) {
  const { t } = useTranslation();
  const allRoutines = useBotTeamStore((s) => s.routines);
  const routines = useMemo(() => allRoutines.filter((r) => r.botId === bot.id), [allRoutines, bot.id]);
  const [editor, setEditor] = useState<EditorState>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-separator-border px-5 py-3">
        <BotAvatarView avatar={bot.avatar} seed={bot.id} size={36} title={bot.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body-medium text-text-primary">
            {bot.name}
            <span className="ml-2 text-caption-1-regular text-text-tertiary">@{bot.slug}</span>
          </div>
          {(bot.title || bot.description) && (
            <div className="truncate text-caption-1-regular text-text-tertiary">{bot.title || bot.description}</div>
          )}
        </div>
        <Button size="small" variant="secondary" leadingIcon={Plus} onClick={() => setEditor({ routine: null })}>
          {t("botTeam.newRoutine")}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <QuickCreate bot={bot} onDraft={(draft) => setEditor({ routine: null, draft })} />

        <h3 className="mt-5 mb-2 text-caption-1-medium text-text-tertiary">{t("botTeam.routines")}</h3>
        {routines.length === 0 ? (
          <p className="rounded-md border border-dashed border-separator-border px-4 py-6 text-center text-body-2-regular text-text-tertiary">
            {t("botTeam.noRoutines")}
          </p>
        ) : (
          <ul className="space-y-2">
            {routines.map((routine) => (
              <RoutineRow
                key={routine.id}
                routine={routine}
                expanded={expanded === routine.id}
                onToggleExpand={() => setExpanded((id) => (id === routine.id ? null : routine.id))}
                onEdit={() => setEditor({ routine })}
              />
            ))}
          </ul>
        )}
      </div>

      {editor && (
        <RoutineEditor bot={bot} routine={editor.routine} draft={editor.draft} onClose={() => setEditor(null)} />
      )}
    </div>
  );
}

function QuickCreate({
  bot,
  onDraft,
}: {
  bot: BotConfig;
  onDraft: (draft: { name: string; prompt: string; schedule: RoutineSchedule }) => void;
}) {
  const { t } = useTranslation();
  const bots = useBotStore((s) => s.bots);
  const [sentence, setSentence] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const text = sentence.trim();
    if (!text || busy) return;
    const engine = defaultEngineFor(bot);
    if (!usableEngines().some((e) => e.id === engine)) {
      setError(t("botTeam.noEngine"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const prompt = buildParsePrompt(
        text,
        bots.filter((b) => !b.hidden).map((b) => ({ slug: b.slug, name: b.name, description: b.description })),
        new Date(),
      );
      const result = await runParseTurn({ engine, prompt, model: bot.runtime.model ?? null, providerId: null }).promise;
      const draft = parseRoutineDraft(result.text);
      // 模型挑了别的 Bot 也只作参考：草稿挂在当前 Bot 上，由用户确认。
      onDraft({ name: draft.name, prompt: draft.prompt, schedule: draft.schedule });
      setSentence("");
    } catch (err) {
      console.warn("[bot-team] parse failed", err);
      setError(t("botTeam.parseFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="rounded-lg border border-border-button-default bg-background-primary-default p-2 shadow-xs focus-within:border-status-blue-text/60"
    >
      <label htmlFor="bot-team-quick-create" className="sr-only">
        {t("botTeam.quickCreate")}
      </label>
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
        <input
          id="bot-team-quick-create"
          value={sentence}
          maxLength={500}
          disabled={busy}
          onChange={(e) => setSentence(e.target.value)}
          placeholder={t("botTeam.quickCreatePlaceholder")}
          className="min-w-0 flex-1 bg-transparent text-body-2-regular text-text-primary outline-none placeholder:text-text-placeholder disabled:opacity-60"
        />
        <Button size="small" type="submit" disabled={busy || !sentence.trim()}>
          {busy ? t("botTeam.parsing") : t("botTeam.quickCreateSubmit")}
        </Button>
      </div>
      {error && <p className="mt-1 px-6 text-caption-1-regular text-status-rose-text">{error}</p>}
    </form>
  );
}

function statusLabel(t: (key: string) => string, status: string | null | undefined): string {
  switch (status) {
    case "ok":
      return t("botTeam.statusOk");
    case "error":
      return t("botTeam.statusError");
    case "cancelled":
      return t("botTeam.statusCancelled");
    case "running":
      return t("botTeam.statusRunning");
    default:
      return t("botTeam.statusNever");
  }
}

function statusClass(status: string | null | undefined): string {
  if (status === "ok") return "text-status-green-text";
  if (status === "error") return "text-status-rose-text";
  if (status === "running") return "text-status-blue-text";
  return "text-text-tertiary";
}

function RoutineRow({
  routine,
  expanded,
  onToggleExpand,
  onEdit,
}: {
  routine: BotRoutine;
  expanded: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const running = useBotTeamStore((s) => Boolean(s.running[routine.id]));
  const saveRoutine = useBotTeamStore((s) => s.saveRoutine);
  const deleteRoutine = useBotTeamStore((s) => s.deleteRoutine);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const next = nextRunOf(routine, Date.now());

  const toggleEnabled = async () => {
    setError(null);
    try {
      await saveRoutine({ ...routine, enabled: !routine.enabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async () => {
    setError(null);
    try {
      await deleteRoutine(routine.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <li className="rounded-lg border border-separator-border bg-background-primary-default">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-body-2-medium text-text-primary">{routine.name}</span>
            {!routine.enabled && (
              <span className="rounded-sm border border-border-button-default px-1.5 text-caption-1-medium text-text-tertiary">
                {t("botTeam.paused")}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-caption-1-regular text-text-tertiary">
            <span>{describeSchedule(t, routine.schedule)}</span>
            <span>{t("botTeam.nextRun", { time: formatDateTime(next) })}</span>
            <span className={statusClass(running ? "running" : routine.lastStatus)}>
              {statusLabel(t, running ? "running" : routine.lastStatus)}
              {routine.lastRunAt && !running ? ` · ${formatDateTime(routine.lastRunAt)}` : ""}
            </span>
          </div>
          {routine.lastStatus === "error" && routine.lastError && !running && (
            <div className="mt-1 line-clamp-2 text-caption-1-regular text-status-rose-text">{routine.lastError}</div>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {running ? (
            <Button size="small" variant="secondary" leadingIcon={Square} onClick={() => cancelRoutine(routine.id)}>
              {t("botTeam.stop")}
            </Button>
          ) : (
            <Button size="small" variant="secondary" leadingIcon={Play} onClick={() => void runRoutine(routine, "manual")}>
              {t("botTeam.runNow")}
            </Button>
          )}
          <Button size="small" variant="ghost" onClick={() => void toggleEnabled()}>
            {routine.enabled ? t("botTeam.pause") : t("botTeam.resume")}
          </Button>
          <Button size="small" variant="ghost" onClick={onEdit}>
            {t("botTeam.edit")}
          </Button>
          <Button size="small" variant="ghost" onClick={() => setConfirmDelete(true)}>
            {t("botTeam.delete")}
          </Button>
        </div>
      </div>
      {error && <p className="px-3 pb-2 text-caption-1-regular text-status-rose-text">{error}</p>}
      {expanded && <RunHistory routineId={routine.id} />}
      {confirmDelete && (
        <ConfirmDialog
          danger
          message={t("botTeam.confirmDeleteRoutine", { name: routine.name })}
          confirmLabel={t("botTeam.delete")}
          onConfirm={() => {
            setConfirmDelete(false);
            void remove();
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </li>
  );
}

function RunHistory({ routineId }: { routineId: string }) {
  const { t } = useTranslation();
  const runs = useBotTeamStore((s) => s.runsByRoutine[routineId]);
  const loadRuns = useBotTeamStore((s) => s.loadRuns);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRuns(routineId).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [routineId, loadRuns]);

  const ordered = useMemo(() => [...(runs ?? [])].sort((a, b) => b.startedAt - a.startedAt), [runs]);

  return (
    <div className="border-t border-separator-border px-3 py-2">
      <h4 className="mb-1.5 text-caption-1-medium text-text-tertiary">{t("botTeam.history")}</h4>
      {error && <p className="text-caption-1-regular text-status-rose-text">{error}</p>}
      {!error && ordered.length === 0 && (
        <p className="text-caption-1-regular text-text-tertiary">{runs ? t("botTeam.noRuns") : t("botTeam.loading")}</p>
      )}
      <ul className="space-y-2">
        {ordered.map((run) => (
          <li key={run.id} className="rounded-md bg-background-secondary-default px-2.5 py-2">
            <div className="flex flex-wrap gap-x-3 text-caption-1-regular text-text-tertiary">
              <span>{formatDateTime(run.startedAt)}</span>
              <span>{t(`botTeam.trigger_${run.trigger}`)}</span>
              <span className={statusClass(run.status)}>{statusLabel(t, run.status)}</span>
            </div>
            {run.error && <p className="mt-1 text-caption-1-regular text-status-rose-text">{run.error}</p>}
            {run.output && (
              <p className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-body-2-regular text-text-primary select-text">
                {run.output}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
