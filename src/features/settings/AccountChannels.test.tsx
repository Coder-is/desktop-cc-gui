import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCliConfig = vi.fn();
const setCurrentProvider = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: {
    getCliConfig: () => getCliConfig(),
    setCurrentProvider: (engine: unknown, id: unknown) => setCurrentProvider(engine, id),
  },
}));

import i18n from "@/lib/i18n";
import type { CliConfig } from "@/lib/ipc";
import { AccountChannels, ccplChannelStates } from "./AccountChannels";
import { CCPL_CHANNEL_ID } from "./ccplChannels";
import { CLI_CONFIG_CHANGED_EVENT, PSEUDO_DISABLED } from "./providers";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ccpl = { name: "ccpl", apiKey: "sk-ccpl-x" };
function config(sections: Partial<Record<string, { providers: Record<string, unknown>; current: string | null }>>): CliConfig {
  return sections as unknown as CliConfig;
}

describe("ccplChannelStates", () => {
  it("reports active, switched-away (with the current channel) and disabled; skips engines without ccpl", () => {
    const states = ccplChannelStates(
      config({
        claude: { providers: { [CCPL_CHANNEL_ID]: ccpl }, current: CCPL_CHANNEL_ID },
        codex: { providers: { [CCPL_CHANNEL_ID]: ccpl, relay: { name: "Relay" } }, current: "relay" },
        grok: { providers: { [CCPL_CHANNEL_ID]: ccpl }, current: PSEUDO_DISABLED },
        kimi: { providers: {}, current: null },
      }),
    );
    expect(states).toEqual([
      { engine: "claude", state: { kind: "active" } },
      { engine: "codex", state: { kind: "other", current: "relay" } },
      { engine: "grok", state: { kind: "disabled" } },
    ]);
  });

  it("treats an empty current as the official config", () => {
    const [entry] = ccplChannelStates(config({ claude: { providers: { [CCPL_CHANNEL_ID]: ccpl }, current: null } }));
    expect(entry.state).toEqual({ kind: "other", current: "__local_settings_json__" });
  });
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  getCliConfig.mockReset();
  setCurrentProvider.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("AccountChannels", () => {
  it("switches a channel back to ccpl and re-reads the config", async () => {
    getCliConfig.mockResolvedValue(
      config({ codex: { providers: { [CCPL_CHANNEL_ID]: ccpl, relay: { name: "Relay" } }, current: "relay" } }),
    );
    await act(async () => root.render(<AccountChannels />));
    expect(container.textContent).toContain(i18n.t("account.channelOtherDesc", { channel: "Relay" }));

    getCliConfig.mockResolvedValue(config({ codex: { providers: { [CCPL_CHANNEL_ID]: ccpl }, current: CCPL_CHANNEL_ID } }));
    const changed = vi.fn();
    window.addEventListener(CLI_CONFIG_CHANGED_EVENT, changed);
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === i18n.t("account.channelSwitchBack"))!;
    await act(async () => button.click());
    window.removeEventListener(CLI_CONFIG_CHANGED_EVENT, changed);

    expect(setCurrentProvider).toHaveBeenCalledExactlyOnceWith("codex", CCPL_CHANNEL_ID);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(i18n.t("account.channelActive"));
  });

  it("only reports a disabled engine, without offering to switch", async () => {
    getCliConfig.mockResolvedValue(config({ grok: { providers: { [CCPL_CHANNEL_ID]: ccpl }, current: PSEUDO_DISABLED } }));
    await act(async () => root.render(<AccountChannels />));
    expect(container.textContent).toContain(i18n.t("account.channelDisabled"));
    expect(container.querySelector("button")).toBeNull();
  });

  it("says no channel was written when none exists", async () => {
    getCliConfig.mockResolvedValue(config({ claude: { providers: {}, current: null } }));
    await act(async () => root.render(<AccountChannels />));
    expect(container.textContent).toContain(i18n.t("account.channelsNone"));
  });
});
