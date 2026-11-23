import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useChatStore } from "../store";
import { PinnedChannelNotice } from "./PinnedChannelNotice";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    getCliConfig: vi.fn(async () => ({ claude: { current: "ccpl-account", providers: { "ccpl-account": { name: "ccpl" } } } })),
    rememberSessionProvider: vi.fn(async () => {}),
    setCurrentProvider: vi.fn(async () => {}),
  },
}));

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const WS = "/tmp/ws";
const tab = { engine: "claude", sessionId: "s-a", workspacePath: WS };

describe("PinnedChannelNotice", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(ipc.rememberSessionProvider).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async () => {
    await act(async () => {
      root.render(<PinnedChannelNotice engine="claude" sessionId="s-a" workspacePath={WS} />);
    });
  };

  it("offers moving a session pinned to 官方配置 onto the current ccpl channel", async () => {
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      providers: { claude: "ccpl-account" },
      sessions: [],
      bySession: { [`claude/s-a`]: { ...useChatStore.getState().bySession[`claude/s-a`], activeProvider: "__local_settings_json__" } as never },
    });
    await render();
    expect(container.textContent).toContain("ccpl");
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
    expect(ipc.rememberSessionProvider).toHaveBeenCalledWith("claude", "s-a", "ccpl-account");
  });

  it("stays hidden for a session that follows the engine", async () => {
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      providers: { claude: "ccpl-account" },
      sessions: [],
      bySession: {},
    });
    await render();
    expect(container.querySelector("[role=status]")).toBeNull();
  });
});
