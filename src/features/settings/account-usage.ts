/** Pure aggregation for 设置 → 账号's usage panel. Input rows come from
 *  `account_usage_query` (local day × CLI × model × project groups built from
 *  each CLI's own logs); everything here is display math over them. */

import type { AccountUsageRow } from "@/lib/ipc";

/** Local `YYYY-MM-DD` for a date. */
export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Shift a local `YYYY-MM-DD` by whole days (DST-safe: noon anchor). */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d, 12);
  date.setDate(date.getDate() + delta);
  return localDay(date);
}

/** Every token the model processed: uncached input, output, cache traffic. */
export function rowTokens(row: AccountUsageRow): number {
  return row.input + row.output + row.cacheRead + row.cacheWrite;
}

export interface UsageSummary {
  todayTokens: number;
  /** Estimated USD today; null when no row today has a known price. */
  todayCost: number | null;
  totalTokens: number;
  peak: { day: string; tokens: number } | null;
  longestStreak: number;
  /** Consecutive active days ending today (or yesterday, before today's first use). */
  currentStreak: number;
  activeDays: number;
  /** Tokens per local day. */
  daily: Map<string, number>;
}

export function summarize(rows: AccountUsageRow[], today: string): UsageSummary {
  const daily = new Map<string, number>();
  let todayCost: number | null = null;
  for (const row of rows) {
    const day = row.bucket.slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + rowTokens(row));
    if (day === today && row.cost != null) todayCost = (todayCost ?? 0) + row.cost;
  }
  let totalTokens = 0;
  let peak: UsageSummary["peak"] = null;
  for (const [day, tokens] of daily) {
    totalTokens += tokens;
    if (tokens > 0 && (!peak || tokens > peak.tokens)) peak = { day, tokens };
  }
  const active = [...daily.keys()].filter((day) => (daily.get(day) ?? 0) > 0).sort();
  let longestStreak = 0;
  let run = 0;
  let previous = "";
  for (const day of active) {
    run = previous && addDays(previous, 1) === day ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = day;
  }
  const activeOn = (day: string) => (daily.get(day) ?? 0) > 0;
  let cursor = activeOn(today) ? today : addDays(today, -1);
  let currentStreak = 0;
  while (activeOn(cursor)) {
    currentStreak += 1;
    cursor = addDays(cursor, -1);
  }
  return {
    todayTokens: daily.get(today) ?? 0,
    todayCost,
    totalTokens,
    peak,
    longestStreak,
    currentStreak,
    activeDays: active.length,
    daily,
  };
}

export interface ModelUsage {
  model: string;
  tokens: number;
  requests: number;
  cost: number | null;
}

export interface EngineUsage extends ModelUsage {
  engine: string;
  models: ModelUsage[];
}

function addCost(sum: number | null, cost: number | null | undefined): number | null {
  return cost == null ? sum : (sum ?? 0) + cost;
}

/** CLI → model breakdown for rows on or after `fromDay` (null = all), both
 *  levels sorted by tokens, heaviest first. */
export function groupByEngine(rows: AccountUsageRow[], fromDay: string | null): EngineUsage[] {
  const engines = new Map<string, EngineUsage>();
  for (const row of rows) {
    if (fromDay && row.bucket.slice(0, 10) < fromDay) continue;
    const tokens = rowTokens(row);
    let engine = engines.get(row.engine);
    if (!engine) {
      engine = { engine: row.engine, model: "", tokens: 0, requests: 0, cost: null, models: [] };
      engines.set(row.engine, engine);
    }
    engine.tokens += tokens;
    engine.requests += row.requests;
    engine.cost = addCost(engine.cost, row.cost);
    let model = engine.models.find((m) => m.model === row.model);
    if (!model) {
      model = { model: row.model, tokens: 0, requests: 0, cost: null };
      engine.models.push(model);
    }
    model.tokens += tokens;
    model.requests += row.requests;
    model.cost = addCost(model.cost, row.cost);
  }
  const list = [...engines.values()].filter((e) => e.tokens > 0 || e.requests > 0);
  for (const engine of list) engine.models.sort((a, b) => b.tokens - a.tokens);
  return list.sort((a, b) => b.tokens - a.tokens);
}

