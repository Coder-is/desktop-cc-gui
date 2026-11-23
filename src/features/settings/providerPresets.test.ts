import { describe, expect, it } from "vitest";
import {
  CCPL_BASE_URL,
  CLAUDE_MODEL_ENV_KEYS,
  PRESETS,
  buildCodexConfigToml,
  claudeTemplateJson,
  findMatchedPreset,
} from "./providerPresets";

describe("API Route preset configuration", () => {
  it("writes Claude's root endpoint and overrides the template's tier models", () => {
    const preset = PRESETS.claude!.find((p) => p.name === "API Route")!;
    const settings = JSON.parse(claudeTemplateJson(preset.baseUrl, "test-key", preset.env));
    expect(new URL("/v1/messages", settings.env.ANTHROPIC_BASE_URL).href).toBe(
      "https://global.api-route.com/v1/messages",
    );
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("test-key");
    expect(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("claude-fable-5-1");
    expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-4-5");
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5");
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5");
    expect(findMatchedPreset(PRESETS.claude!, settings.env.ANTHROPIC_BASE_URL)).toBe(preset);
  });

  it("generates a Codex Responses configuration rather than the chat fallback", () => {
    const preset = PRESETS.codex!.find((p) => p.name === "API Route")!;
    const config = buildCodexConfigToml(preset.name, preset.baseUrl, preset.model, preset.wireApi ?? "chat");
    expect(config).toContain('base_url = "https://global.api-route.com/v1"');
    expect(config).toContain('model = "gpt-6.1-sol"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain("requires_openai_auth = true");
    expect(config).not.toContain("disable_response_storage");
    expect(findMatchedPreset(PRESETS.codex!, preset.baseUrl)).toBe(preset);
  });
});

describe("ccpl preset configuration", () => {
  it("points Claude Code at the ccpl root so /v1/messages lands on the pool", () => {
    const preset = PRESETS.claude!.find((p) => p.name === "ccpl")!;
    const settings = JSON.parse(
      claudeTemplateJson(preset.baseUrl, "ccpl-token", preset.env, { nativeModels: preset.nativeModels }),
    );
    expect(new URL("/v1/messages", settings.env.ANTHROPIC_BASE_URL).href).toBe(
      `${CCPL_BASE_URL}/v1/messages`,
    );
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("ccpl-token");
    // ccpl 是官方订阅号：渠道不映射模型，Claude Code 用自己的别名（列表显示什么就发什么）。
    expect(preset.nativeModels).toBe(true);
    for (const key of CLAUDE_MODEL_ENV_KEYS) expect(settings.env[key]).toBeUndefined();
    expect(settings.model).toBeUndefined();
    // 1M 上下文 beta 保留：5.5 三档实测可用。
    expect(settings.env.ANTHROPIC_BETAS).toBe("context-1m-2025-08-07");
    expect(findMatchedPreset(PRESETS.claude!, settings.env.ANTHROPIC_BASE_URL)).toBe(preset);
  });

  it("generates a Codex Responses config on ccpl's /v1", () => {
    const preset = PRESETS.codex!.find((p) => p.name === "ccpl")!;
    const config = buildCodexConfigToml(preset.name, preset.baseUrl, preset.model, preset.wireApi ?? "chat");
    expect(config).toContain(`base_url = "${CCPL_BASE_URL}/v1"`);
    // ccpl's Codex group only accepts /v1/responses; chat would be rejected.
    expect(config).toContain('wire_api = "responses"');
    expect(findMatchedPreset(PRESETS.codex!, preset.baseUrl)).toBe(preset);
  });

  it("offers ccpl for Grok on /v1 alongside the official endpoint", () => {
    const names = PRESETS.grok!.map((p) => p.name);
    expect(names).toEqual(["ccpl", "xAI Official"]);
    expect(PRESETS.grok![0].baseUrl).toBe(`${CCPL_BASE_URL}/v1`);
  });
});
