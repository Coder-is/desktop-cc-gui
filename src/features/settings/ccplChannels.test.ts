import { describe, expect, it, vi, beforeEach } from "vitest";

const upsertProvider = vi.fn(async (..._args: unknown[]) => {});
const setCurrentProvider = vi.fn(async (..._args: unknown[]) => {});
const deleteProvider = vi.fn(async (..._args: unknown[]) => {});
const getCliConfig = vi.fn(async () => ({}) as Record<string, unknown>);
vi.mock("@/lib/ipc", () => ({
  ipc: {
    upsertProvider: (...args: unknown[]) => upsertProvider(...args),
    setCurrentProvider: (...args: unknown[]) => setCurrentProvider(...args),
    deleteProvider: (...args: unknown[]) => deleteProvider(...args),
    getCliConfig: () => getCliConfig(),
  },
}));

import { applyCcplChannels, buildCcplChannels, ccplEnginesFor, CCPL_CHANNEL_ID } from "./ccplChannels";
import { parseCcplError, usd } from "./CcplAccountSection";

describe("buildCcplChannels", () => {
  const token = "sk-ccpl-abc123";
  const channels = buildCcplChannels("https://cc.example.com:9443/v1/", token, "alice");

  it("points Claude at the server root with the token in the settings env", () => {
    const claude = channels.claude as { baseUrl: string; apiKey: string; settingsConfig: { env: Record<string, string> } };
    expect(claude.baseUrl).toBe("https://cc.example.com:9443");
    expect(claude.apiKey).toBe(token);
    expect(claude.settingsConfig.env.ANTHROPIC_BASE_URL).toBe("https://cc.example.com:9443");
    expect(claude.settingsConfig.env.ANTHROPIC_AUTH_TOKEN).toBe(token);
    expect(claude.settingsConfig.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeTruthy();
  });

  it("gives Codex /v1 with the Responses wire API and the token in auth.json", () => {
    const codex = channels.codex as { baseUrl: string; settingsConfig: { config: string; auth: Record<string, string> } };
    expect(codex.baseUrl).toBe("https://cc.example.com:9443/v1");
    expect(codex.settingsConfig.config).toContain('base_url = "https://cc.example.com:9443/v1"');
    expect(codex.settingsConfig.config).toContain('wire_api = "responses"');
    expect(codex.settingsConfig.auth.OPENAI_API_KEY).toBe(token);
  });

  it("gives Grok /v1 with the token", () => {
    expect(channels.grok).toMatchObject({ baseUrl: "https://cc.example.com:9443/v1", apiKey: token, name: "ccpl" });
  });
});

describe("applyCcplChannels", () => {
  beforeEach(() => {
    upsertProvider.mockClear();
    setCurrentProvider.mockClear();
    deleteProvider.mockClear();
    getCliConfig.mockReset().mockResolvedValue({});
  });

  it("maps each group type to the one engine it serves", () => {
    expect(ccplEnginesFor("anthropic")).toEqual(["claude"]);
    expect(ccplEnginesFor("codex")).toEqual(["codex"]);
    expect(ccplEnginesFor("grok")).toEqual(["grok"]);
    expect(ccplEnginesFor("antigravity")).toEqual([]);
    expect(ccplEnginesFor("")).toEqual(["claude", "codex", "grok"]);
  });

  it("writes only the engine of a known group", async () => {
    const result = await applyCcplChannels("https://cc.example.com", "sk-ccpl-x", "bob", true, "codex");
    expect(upsertProvider.mock.calls.map((c) => [c[0], c[1]])).toEqual([["codex", CCPL_CHANNEL_ID]]);
    expect(setCurrentProvider.mock.calls).toEqual([["codex", CCPL_CHANNEL_ID]]);
    expect(result).toEqual({ written: ["codex"], removed: [] });
  });

  it("removes other engines' ccpl channels only when they carry the same token", async () => {
    getCliConfig.mockResolvedValue({
      claude: { providers: { [CCPL_CHANNEL_ID]: { apiKey: "sk-ccpl-x" } }, current: CCPL_CHANNEL_ID },
      grok: { providers: { [CCPL_CHANNEL_ID]: { apiKey: "sk-ccpl-other" } }, current: null },
    });
    const result = await applyCcplChannels("https://cc.example.com", "sk-ccpl-x", "bob", false, "codex");
    expect(deleteProvider.mock.calls).toEqual([["claude", CCPL_CHANNEL_ID]]);
    expect(result).toEqual({ written: ["codex"], removed: ["claude"] });
  });

  it("writes nothing for a Gemini group but still clears its unusable leftovers", async () => {
    getCliConfig.mockResolvedValue({
      codex: { providers: { [CCPL_CHANNEL_ID]: { apiKey: "sk-ccpl-g" } }, current: null },
    });
    const result = await applyCcplChannels("https://cc.example.com", "sk-ccpl-g", "bob", true, "antigravity");
    expect(upsertProvider).not.toHaveBeenCalled();
    expect(setCurrentProvider).not.toHaveBeenCalled();
    expect(result).toEqual({ written: [], removed: ["codex"] });
  });

  it("upserts one fixed-id channel per engine and activates when the group is unknown", async () => {
    await applyCcplChannels("https://cc.example.com", "sk-ccpl-x", "bob", true);
    expect(getCliConfig).not.toHaveBeenCalled();
    expect(deleteProvider).not.toHaveBeenCalled();
    expect(upsertProvider.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["claude", CCPL_CHANNEL_ID],
      ["codex", CCPL_CHANNEL_ID],
      ["grok", CCPL_CHANNEL_ID],
    ]);
    expect(setCurrentProvider).toHaveBeenCalledTimes(3);
  });

  it("leaves the current channel alone without activate", async () => {
    await applyCcplChannels("https://cc.example.com", "sk-ccpl-x", "bob", false);
    expect(upsertProvider).toHaveBeenCalledTimes(3);
    expect(setCurrentProvider).not.toHaveBeenCalled();
  });
});

describe("parseCcplError", () => {
  it("reads the structured backend error", () => {
    const err = parseCcplError(JSON.stringify({ status: 401, message: "请输入验证码", captchaRequired: true }));
    expect(err).toMatchObject({ status: 401, message: "请输入验证码", captchaRequired: true });
  });

  it("keeps plain strings as the message", () => {
    expect(parseCcplError("boom").message).toBe("boom");
  });

  it("formats nano dollars", () => {
    expect(usd(1_234_000_000)).toBe("$1.23");
  });
});
