import { describe, expect, it } from "vitest";
import type { AccountUsageRow } from "@/lib/ipc";
import {
  addDays,
  groupByEngine,
  heatmapWeeks,
  initials,
  monthLabels,
  folderName,
  peakHour,
  usageInsights,
  quotaUsage,
  untilQuotaReset,
  summarize,
  weeklyTotals,
} from "./account-usage";

function row(bucket: string, engine: string, model: string, tokens: number, cost: number | null = null): AccountUsageRow {
  return {
    bucket,
    engine,
    model,
    project: null,
    sessions: 1,
    requests: 1,
    input: tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost,
  };
}

describe("addDays", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("summarize", () => {
  const today = "2026-11-22";
  it("adds all token kinds per day and finds today, total and peak", () => {
    const rows = [
      { ...row("2026-11-22", "claude", "opus", 100, 0.5), output: 50, cacheRead: 25, cacheWrite: 5 },
      row("2026-11-22", "codex", "gpt", 20, null),
      row("2026-11-20", "claude", "opus", 1000, 2),
    ];
    const s = summarize(rows, today);
    expect(s.todayTokens).toBe(200);
    expect(s.todayCost).toBe(0.5);
    expect(s.totalTokens).toBe(1200);
    expect(s.peak).toEqual({ day: "2026-11-20", tokens: 1000 });
  });

  it("reports an unknown cost as null rather than $0", () => {
    expect(summarize([row(today, "codex", "x", 10, null)], today).todayCost).toBeNull();
  });

  it("counts streaks; the current one may end yesterday before today's first use", () => {
    const days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-19", "2026-11-20", "2026-11-21"];
    const s = summarize(days.map((d) => row(d, "claude", "opus", 1)), today);
    expect(s.longestStreak).toBe(3);
    expect(s.currentStreak).toBe(3);
    expect(s.activeDays).toBe(6);
    expect(summarize([row("2026-11-20", "claude", "opus", 1)], today).currentStreak).toBe(0);
  });
});

describe("groupByEngine", () => {
  const rows = [
    row("2026-11-22", "claude", "claude-opus-5-5", 300, 1),
    row("2026-11-22", "claude", "claude-sonnet-5-5", 100, null),
    row("2026-11-21", "claude", "claude-opus-5-5", 50, 0.2),
    row("2026-11-22", "codex", "gpt-6.2", 500, 2),
  ];

  it("groups by CLI then model, heaviest first", () => {
    const all = groupByEngine(rows, null);
    expect(all.map((e) => [e.engine, e.tokens])).toEqual([
      ["codex", 500],
      ["claude", 450],
    ]);
    expect(all[1].models.map((m) => [m.model, m.tokens, m.cost])).toEqual([
      ["claude-opus-5-5", 350, 1.2],
      ["claude-sonnet-5-5", 100, null],
    ]);
  });

  it("filters by the range start day", () => {
    const today = groupByEngine(rows, "2026-11-22");
    expect(today.find((e) => e.engine === "claude")?.tokens).toBe(400);
  });
});

describe("heatmap", () => {
  it("ends with the week holding today, Sunday-first, future days blank", () => {
    // 2026-11-22 is a Sunday.
    const grid = heatmapWeeks(new Map([["2026-11-22", 10]]), "2026-11-22", 2);
    expect(grid).toHaveLength(2);
    expect(grid[0][0].day).toBe("2026-11-15");
    expect(grid[1][0]).toMatchObject({ day: "2026-11-22", tokens: 10, level: 4, future: false });
    expect(grid[1][1]).toMatchObject({ day: "2026-11-23", future: true, level: 0 });
  });

  it("levels days by quartile of active volume", () => {
    const daily = new Map([
      ["2026-11-15", 1],
      ["2026-11-16", 2],
      ["2026-11-17", 3],
      ["2026-11-18", 100],
    ]);
    const levels = heatmapWeeks(daily, "2026-11-21", 1)[0].map((c) => c.level);
    expect(levels).toEqual([1, 2, 3, 4, 0, 0, 0]);
  });

  it("sums weeks and labels a column where a new month starts", () => {
    const grid = heatmapWeeks(new Map([["2026-11-02", 5], ["2026-11-03", 7]]), "2026-11-08", 2);
    expect(weeklyTotals(grid).map((w) => w.tokens)).toEqual([12, 0]);
    expect(monthLabels(grid)).toEqual([11, null]);
  });
});

describe("initials", () => {
  it("takes two letters from one word or one from each of two", () => {
    expect(initials("Coder")).toBe("CO");
    expect(initials("li ming")).toBe("LM");
    expect(initials("张三")).toBe("张三");
    expect(initials("  ")).toBe("");
  });
});

describe("quota reset and usage", () => {
  it("counts down to the next 00:00 Beijing time", () => {
    // 2026-11-22 15:00 UTC = 23:00 Beijing → 1 hour left.
    expect(untilQuotaReset(new Date(Date.UTC(2026, 10, 22, 15, 0)))).toEqual({ hours: 1, minutes: 0 });
    // 16:00 UTC is Beijing midnight exactly → a full day ahead.
    expect(untilQuotaReset(new Date(Date.UTC(2026, 10, 22, 16, 0)))).toEqual({ hours: 24, minutes: 0 });
    // 15:59:30 UTC → rounds up to one minute, never "0 minutes".
    expect(untilQuotaReset(new Date(Date.UTC(2026, 10, 22, 15, 59, 30)))).toEqual({ hours: 0, minutes: 1 });
  });

  it("turns amber from 80% and red at the limit; the bar never overflows", () => {
    expect(quotaUsage(1, 5)).toEqual({ ratio: 0.2, percent: 20, tone: "normal" });
    expect(quotaUsage(4, 5).tone).toBe("warning");
    expect(quotaUsage(6, 5)).toEqual({ ratio: 1, percent: 120, tone: "exceeded" });
    expect(quotaUsage(1, 0)).toEqual({ ratio: 0, percent: 0, tone: "normal" });
  });
});

describe("insights", () => {
  it("finds the top CLI, model and project with their shares, and the cache hit rate", () => {
    const rows = [
      { ...row("2026-11-20", "claude", "claude-opus-5-5", 600), project: "D:\\work\\ccpl", cacheRead: 300, cacheWrite: 100 },
      { ...row("2026-11-21", "codex", "gpt-6.2", 400), project: "/home/me/api" },
    ];
    // tokens: claude 600+300+100 = 1000, codex 400 → total 1400.
    const insights = usageInsights(rows);
    expect(insights.topEngine).toEqual({ engine: "claude", share: 1000 / 1400 });
    expect(insights.topModel).toEqual({ engine: "claude", model: "claude-opus-5-5", share: 1000 / 1400 });
    expect(insights.topProject?.path).toBe("D:\\work\\ccpl");
    // prompt = (600+300+100) + 400 = 1400, cached = 300.
    expect(insights.cacheHitRate).toBeCloseTo(300 / 1400);
    expect(folderName("D:\\work\\ccpl")).toBe("ccpl");
    expect(folderName("/home/me/api/")).toBe("api");
  });

  it("has nothing to say without usage", () => {
    expect(usageInsights([])).toEqual({ topEngine: null, topModel: null, topProject: null, cacheHitRate: null });
    expect(peakHour([])).toBeNull();
  });

  it("picks the hour with the most requests across days", () => {
    const hourly = [
      { ...row("2026-11-20T09", "claude", "m", 1), requests: 3 },
      { ...row("2026-11-21T21", "claude", "m", 1), requests: 2 },
      { ...row("2026-11-22T21", "codex", "m", 1), requests: 2 },
    ];
    expect(peakHour(hourly)).toBe(21);
  });
});
