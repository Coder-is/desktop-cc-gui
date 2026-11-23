import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ccplAccountStatus = vi.fn();
const ccplTokenLogin = vi.fn();
const ccplMe = vi.fn();
const ccplServerInfo = vi.fn();
const ccplCaptcha = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: {
    ccplAccountStatus: () => ccplAccountStatus(),
    ccplTokenLogin: (form: unknown) => ccplTokenLogin(form),
    ccplMe: (range: unknown) => ccplMe(range),
    ccplServerInfo: (baseUrl: unknown) => ccplServerInfo(baseUrl),
    ccplCaptcha: (baseUrl: unknown) => ccplCaptcha(baseUrl),
  },
}));
const applyCcplChannels = vi.fn(async (..._args: unknown[]) => ({ written: ["claude"], removed: [] as string[] }));
vi.mock("./ccplChannels", () => ({
  applyCcplChannels: (...args: unknown[]) => applyCcplChannels(...args),
}));

import i18n from "@/lib/i18n";
import { CcplAccountSection } from "./CcplAccountSection";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SIGNED_OUT = { signedIn: false, baseUrl: "", username: "", tokenHint: "", provider: "" };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  ccplAccountStatus.mockReset().mockResolvedValue(SIGNED_OUT);
  ccplTokenLogin.mockReset();
  ccplMe.mockReset().mockResolvedValue(null);
  ccplServerInfo.mockReset();
  ccplCaptcha.mockReset();
  applyCcplChannels.mockClear();
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

function input(label: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!found) throw new Error(`input not rendered: ${label}`);
  return found;
}

/** Drive a controlled React input the way typing does. */
function type(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openTokenMode() {
  await act(async () => root.render(<CcplAccountSection />));
  await act(async () => button(i18n.t("ccplAccount.tokenLogin")).click());
}

describe("CcplAccountSection token sign-in", () => {
  it("verifies the pasted token, then writes it into the ccpl channels", async () => {
    ccplTokenLogin.mockResolvedValue({
      baseUrl: "https://cc.example.com",
      username: "alice",
      token: "sk-ccpl-abc123",
      quotaPending: false,
      provider: "anthropic",
    });
    await openTokenMode();
    expect(container.querySelector(`input[aria-label="${i18n.t("ccplAccount.password")}"]`)).toBeNull();
    await act(async () => type(input(i18n.t("ccplAccount.server")), "https://cc.example.com"));
    await act(async () => type(input(i18n.t("ccplAccount.token")), "  sk-ccpl-abc123  "));
    ccplAccountStatus.mockResolvedValue({ signedIn: true, baseUrl: "https://cc.example.com", username: "alice", tokenHint: "sk-ccpl-…c123" });
    await act(async () => button(i18n.t("ccplAccount.tokenSubmit")).click());

    expect(ccplTokenLogin).toHaveBeenCalledExactlyOnceWith({ baseUrl: "https://cc.example.com", token: "sk-ccpl-abc123" });
    expect(applyCcplChannels).toHaveBeenCalledExactlyOnceWith(
      "https://cc.example.com",
      "sk-ccpl-abc123",
      "alice",
      true,
      "anthropic",
    );
    expect(container.textContent).toContain(i18n.t("ccplAccount.signedInOk", { engines: "Claude" }));
  });

  it("says so when the token's group has no engine here and reports removed stale channels", async () => {
    applyCcplChannels.mockResolvedValueOnce({ written: [], removed: ["claude", "codex"] });
    ccplTokenLogin.mockResolvedValue({
      baseUrl: "https://cc.example.com",
      username: "alice",
      token: "sk-ccpl-gem",
      quotaPending: true,
      provider: "antigravity",
    });
    await openTokenMode();
    await act(async () => type(input(i18n.t("ccplAccount.token")), "sk-ccpl-gem"));
    await act(async () => button(i18n.t("ccplAccount.tokenSubmit")).click());

    expect(container.textContent).toContain(i18n.t("ccplAccount.signedInNoEngine", { group: "Gemini (Antigravity)" }));
    expect(container.textContent).toContain(i18n.t("ccplAccount.removedStale", { engines: "Claude / Codex" }));
    expect(container.textContent).toContain(i18n.t("ccplAccount.quotaPendingNote"));
  });

  it("flags a token whose group changed since the channels were written", async () => {
    ccplAccountStatus.mockResolvedValue({
      signedIn: true,
      baseUrl: "https://cc.example.com",
      username: "alice",
      tokenHint: "sk-ccpl-…c123",
      provider: "anthropic",
    });
    ccplMe.mockResolvedValue({ hint: "sk-ccpl-…c123", quotaPending: false, dailyLimit: 0, dailySpent: 0, models: [], restricted: false, range: "24h", provider: "codex" });
    await act(async () => root.render(<CcplAccountSection />));
    await act(async () => {});

    expect(container.textContent).toContain(i18n.t("ccplAccount.groupChanged", { group: "Codex" }));
  });

  it("asks for a token instead of calling the server when the field is empty", async () => {
    await openTokenMode();
    await act(async () => button(i18n.t("ccplAccount.tokenSubmit")).click());
    expect(ccplTokenLogin).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(i18n.t("ccplAccount.fillToken"));
  });

  it("explains a rejected token and writes no channel", async () => {
    ccplTokenLogin.mockRejectedValue(JSON.stringify({ status: 401, message: "invalid api key" }));
    await openTokenMode();
    await act(async () => type(input(i18n.t("ccplAccount.token")), "sk-ccpl-revoked"));
    await act(async () => button(i18n.t("ccplAccount.tokenSubmit")).click());

    expect(applyCcplChannels).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      i18n.t("ccplAccount.tokenRejected", { detail: "invalid api key" }),
    );
  });
});

describe("CcplAccountSection register on a server without the account API", () => {
  it("says the address has no ccpl account API instead of crashing", async () => {
    // Backend reply for a 200 HTML page (SPA fallback) at /client/api/config.
    ccplServerInfo.mockRejectedValue(JSON.stringify({ status: 200, message: "not_ccpl_api" }));
    await act(async () => root.render(<CcplAccountSection />));
    await act(async () => button(i18n.t("ccplAccount.register")).click());

    expect(ccplCaptcha).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(i18n.t("ccplAccount.notCcplApi"));
    expect(button(i18n.t("ccplAccount.registerSubmit")).disabled).toBe(true);
  });
});