export interface HeatCell {
  day: string;
  tokens: number;
  /** 0 = none, 1–4 = quartile of the active days' volume. */
  level: 0 | 1 | 2 | 3 | 4;
  /** Day after `today` (the grid's last column runs to Saturday). */
  future: boolean;
}

/** Quartile thresholds over the non-zero values. */
function levelOf(value: number, sorted: number[]): HeatCell["level"] {
  if (value <= 0 || sorted.length === 0) return 0;
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  if (value >= at(0.75)) return 4;
  if (value >= at(0.5)) return 3;
  if (value >= at(0.25)) return 2;
  return 1;
}

/** GitHub-style grid: `weeks` columns of Sunday→Saturday, ending with the
 *  week that contains `today`. */
export function heatmapWeeks(daily: Map<string, number>, today: string, weeks = 53): HeatCell[][] {
  const [y, m, d] = today.split("-").map(Number);
  const weekday = new Date(y, m - 1, d, 12).getDay();
  const start = addDays(today, -weekday - (weeks - 1) * 7);
  const values: number[] = [];
  for (let i = 0; i < weeks * 7; i += 1) {
    const day = addDays(start, i);
    if (day <= today && (daily.get(day) ?? 0) > 0) values.push(daily.get(day)!);
  }
  values.sort((a, b) => a - b);
  const grid: HeatCell[][] = [];
  for (let w = 0; w < weeks; w += 1) {
    const column: HeatCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      const day = addDays(start, w * 7 + i);
      const future = day > today;
      const tokens = future ? 0 : (daily.get(day) ?? 0);
      column.push({ day, tokens, level: future ? 0 : levelOf(tokens, values), future });
    }
    grid.push(column);
  }
  return grid;
}

/** Per-week totals for the same columns, levelled against each other. */
export function weeklyTotals(grid: HeatCell[][]): { start: string; tokens: number; level: HeatCell["level"] }[] {
  const totals = grid.map((column) => ({
    start: column[0].day,
    tokens: column.reduce((sum, cell) => sum + cell.tokens, 0),
  }));
  const sorted = totals.map((t) => t.tokens).filter((v) => v > 0).sort((a, b) => a - b);
  return totals.map((t) => ({ ...t, level: levelOf(t.tokens, sorted) }));
}

/** Month label per column: the month's number where a new month starts. */
export function monthLabels(grid: HeatCell[][]): (number | null)[] {
  let previous = -1;
  return grid.map((column) => {
    const month = Number(column[0].day.slice(5, 7));
    if (month === previous) return null;
    previous = month;
    return month;
  });
}

/** Up to two initials for the avatar: "Coder" → "CO", "li ming" → "LM". */
export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  const words = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
  return Array.from(trimmed).slice(0, 2).join("").toUpperCase();
}

/** ccpl daily quotas reset at 00:00 Beijing time (UTC+8, no DST). */
const BEIJING_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/** Time left until the next 00:00 Beijing time, rounded up to the minute. */
export function untilQuotaReset(now: Date): { hours: number; minutes: number } {
  const shifted = now.getTime() + BEIJING_OFFSET_MS;
  const next = (Math.floor(shifted / DAY_MS) + 1) * DAY_MS;
  const minutes = Math.max(1, Math.ceil((next - shifted) / 60_000));
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

export type QuotaTone = "normal" | "warning" | "exceeded";

/** Share of the daily limit used: `ratio` is clamped for the bar width,
 *  `percent` is the honest figure (may pass 100). */
export function quotaUsage(spent: number, limit: number): { ratio: number; percent: number; tone: QuotaTone } {
  if (!(limit > 0)) return { ratio: 0, percent: 0, tone: "normal" };
  const raw = Math.max(0, spent) / limit;
  const tone: QuotaTone = raw >= 1 ? "exceeded" : raw >= 0.8 ? "warning" : "normal";
  return { ratio: Math.min(1, raw), percent: Math.round(raw * 100), tone };
}
