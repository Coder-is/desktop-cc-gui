import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ccplAccountStatus = vi.fn();
const ccplRanking = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: {
    ccplAccountStatus: () => ccplAccountStatus(),
    ccplRanking: (range: unknown) => ccplRanking(range),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import i18n from "@/lib/i18n";
import { CcplRankingSection } from "./CcplRankingSection";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const RANKING = {
  range: "7d",
  people: 3,
  meRank: 2,
  at: "2026-11-24T00:00:00Z",
  rows: [
    { rank: 1, name: "Bob", weekCostNano: 50e9, weekPercent: 120, requests: 900, activeDays: 6 },
    { rank: 2, name: "Alice", weekCostNano: 9e9, weekPercent: 21.4, requests: 300, activeDays: 4, me: true },
    { rank: 3, name: "未备注", weekCostNano: 1e9, weekPercent: null, requests: 12, activeDays: 1 },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  ccplAccountStatus.mockReset().mockResolvedValue({ signedIn: true, baseUrl: "https://cc.example.com", username: "alice", tokenHint: "sk-…", provider: "" });
  ccplRanking.mockReset().mockResolvedValue(RANKING);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`button not rendered: ${text}`);
  return found;
}

describe("CcplRankingSection", () => {
  it("lists everyone and marks the signed-in row", async () => {
    await act(async () => root.render(<CcplRankingSection />));
    expect(ccplRanking).toHaveBeenCalledExactlyOnceWith("7d");
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows.map((r) => r.querySelectorAll("td")[1]?.textContent)).toEqual(["Bob", `Alice${i18n.t("ccplRanking.me")}`, "未备注"]);
    expect(rows[1]?.getAttribute("aria-current")).toBe("true");
    expect(container.textContent).toContain(i18n.t("ccplRanking.summary", { rank: 2, people: 3 }));
    expect(container.textContent).toContain("$50.00");
  });

  it("reloads with the picked range", async () => {
    await act(async () => root.render(<CcplRankingSection />));
    await act(async () => button(i18n.t("ccplRanking.range_today")).click());
    expect(ccplRanking).toHaveBeenLastCalledWith("today");
  });

  it("asks to sign in first when signed out", async () => {
    ccplAccountStatus.mockResolvedValue({ signedIn: false, baseUrl: "", username: "", tokenHint: "", provider: "" });
    await act(async () => root.render(<CcplRankingSection />));
    expect(ccplRanking).not.toHaveBeenCalled();
    expect(container.textContent).toContain(i18n.t("ccplRanking.signedOut"));
  });

  it("explains an old server without the leaderboard API", async () => {
    ccplRanking.mockRejectedValue(JSON.stringify({ status: 404, message: "not_ccpl_api" }));
    await act(async () => root.render(<CcplRankingSection />));
    expect(container.textContent).toContain(i18n.t("ccplRanking.notSupported"));
  });
});
