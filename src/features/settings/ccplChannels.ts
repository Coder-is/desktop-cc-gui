/** Channel records written after signing in to a ccpl account: one `ccpl`
 *  channel each for Claude, Codex and Grok, built from the same presets the
 *  provider dialog offers, carrying the account's token. A fixed id keeps a
 *  re-login (or a rotated token) updating the same channel instead of piling
 *  up copies. */

import { ipc } from "@/lib/ipc";
import { notifyCliConfigChanged } from "./providers";
import {
  PRESETS,
  buildCodexConfigToml,
  claudeTemplateJson,
  type ProviderPreset,
} from "./providerPresets";

export const CCPL_CHANNEL_ID = "ccpl-account";
export const CCPL_ENGINES = ["claude", "codex", "grok"] as const;
export type CcplEngine = (typeof CCPL_ENGINES)[number];

function ccplPreset(engine: CcplEngine): ProviderPreset | undefined {
  return PRESETS[engine]?.find((preset) => preset.name === "ccpl");
}

/** Server root without a trailing slash or /v1. */
function rootOf(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/, "");
}

export function buildCcplChannels(
  baseUrl: string,
  token: string,
  username: string,
): Record<CcplEngine, Record<string, unknown>> {
  const root = rootOf(baseUrl);
  const v1 = `${root}/v1`;
  const remark = username ? `ccpl · ${username}` : "ccpl";
  const claudeEnv = ccplPreset("claude")?.env ?? {};
  const codexModel = ccplPreset("codex")?.model || "gpt-5.1-codex";
  const grokModel = ccplPreset("grok")?.model || "grok-build";
  return {
    claude: {
      name: "ccpl",
      remark,
      baseUrl: root,
      apiKey: token,
      settingsConfig: JSON.parse(claudeTemplateJson(root, token, claudeEnv)) as unknown,
    },
    codex: {
      name: "ccpl",
      remark,
      baseUrl: v1,
      apiKey: token,
      model: codexModel,
      settingsConfig: {
        config: buildCodexConfigToml("ccpl", v1, codexModel, "responses"),
        auth: { OPENAI_API_KEY: token },
      },
    },
    grok: {
      name: "ccpl",
      remark,
      baseUrl: v1,
      apiKey: token,
      model: grokModel,
    },
  };
}

/** Write the three channels; with `activate`, also make them the current
 *  channel of each engine. Throws on the first failed write. */
export async function applyCcplChannels(
  baseUrl: string,
  token: string,
  username: string,
  activate: boolean,
): Promise<void> {
  const channels = buildCcplChannels(baseUrl, token, username);
  try {
    for (const engine of CCPL_ENGINES) {
      await ipc.upsertProvider(engine, CCPL_CHANNEL_ID, channels[engine]);
      if (activate) await ipc.setCurrentProvider(engine, CCPL_CHANNEL_ID);
    }
  } finally {
    notifyCliConfigChanged();
  }
}
