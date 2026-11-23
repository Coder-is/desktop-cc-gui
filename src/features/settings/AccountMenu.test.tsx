import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ccplAccountStatus = vi.fn();
const ccplLogout = vi.fn();
const accountUsageQuery = vi.fn();
const ccplMe = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: {
    ccplAccountStatus: () => ccplAccountStatus(),
    ccplLogout: () => ccplLogout(),
    accountUsageQuery: (query: unknown) => accountUsageQuery(query),
    ccplMe: (range: unknown) => ccplMe(range),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import i18n from "@/lib/i18n";
import { AccountMenu, ACCOUNT_SETTINGS_PATH } from "./AccountMenu";
import { AccountUsagePanel } from "./AccountProfile";
import { useAccountStore } from "./account-store";
import { localDay } from "./account-usage";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SIGNED_IN = { signedIn: true, baseUrl: "https://cc.example.com", username: "Coder", tokenHint: "sk-…", provider: "" as const };
const SIGNED_OUT = { signedIn: false, baseUrl: "", username: "", tokenHint: "", provider: "" as const };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  ccplAccountStatus.mockReset();
  ccplLogout.mockReset().mockResolvedValue(undefined);
  accountUsageQuery.mockReset();
  ccplMe.mockReset();
  useAccountStore.setState({ status: null, quota: null });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

async function openMenu(onNavigate = vi.fn()) {
  await act(async () => root.render(<AccountMenu onNavigate={onNavigate} />));
  const trigger = container.querySelector("button")!;
  await act(async () => trigger.click());
  return onNavigate;
}

describe("AccountMenu", () => {
  it("signed out: offers 登录 / 注册 and 设置, nothing else", async () => {
    ccplAccountStatus.mockResolvedValue(SIGNED_OUT);
    const onNavigate = await openMenu();
    expect(buttonByText(i18n.t("account.profile"))).toBeUndefined();
    expect(buttonByText(i18n.t("account.logout"))).toBeUndefined();
    const signIn = [...document.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === i18n.t("account.signInOrRegister"),
    );
    // The trigger row and the menu item both read 登录 / 注册.
    expect(signIn).toHaveLength(2);
    await act(async () => signIn[1].click());
    expect(onNavigate).toHaveBeenCalledWith(ACCOUNT_SETTINGS_PATH);
  });

  it("signed in: shows the name and cached quota without calling the server", async () => {
    ccplAccountStatus.mockResolvedValue(SIGNED_IN);
    useAccountStore.setState({ quota: { quotaPending: false, dailyLimit: 5, dailySpent: 1.2 } });
    const onNavigate = await openMenu();
    expect(document.body.textContent).toContain("Coder");
    expect(document.body.textContent).toContain(i18n.t("account.quotaToday", { spent: "$1.20", limit: "$5.00" }));
    expect(ccplMe).not.toHaveBeenCalled();
    expect(accountUsageQuery).not.toHaveBeenCalled();
    await act(async () => buttonByText(i18n.t("account.profile"))!.click());
    expect(onNavigate).toHaveBeenCalledWith(ACCOUNT_SETTINGS_PATH);
  });

  it("退出登录 removes the saved account and re-reads it", async () => {
    ccplAccountStatus.mockResolvedValue(SIGNED_IN);
    await openMenu();
    ccplAccountStatus.mockResolvedValue(SIGNED_OUT);
    await act(async () => buttonByText(i18n.t("account.logout"))!.click());
    expect(ccplLogout).toHaveBeenCalledTimes(1);
    expect(useAccountStore.getState().status?.signedIn).toBe(false);
  });
});

describe("AccountUsagePanel", () => {
  it("shows today's tokens and the CLI → model breakdown", async () => {
    const today = localDay(new Date());
    const base = { project: null, sessions: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    accountUsageQuery.mockResolvedValue({
      rows: [
        { ...base, bucket: today, engine: "claude", model: "claude-opus-5-5", requests: 3, input: 1500, cost: 0.75 },
        { ...base, bucket: today, engine: "codex", model: "gpt-6.2", requests: 1, input: 500, cost: null },
      ],
      firstDay: today,
      scannedAt: Date.now(),
      scanning: false,
      unknownModels: [],
    });
    await act(async () => root.render(<AccountUsagePanel />));

    const query = accountUsageQuery.mock.calls[0][0];
    expect(query).toMatchObject({ to: today, bucket: "day" });
    const text = container.textContent ?? "";
    expect(text).toContain(i18n.t("account.todayTokens"));
    expect(text).toContain("claude-opus-5-5");
    expect(text).toContain("gpt-6.2");
    expect(text).toContain("$0.75");
    // Heaviest CLI first.
    expect(text.indexOf("claude-opus-5-5")).toBeLessThan(text.indexOf("gpt-6.2"));
  });

  it("reports a refused query (signed out) instead of showing numbers", async () => {
    accountUsageQuery.mockRejectedValue(JSON.stringify({ status: 401, message: "" }));
    await act(async () => root.render(<AccountUsagePanel />));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
