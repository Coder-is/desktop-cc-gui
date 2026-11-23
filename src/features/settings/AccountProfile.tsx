import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { Button } from "@/components/base/buttons/button";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import { cx } from "@/utils/cx";
import { ipc, type AccountUsageResponse, type CcplAccountStatus, type CcplMe } from "@/lib/ipc";
import { AccountAvatar, quotaLine } from "./AccountMenu";
import {
  addDays,
  groupByEngine,
  heatmapWeeks,
  localDay,
  monthLabels,
  summarize,
  weeklyTotals,
  type HeatCell,
} from "./account-usage";

/** Emitted by src-tauri usage_stats when a scan of the CLI logs lands. */
const USAGE_CHANGED_EVENT = "usage-stats://changed";
/** The query spans the backend's maximum range, so 累计 covers all history. */
const HISTORY_DAYS = 3650;

type Breakdown = "today" | "7d" | "30d" | "all";
type HeatMode = "day" | "week";

/** Shown in place of a number that is not known yet. */
const PLACEHOLDER = "—";

/** Opacity per heat level over the primary color; level 0 uses the muted surface. */
const LEVEL_OPACITY = [0, 0.3, 0.5, 0.75, 1] as const;

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Avatar, name, @server and today's quota (the profile header). */
export function AccountProfileHeader({ status, me }: { status: CcplAccountStatus; me: CcplMe | null }) {
  const { t } = useTranslation();
  const name = status.username || t("account.unnamed");
  const line = quotaLine(t, me ? { quotaPending: me.quotaPending, dailyLimit: me.dailyLimit, dailySpent: me.dailySpent } : null);
  return (
    <div className="flex flex-col items-center gap-1.5 px-3 py-4">
      <AccountAvatar name={name} size="lg" />
      <span className="mt-1 text-title-3-medium text-text-primary">{name}</span>
      <span className="font-mono text-caption-1-regular text-text-tertiary">@{hostOf(status.baseUrl)}</span>
      {line && (
        <span
          className={cx(
            "text-caption-1-regular",
            me?.quotaPending ? "text-text-error-primary" : "text-text-secondary",
          )}
        >
          {line}
        </span>
      )}
    </div>
  );
}

function useCompact() {
  const { i18n } = useTranslation();
  return useMemo(() => {
    const format = new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 });
    return (value: number) => format.format(value);
  }, [i18n.language]);
}

function money(cost: number | null): string {
  return cost == null ? "—" : `$${cost.toFixed(2)}`;
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-0.5 px-2 py-3">
      <span className="truncate text-body-2-medium text-text-primary">{value}</span>
      <span className="truncate text-caption-1-regular text-text-tertiary">{label}</span>
    </div>
  );
}

function Cell({ level, title, future }: { level: HeatCell["level"]; title: string; future?: boolean }) {
  return (
    <span
      title={title}
      className={cx(
        "size-2.5 shrink-0 rounded-[3px]",
        future ? "opacity-0" : level === 0 ? "bg-background-tertiary-default" : "bg-button-primary",
      )}
      style={level > 0 && !future ? { opacity: LEVEL_OPACITY[level] } : undefined}
    />
  );
}

/**
 * Signed-in usage panel: today / all-time / peak / streaks, a year of daily
 * Token activity, and a CLI → model breakdown — all from the local CLI logs
 * (src-tauri usage_stats), queried on page open and on 刷新. The backend
 * refuses the query while signed out.
 */
