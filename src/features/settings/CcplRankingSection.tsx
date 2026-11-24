import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { Button } from "@/components/base/buttons/button";
import { SettingsCard, SettingsSectionLabel } from "@/components/application/settings/settings-rows";
import { ipc, type CcplRankRange, type CcplRanking } from "@/lib/ipc";
import { parseCcplError, usd } from "./CcplAccountSection";

const RANGES: CcplRankRange[] = ["today", "7d", "30d"];

/** "≈ 37% weekly quota" next to the cost; empty when the server cannot
 *  estimate one account's quota yet. */
function quotaText(percent: number | null, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (percent == null || !Number.isFinite(percent)) return "";
  return t("ccplRanking.quota", { percent: percent >= 10 ? Math.round(percent) : percent.toFixed(1) });
}

/**
 * 设置 → 排行榜: the full usage leaderboard of the ccpl server the account is
 * signed in to (`GET /v1/ranking`), same order as the admin console's ranking.
 * Each row only carries the token's remark and its usage. Loads on page open,
 * on range change and on refresh.
 */
export function CcplRankingSection() {
  const { t } = useTranslation();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [range, setRange] = useState<CcplRankRange>("7d");
  const [data, setData] = useState<CcplRanking | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (next: CcplRankRange) => {
      setBusy(true);
      setError(null);
      try {
        setData(await ipc.ccplRanking(next));
      } catch (e) {
        const err = parseCcplError(e);
        setData(null);
        setError(
          err.message === "not_ccpl_api"
            ? t("ccplRanking.notSupported")
            : err.network
              ? t("ccplAccount.networkError", { detail: err.network })
              : err.message || t("ccplAccount.unknownError"),
        );
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  useEffect(() => {
    let cancelled = false;
    void ipc
      .ccplAccountStatus()
      .then((status) => {
        if (cancelled) return;
        setSignedIn(!!status?.signedIn);
        if (status?.signedIn) void load("7d");
      })
      .catch(() => !cancelled && setSignedIn(false));
    return () => {
      cancelled = true;
    };
  }, [load]);

  const changeRange = (next: CcplRankRange) => {
    setRange(next);
    void load(next);
  };

  return (
    <div className="flex w-full flex-col gap-2">
      <SettingsSectionLabel>{t("ccplRanking.title")}</SettingsSectionLabel>
      <p className="px-3 text-body-2-regular text-text-secondary">{t("ccplRanking.desc")}</p>

      {signedIn === false ? (
        <p className="px-3 text-body-2-regular text-text-tertiary">{t("ccplRanking.signedOut")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 px-3">
            {RANGES.map((r) => (
              <Button key={r} size="xs" variant={range === r ? "primary" : "ghost"} disabled={busy} onClick={() => changeRange(r)}>
                {t(`ccplRanking.range_${r}`)}
              </Button>
            ))}
            <Button size="xs" variant="ghost" leadingIcon={RefreshCw} disabled={busy} onClick={() => void load(range)}>
              {t("ccplAccount.refresh")}
            </Button>
            {data && (
              <span className="ml-auto text-body-2-regular text-text-secondary" role="status">
                {data.meRank > 0
                  ? t("ccplRanking.summary", { rank: data.meRank, people: data.people })
                  : t("ccplRanking.summaryAbsent", { people: data.people })}
              </span>
            )}
          </div>
          {error && (
            <p role="alert" className="px-3 text-body-2-regular text-text-error-primary">
              {error}
            </p>
          )}
          <SettingsCard>
            {!data ? (
              <p className="px-4 py-6 text-body-2-regular text-text-tertiary">{busy ? t("ccplRanking.loading") : "—"}</p>
            ) : data.rows.length === 0 ? (
              <p className="px-4 py-6 text-body-2-regular text-text-tertiary">{t("ccplRanking.empty")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-body-2-regular">
                  <thead>
                    <tr className="text-left text-text-tertiary">
                      <th className="w-12 px-4 py-2 text-right font-normal">#</th>
                      <th className="px-4 py-2 font-normal">{t("ccplRanking.colName")}</th>
                      <th className="px-4 py-2 text-right font-normal">{t(`ccplRanking.colCost_${data.range}`)}</th>
                      <th className="px-4 py-2 text-right font-normal">{t("ccplRanking.colRequests")}</th>
                      <th className="px-4 py-2 text-right font-normal">{t("ccplRanking.colDays")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr
                        key={row.rank}
                        aria-current={row.me ? "true" : undefined}
                        className={row.me ? "bg-background-tertiary-default font-medium" : "border-t border-border-secondary"}
                      >
                        <td className="px-4 py-2 text-right font-mono text-text-tertiary">{row.rank}</td>
                        <td className="px-4 py-2 text-text-primary">
                          {row.name}
                          {row.me && <span className="ml-2 text-text-brand-secondary">{t("ccplRanking.me")}</span>}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-text-primary">
                          {usd(row.weekCostNano)}
                          {quotaText(row.weekPercent, t) && (
                            <span className="ml-2 text-text-tertiary">{quotaText(row.weekPercent, t)}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-text-secondary">{row.requests.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right font-mono text-text-secondary">{row.activeDays}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SettingsCard>
        </>
      )}
    </div>
  );
}
