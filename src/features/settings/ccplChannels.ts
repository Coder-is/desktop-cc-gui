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
  CLAUDE_MODEL_ENV_KEYS,
  PRESETS,
  buildCodexConfigToml,
  claudeTemplateJson,
  type ProviderPreset,
} from "./providerPresets";

export const CCPL_CHANNEL_ID = "ccpl-account";
export const CCPL_ENGINES = ["claude", "codex", "grok"] as const;
export type CcplEngine = (typeof CCPL_ENGINES)[number];

/** Engines a token with these group types works with: a token can have a
 *  Claude group plus a Codex group. No known type writes all, as before. */
export function ccplEnginesForAll(providers: readonly (CcplProvider | "")[]): readonly CcplEngine[] {
  const known = providers.filter((p): p is CcplProvider => !!p);
  if (known.length === 0) return CCPL_ENGINES;
  return CCPL_ENGINES.filter((engine) => known.some((p) => ccplEnginesFor(p).includes(engine)));
}

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
      settingsConfig: JSON.parse(
        claudeTemplateJson(root, token, claudeEnv, { nativeModels: ccplPreset("claude")?.nativeModels }),
      ) as unknown,
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
  provider: CcplProvider | "" | readonly CcplProvider[] = "",
): Promise<CcplApplyResult> {
  const channels = buildCcplChannels(baseUrl, token, username);
  const providers: readonly (CcplProvider | "")[] = typeof provider === "string" ? [provider] : provider;
  const targets = ccplEnginesForAll(providers);
  const result: CcplApplyResult = { written: [], removed: [] };
  try {
    for (const engine of targets) {
      await ipc.upsertProvider(engine, CCPL_CHANNEL_ID, channels[engine]);
      if (activate) await ipc.setCurrentProvider(engine, CCPL_CHANNEL_ID);
      result.written.push(engine);
    }
    if (providers.some(Boolean)) {
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

/** Model ids earlier app versions wrote into the ccpl Claude channel: the
 *  generic template's tier defaults, the old 4.5 ccpl preset and the short-lived
 *  5.5 one. A value outside this set was typed by the user and is kept. */
const LEGACY_CCPL_MODEL_IDS = new Set([
  "claude-opus-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);

/** The ccpl Claude channel's settings without the model mapping earlier
 *  versions wrote (see the preset's nativeModels): legacy tier/model env values
 *  and the template's top-level `model: "opus"`. Values the user changed stay.
 *  Returns null when there is nothing to strip. */
export function withoutLegacyCcplModels(settings: unknown): Record<string, unknown> | null {
  if (!settings || typeof settings !== "object") return null;
  const next = { ...(settings as Record<string, unknown>) };
  let changed = false;
  if (next.model === "opus") {
    delete next.model;
    changed = true;
  }
  if (next.env && typeof next.env === "object") {
    const env = { ...(next.env as Record<string, unknown>) };
    for (const key of CLAUDE_MODEL_ENV_KEYS) {
      const value = env[key];
      if (typeof value === "string" && LEGACY_CCPL_MODEL_IDS.has(value)) {
        delete env[key];
        changed = true;
      }
    }
    next.env = env;
  }
  return changed ? next : null;
}

let migrated = false;

/** Once per app session: rewrite an existing ccpl Claude channel that still
 *  carries a legacy model mapping, so a re-login is not needed to get the
 *  CLI's own models. Token, endpoint and anything user-edited stay as they are. */
export async function migrateCcplChannels(): Promise<boolean> {
  if (migrated) return false;
  migrated = true;
  try {
    const config = await ipc.getCliConfig();
    const channel = config.claude?.providers?.[CCPL_CHANNEL_ID] as
      | (Record<string, unknown> & { settingsConfig?: unknown })
      | undefined;
    const next = withoutLegacyCcplModels(channel?.settingsConfig);
    if (!channel || !next) return false;
    await ipc.upsertProvider("claude", CCPL_CHANNEL_ID, { ...channel, settingsConfig: next });
    notifyCliConfigChanged();
    return true;
  } catch {
    // Best effort: a failed read or write leaves the channel as it was.
    migrated = false;
    return false;
  }
}

/** Test hook: allow another migration run. */
export function resetCcplMigrationForTests() {
  migrated = false;
}