export function AccountUsagePanel() {
  const { t } = useTranslation();
  const compact = useCompact();
  const [data, setData] = useState<AccountUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [breakdown, setBreakdown] = useState<Breakdown>("today");
  const [heatMode, setHeatMode] = useState<HeatMode>("day");
  const [today, setToday] = useState(() => localDay(new Date()));

  const refreshAction = useActionFeedback({ spin: true });

  /** Resolves true when the query succeeded (the refresh button's check). */
  const load = useCallback(async (): Promise<boolean> => {
    const now = localDay(new Date());
    setToday(now);
    setLoading(true);
    setError(null);
    try {
      setData(
        await ipc.accountUsageQuery({
          from: addDays(now, -(HISTORY_DAYS - 1)),
          to: now,
          bucket: "day",
          tzOffsetMinutes: -new Date().getTimezoneOffset(),
        }),
      );
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A first visit finds the index empty and a scan running: reload when it lands.
  // Only while the page is open; the listener goes with it.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(USAGE_CHANGED_EVENT, () => void load())
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [load]);

  const rows = data?.rows ?? [];
  // Numbers are only known once a query answered with an index to read: before
  // the first answer, or while the very first scan is still filling an empty
  // index, a "0" would read as "never used" — show a placeholder instead.
  const firstScan = !!data?.scanning && rows.length === 0;
  const known = data !== null && !firstScan;
  const shown = (value: string) => (known ? value : PLACEHOLDER);
  const summary = useMemo(() => summarize(rows, today), [rows, today]);
  const grid = useMemo(() => heatmapWeeks(summary.daily, today), [summary.daily, today]);
  const weeks = useMemo(() => weeklyTotals(grid), [grid]);
  const months = useMemo(() => monthLabels(grid), [grid]);
  const fromDay =
    breakdown === "today" ? today : breakdown === "7d" ? addDays(today, -6) : breakdown === "30d" ? addDays(today, -29) : null;
  const engines = useMemo(() => groupByEngine(rows, fromDay), [rows, fromDay]);
  const engineLabel = (id: string) => t(`settings.engines.${id}`, { defaultValue: id });

  return (
    <div className="flex w-full flex-col gap-5">
      <div className="grid grid-cols-3 divide-x divide-border-secondary rounded-2xl border border-border-secondary sm:grid-cols-6">
        <Stat value={shown(compact(summary.todayTokens))} label={t("account.todayTokens")} />
        <Stat value={shown(money(summary.todayCost))} label={t("account.todayCost")} />
        <Stat value={shown(compact(summary.totalTokens))} label={t("account.totalTokens")} />
        <Stat value={shown(summary.peak ? compact(summary.peak.tokens) : PLACEHOLDER)} label={t("account.peakTokens")} />
        <Stat value={shown(t("account.days", { count: summary.longestStreak }))} label={t("account.longestStreak")} />
        <Stat value={shown(t("account.days", { count: summary.currentStreak }))} label={t("account.currentStreak")} />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <span className="text-body-2-medium text-text-primary">{t("account.activity")}</span>
          <div className="flex items-center gap-1">
            {(["day", "week"] as const).map((mode) => (
              <Button key={mode} size="xs" variant={heatMode === mode ? "primary" : "ghost"} onClick={() => setHeatMode(mode)}>
                {t(mode === "day" ? "account.daily" : "account.weekly")}
              </Button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto px-1">
          <div className="flex w-max flex-col gap-1">
            {heatMode === "day" ? (
              <div className="flex gap-[3px]" role="img" aria-label={t("account.activity")}>
                {grid.map((column) => (
                  <div key={column[0].day} className="flex flex-col gap-[3px]">
                    {column.map((cell) => (
                      <Cell
                        key={cell.day}
                        level={cell.level}
                        future={cell.future}
                        title={t("account.cellTitle", { day: cell.day, tokens: compact(cell.tokens) })}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex gap-[3px]" role="img" aria-label={t("account.activity")}>
                {weeks.map((week) => (
                  <Cell
                    key={week.start}
                    level={week.level}
                    title={t("account.weekTitle", { day: week.start, tokens: compact(week.tokens) })}
                  />
                ))}
              </div>
            )}
            <div className="flex gap-[3px]">
              {months.map((month, i) => (
                <span key={grid[i][0].day} className="w-2.5 shrink-0 overflow-visible whitespace-nowrap text-caption-1-regular text-text-tertiary">
                  {month != null ? t("account.month", { month }) : ""}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <span className="text-body-2-medium text-text-primary">{t("account.byCli")}</span>
          <div className="flex items-center gap-1">
            {(["today", "7d", "30d", "all"] as const).map((r) => (
              <Button key={r} size="xs" variant={breakdown === r ? "primary" : "ghost"} onClick={() => setBreakdown(r)}>
                {t(`account.range_${r}`)}
              </Button>
            ))}
          </div>
        </div>
        {engines.length === 0 ? (
          <p className="rounded-2xl border border-border-secondary px-4 py-6 text-center text-body-2-regular text-text-tertiary">
            {data === null ? (loading ? t("account.loading") : PLACEHOLDER) : data.scanning ? t("account.scanning") : t("account.noUsage")}
          </p>
        ) : (
          <div className="flex flex-col rounded-2xl border border-border-secondary">
            {engines.map((engine, index) => (
              <div key={engine.engine} className={cx("flex flex-col px-4 py-3", index > 0 && "border-t border-border-secondary")}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-body-2-medium text-text-primary">{engineLabel(engine.engine)}</span>
                  <span className="font-mono text-body-2-regular text-text-primary">
                    {t("account.usageLine", {
                      tokens: compact(engine.tokens),
                      requests: engine.requests.toLocaleString(),
                      cost: money(engine.cost),
                    })}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-col gap-1">
                  {engine.models.map((model) => (
                    <div key={model.model} className="flex items-center justify-between gap-3 pl-3">
                      <span className="truncate font-mono text-caption-1-regular text-text-secondary">{model.model || "—"}</span>
                      <span className="shrink-0 font-mono text-caption-1-regular text-text-tertiary">
                        {t("account.usageLine", {
                          tokens: compact(model.tokens),
                          requests: model.requests.toLocaleString(),
                          cost: money(model.cost),
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <p className="text-caption-1-regular text-text-tertiary">
          {data?.scanning ? t("account.scanning") : t("account.localNote")}
        </p>
        <Button
          size="xs"
          variant="ghost"
          disabled={loading}
          onClick={() =>
            void refreshAction
              .start(async () => {
                if (!(await load())) throw new Error("usage refresh failed");
              })
              .catch(() => {
                // The failure is already shown in the panel's alert row.
              })
          }
        >
          <span className="flex items-center gap-1.5">
            <ActionFeedbackIcon icon={RefreshCw} feedback={refreshAction.feedback} spin iconClassName="size-3.5" />
            {t("account.refreshUsage")}
          </span>
        </Button>
      </div>
      {error && (
        <p role="alert" className="px-1 text-body-2-regular text-text-error-primary">
          {t("account.usageFailed", { detail: error })}
        </p>
      )}
    </div>
  );
}
