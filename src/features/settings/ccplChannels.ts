/** Channel records written after signing in to a ccpl account: a `ccpl`
 *  channel for the engine the token's group serves (Claude, Codex or Grok),
 *  built from the same presets the provider dialog offers, carrying the
 *  account's token. A fixed id keeps a re-login (or a rotated token) updating
 *  the same channel instead of piling up copies.
 *
 *  A ccpl token belongs to exactly one group and the group's type decides the
 *  client it accepts, so the same token written into the other engines would
 *  only be rejected there. When the type is unknown (old server, lookup
 *  failed) all three are written as before. */

import { ipc, type CcplProvider } from "@/lib/ipc";
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

/** Engines a token of this group type works with. Antigravity (Gemini) groups
 *  have no engine here yet: ccpl only accepts chat-completions clients there
 *  and still degrades tool calls to text, which coding agents cannot use. */
export function ccplEnginesFor(provider: CcplProvider | ""): readonly CcplEngine[] {
  switch (provider) {
    case "anthropic":
      return ["claude"];
    case "codex":
      return ["codex"];
    case "grok":
      return ["grok"];
    case "antigravity":
      return [];
    default:
      return CCPL_ENGINES;
  }
}

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

export interface CcplApplyResult {
  written: CcplEngine[];
  /** Other engines' ccpl channels removed because they carried this very
   *  token, which their group would reject. */
  removed: CcplEngine[];
}

/** Write the channel(s) for the token's group; with `activate`, also make
 *  them current. When the group type is known, ccpl channels left on the other
 *  engines by an earlier sign-in are removed if they still carry this token
 *  (they cannot work); channels the user re-pointed at another token stay.
 *  Throws on the first failed write. */
export async function applyCcplChannels(
  baseUrl: string,
  token: string,
  username: string,
  activate: boolean,
  provider: CcplProvider | "" = "",
): Promise<CcplApplyResult> {
  const channels = buildCcplChannels(baseUrl, token, username);
  const targets = ccplEnginesFor(provider);
  const result: CcplApplyResult = { written: [], removed: [] };
  try {
    for (const engine of targets) {
      await ipc.upsertProvider(engine, CCPL_CHANNEL_ID, channels[engine]);
      if (activate) await ipc.setCurrentProvider(engine, CCPL_CHANNEL_ID);
      result.written.push(engine);
    }
    if (provider) {
      const stale = CCPL_ENGINES.filter((engine) => !targets.includes(engine));
      if (stale.length > 0) {
        const config = await ipc.getCliConfig();
        for (const engine of stale) {
          const existing = config[engine]?.providers?.[CCPL_CHANNEL_ID] as { apiKey?: unknown } | undefined;
          if (existing && existing.apiKey === token) {
            await ipc.deleteProvider(engine, CCPL_CHANNEL_ID);
            result.removed.push(engine);
          }
        }
      }
    }
  } finally {
    notifyCliConfigChanged();
  }
  return result;
}
