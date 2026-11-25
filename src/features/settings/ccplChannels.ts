/** Channel records written after signing in to a ccpl account: a `ccpl`
 *  channel for the engine the token's group serves (Claude, Codex or Grok),
 *  built from the same presets the provider dialog offers, carrying the
 *  account's token. A fixed id keeps a re-login (or a rotated token) updating
 *  the same channel instead of piling up copies.
 *
 *  A ccpl token belongs to exactly one group and the group's type decides the
 *  client it accepts, so the same token written into the other engines would
 *  only be rejected there. When the type is unknown (old server, lookup
 *  failed) all three are written as before. 反重力（Gemini）分组写进 Codex 引擎的渠道，见 ccplEnginesFor。 */

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

/** Engines a token of this group type works with.
 *  反重力（Gemini）分组走 Codex 引擎：ccpl 在 Codex 用的同一个 /v1/responses 接口上服务它
 *  （工具调用也通），并按 gemini-* 模型名把请求分到反重力分组。桌面端自带的「反重力（agy）」引擎
 *  跑的是本机官方 CLI、用本机自己的 Google 登录，没有服务器地址可配，接不了 ccpl 令牌。 */
export function ccplEnginesFor(provider: CcplProvider | ""): readonly CcplEngine[] {
  switch (provider) {
    case "anthropic":
      return ["claude"];
    case "codex":
    case "antigravity":
      return ["codex"];
    case "grok":
      return ["grok"];
    default:
      return CCPL_ENGINES;
  }
}

/** ccpl 反重力分组默认提供的 Gemini 模型（和服务端给这类分组的兜底模型列表一致）。
 *  令牌没有 Codex 分组时第一个当 Codex 渠道的默认模型；其余写进渠道的 extraModels，
 *  Codex 引擎的模型列表里就能选到。 */
export const CCPL_GEMINI_MODELS = ["gemini-4-neon", "gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"] as const;

/** 按令牌能用的分组类型决定 Codex 渠道的模型：有 Codex 分组时沿用 Codex 预设的模型；
 *  只有反重力分组时默认模型改成 Gemini（GPT 模型名在这个令牌上分不到任何分组）。
 *  只要有反重力分组，Gemini 模型都会加进模型列表。 */
export function ccplCodexModels(providers: readonly (CcplProvider | "")[]): { model?: string; extraModels: string[] } {
  if (!providers.includes("antigravity")) return { extraModels: [] };
  if (providers.includes("codex")) return { extraModels: [...CCPL_GEMINI_MODELS] };
  const [model, ...rest] = CCPL_GEMINI_MODELS;
  return { model, extraModels: rest };
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
  codex: { model?: string; extraModels?: readonly string[] } = {},
): Record<CcplEngine, Record<string, unknown>> {
  const root = rootOf(baseUrl);
  const v1 = `${root}/v1`;
  const remark = username ? `ccpl · ${username}` : "ccpl";
  const claudeEnv = ccplPreset("claude")?.env ?? {};
  const codexModel = codex.model || ccplPreset("codex")?.model || "gpt-5.1-codex";
  const codexExtra = (codex.extraModels ?? []).filter((m) => m && m !== codexModel);
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
      // 渠道除 model 之外还能服务的模型（反重力分组的 Gemini 模型），模型列表会把它们列出来，见 use-engine-models。
      ...(codexExtra.length > 0 ? { extraModels: codexExtra } : {}),
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
  /** 令牌能用反重力分组、Gemini 模型已经加进 Codex 渠道（登录提示据此告诉用户去 Codex 里选）。 */
  geminiViaCodex?: boolean;
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
  const providers: readonly (CcplProvider | "")[] = typeof provider === "string" ? [provider] : provider;
  const channels = buildCcplChannels(baseUrl, token, username, ccplCodexModels(providers));
  const targets = ccplEnginesForAll(providers);
  const result: CcplApplyResult = { written: [], removed: [] };
  try {
    for (const engine of targets) {
      await ipc.upsertProvider(engine, CCPL_CHANNEL_ID, channels[engine]);
      if (activate) await ipc.setCurrentProvider(engine, CCPL_CHANNEL_ID);
      result.written.push(engine);
    }
    if (providers.includes("antigravity") && result.written.includes("codex")) result.geminiViaCodex = true;
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
  synced = false;
}

let synced = false;

function sameModels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

type CliConfigView = Record<string, { providers?: Record<string, unknown>; current?: unknown } | undefined>;

/** The token stored in any existing ccpl channel (the account status only has a hint). */
function storedCcplToken(config: CliConfigView): string {
  for (const engine of CCPL_ENGINES) {
    const channel = config[engine]?.providers?.[CCPL_CHANNEL_ID] as { apiKey?: unknown } | undefined;
    if (typeof channel?.apiKey === "string" && channel.apiKey) return channel.apiKey;
  }
  return "";
}

/** Once per app session, for an account that is already signed in: ask the
 *  server which group types the token has now and bring the channels in line
 *  when they differ — a channel missing for an engine the token can use, or
 *  the Codex channel's Gemini models out of date (the account was signed in on
 *  a version without 反重力 support, or the admin added a 反重力 group later).
 *  Without this, such users had to sign out and in again to see the Gemini
 *  models. An engine with no current channel gets the new one as current; an
 *  engine already pointing elsewhere is left alone. */
export async function syncCcplChannels(status: { baseUrl: string; username: string; provider: CcplProvider | "" }): Promise<boolean> {
  if (synced) return false;
  synced = true;
  try {
    const me = await ipc.ccplMe("24h").catch(() => null);
    const providers: readonly CcplProvider[] = me?.providers?.length ? me.providers : status.provider ? [status.provider] : [];
    if (providers.length === 0 || !status.baseUrl) return false;
    const config = (await ipc.getCliConfig()) as unknown as CliConfigView;
    const token = storedCcplToken(config);
    if (!token) return false;
    const targets = ccplEnginesForAll(providers);
    const missing = targets.filter((engine) => !config[engine]?.providers?.[CCPL_CHANNEL_ID]);
    const codex = config.codex?.providers?.[CCPL_CHANNEL_ID] as { extraModels?: unknown } | undefined;
    const want = ccplCodexModels(providers).extraModels;
    const have = Array.isArray(codex?.extraModels) ? (codex.extraModels as unknown[]).map(String) : [];
    const staleModels = targets.includes("codex") && !!codex && !sameModels(have, want);
    if (missing.length === 0 && !staleModels) return false;
    await applyCcplChannels(status.baseUrl, token, status.username, false, providers);
    for (const engine of missing) {
      if (!config[engine]?.current) await ipc.setCurrentProvider(engine, CCPL_CHANNEL_ID);
    }
    return true;
  } catch {
    synced = false;
    return false;
  }
}
