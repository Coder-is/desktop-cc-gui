import { describe, expect, it, vi, beforeEach } from "vitest";

const upsertProvider = vi.fn(async () => {});
const setCurrentProvider = vi.fn(async () => {});
vi.mock("@/lib/ipc", () => ({
  ipc: {
    upsertProvider: (...args: unknown[]) => upsertProvider(...(args as [])),
    setCurrentProvider: (...args: unknown[]) => setCurrentProvider(...(args as [])),
  },
}));

import { applyCcplChannels, buildCcplChannels, CCPL_CHANNEL_ID } from "./ccplChannels";
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
  });

  it("upserts one fixed-id channel per engine and activates when asked", async () => {
    await applyCcplChannels("https://cc.example.com", "sk-ccpl-x", "bob", true);
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
