import { describe, expect, it, vi, beforeEach } from "vitest";

const upsertProvider = vi.fn(async (..._args: unknown[]) => {});
const setCurrentProvider = vi.fn(async (..._args: unknown[]) => {});
const deleteProvider = vi.fn(async (..._args: unknown[]) => {});
const getCliConfig = vi.fn(async () => ({}) as Record<string, unknown>);
const ccplMe = vi.fn(async (..._args: unknown[]) => ({}) as Record<string, unknown>);
vi.mock("@/lib/ipc", () => ({
  ipc: {
    upsertProvider: (...args: unknown[]) => upsertProvider(...args),
    setCurrentProvider: (...args: unknown[]) => setCurrentProvider(...args),
    deleteProvider: (...args: unknown[]) => deleteProvider(...args),
    getCliConfig: () => getCliConfig(),
    ccplMe: (...args: unknown[]) => ccplMe(...args),
  },
}));

import {
  applyCcplChannels,
  buildCcplChannels,
  ccplCodexModels,
  ccplEnginesFor,
  CCPL_CHANNEL_ID,
  CCPL_GEMINI_MODELS,
  migrateCcplChannels,
  resetCcplMigrationForTests,
  syncCcplChannels,
  withoutLegacyCcplModels,
} from "./ccplChannels";
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
    // 不映射模型：Claude Code 用自己的别名，列表显示什么就发什么。
    expect(claude.settingsConfig.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(claude.settingsConfig.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect((claude.settingsConfig as Record<string, unknown>).model).toBeUndefined();
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
    expect(ccplEnginesFor("antigravity")).toEqual(["codex"]);
    expect(ccplEnginesFor("")).toEqual(["claude", "codex", "grok"]);
  });

  it("writes every engine of a token that has a Claude and a Codex group", async () => {
    getCliConfig.mockResolvedValue({ grok: { providers: { [CCPL_CHANNEL_ID]: { apiKey: "sk-ccpl-both" } } } });
    const result = await applyCcplChannels("https://cc.example.com", "sk-ccpl-both", "bob", true, ["anthropic", "codex"]);
    expect(result).toEqual({ written: ["claude", "codex"], removed: ["grok"] });
    expect(upsertProvider.mock.calls.map((c) => c[0])).toEqual(["claude", "codex"]);
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

  it("writes a Gemini-only token into Codex with a Gemini default model", async () => {
    getCliConfig.mockResolvedValue({
      claude: { providers: { [CCPL_CHANNEL_ID]: { apiKey: "sk-ccpl-g" } }, current: null },
    });
    const result = await applyCcplChannels("https://cc.example.com", "sk-ccpl-g", "bob", true, "antigravity");
    expect(result).toEqual({ written: ["codex"], removed: ["claude"], geminiViaCodex: true });
    expect(setCurrentProvider.mock.calls).toEqual([["codex", CCPL_CHANNEL_ID]]);
    const [engine, , json] = upsertProvider.mock.calls[0] as [string, string, { model: string; extraModels: string[]; settingsConfig: { config: string } }];
    expect(engine).toBe("codex");
    expect(json.model).toBe("gemini-4-neon");
    expect(json.settingsConfig.config).toContain('model = "gemini-4-neon"');
    expect(json.settingsConfig.config).toContain('wire_api = "responses"');
    expect(json.extraModels).toEqual(CCPL_GEMINI_MODELS.filter((m) => m !== "gemini-4-neon"));
  });

  it("keeps the Codex model and adds Gemini models when the token has both groups", async () => {
    const result = await applyCcplChannels("https://cc.example.com", "sk-ccpl-cg", "bob", true, ["codex", "antigravity"]);
    expect(result).toEqual({ written: ["codex"], removed: [], geminiViaCodex: true });
    const json = upsertProvider.mock.calls[0]![2] as { model: string; extraModels: string[] };
    expect(json.model).toBe("gpt-5.1-codex");
    expect(json.extraModels).toEqual([...CCPL_GEMINI_MODELS]);
  });

  it("adds no Gemini models to a plain Codex token", async () => {
    await applyCcplChannels("https://cc.example.com", "sk-ccpl-c", "bob", true, ["anthropic", "codex"]);
    const codex = upsertProvider.mock.calls.find((c) => c[0] === "codex")![2] as Record<string, unknown>;
    expect(codex.extraModels).toBeUndefined();
    expect(ccplCodexModels(["codex"])).toEqual({ extraModels: [] });
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

describe("legacy ccpl model mapping", () => {
  const legacy = {
    model: "opus",
    alwaysThinkingEnabled: true,
    env: {
      ANTHROPIC_AUTH_TOKEN: "sk-ccpl-x",
      ANTHROPIC_BASE_URL: "https://cc.example.com",
      ANTHROPIC_BETAS: "context-1m-2025-08-07",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-5",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
      ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5",
    },
  };

  it("strips the mapping earlier versions wrote, keeping token, endpoint and 1M beta", () => {
    const next = withoutLegacyCcplModels(legacy)!;
    expect(next.model).toBeUndefined();
    expect(next.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: "sk-ccpl-x",
      ANTHROPIC_BASE_URL: "https://cc.example.com",
      ANTHROPIC_BETAS: "context-1m-2025-08-07",
    });
    expect(next.alwaysThinkingEnabled).toBe(true);
  });

  it("keeps a mapping the user typed and reports nothing to do on a clean channel", () => {
    const custom = { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5[1m]" } };
    expect(withoutLegacyCcplModels(custom)).toBeNull();
    expect(withoutLegacyCcplModels({ env: { ANTHROPIC_AUTH_TOKEN: "t" } })).toBeNull();
    expect(withoutLegacyCcplModels(null)).toBeNull();
  });

  it("rewrites an existing ccpl Claude channel once, without re-login", async () => {
    resetCcplMigrationForTests();
    upsertProvider.mockClear();
    getCliConfig.mockResolvedValueOnce({
      claude: { current: CCPL_CHANNEL_ID, providers: { [CCPL_CHANNEL_ID]: { name: "ccpl", apiKey: "sk-ccpl-x", settingsConfig: legacy } } },
    });
    expect(await migrateCcplChannels()).toBe(true);
    const [engine, id, json] = upsertProvider.mock.calls[0] as [string, string, { apiKey: string; settingsConfig: { env: Record<string, string> } }];
    expect([engine, id, json.apiKey]).toEqual(["claude", CCPL_CHANNEL_ID, "sk-ccpl-x"]);
    expect(json.settingsConfig.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    // Second run in the same session does nothing.
    expect(await migrateCcplChannels()).toBe(false);
    expect(upsertProvider).toHaveBeenCalledTimes(1);
  });
});

describe("syncCcplChannels", () => {
  const status = { baseUrl: "https://cc.example.com", username: "bob", provider: "anthropic" as const };
  beforeEach(() => {
    resetCcplMigrationForTests();
    upsertProvider.mockClear();
    setCurrentProvider.mockClear();
    deleteProvider.mockClear();
    getCliConfig.mockReset();
    ccplMe.mockReset();
  });

  it("adds the Gemini models to an existing Codex channel signed in before 反重力 support", async () => {
    ccplMe.mockResolvedValue({ providers: ["anthropic", "codex", "antigravity"] });
    getCliConfig.mockResolvedValue({
      claude: { current: CCPL_CHANNEL_ID, providers: { [CCPL_CHANNEL_ID]: { apiKey: "sk-ccpl-old" } } },
      codex: { current: CCPL_CHANNEL_ID, providers: { [CCPL_CHANNEL_ID]: { apiKey: "sk-ccpl-old" } } },
    });
    expect(await syncCcplChannels(status)).toBe(true);
    const codex = upsertProvider.mock.calls.find((c) => c[0] === "codex")![2] as { apiKey: string; extraModels: string[] };
    expect(codex.apiKey).toBe("sk-ccpl-old");
    expect(codex.extraModels).toEqual([...CCPL_GEMINI_MODELS]);
    // 已有的当前渠道不动
    expect(setCurrentProvider).not.toHaveBeenCalled();
    // 同一次启动只跑一次
    expect(await syncCcplChannels(status)).toBe(false);
  });

  it("writes a missing Codex channel and makes it current when the engine has none", async () => {
    ccplMe.mockResolvedValue({ providers: ["anthropic", "antigravity"] });
    getCliConfig.mockResolvedValue({
      claude: { current: CCPL_CHANNEL_ID, providers: { [CCPL_CHANNEL_ID]: { apiKey: "sk-ccpl-x" } } },
    });
    expect(await syncCcplChannels(status)).toBe(true);
    expect(upsertProvider.mock.calls.map((c) => c[0])).toEqual(["claude", "codex"]);
    expect(setCurrentProvider.mock.calls).toEqual([["codex", CCPL_CHANNEL_ID]]);
    const codex = upsertProvider.mock.calls[1]![2] as { model: string };
    expect(codex.model).toBe("gemini-4-neon");
  });

  it("does nothing when the channels already match the token's groups", async () => {
    ccplMe.mockResolvedValue({ providers: ["anthropic", "codex", "antigravity"] });
    getCliConfig.mockResolvedValue({
      claude: { providers: { [CCPL_CHANNEL_ID]: { apiKey: "sk-ccpl-x" } } },
      codex: { providers: { [CCPL_CHANNEL_ID]: { apiKey: "sk-ccpl-x", extraModels: [...CCPL_GEMINI_MODELS] } } },
    });
    expect(await syncCcplChannels(status)).toBe(false);
    expect(upsertProvider).not.toHaveBeenCalled();
  });

  it("does nothing without a stored token or when the server is unreachable", async () => {
    ccplMe.mockRejectedValue(new Error("offline"));
    getCliConfig.mockResolvedValue({});
    expect(await syncCcplChannels({ ...status, provider: "" })).toBe(false);
    expect(upsertProvider).not.toHaveBeenCalled();
  });
});
