import { PSEUDO_DISABLED, PSEUDO_LOCAL } from "@/features/settings/providers";

/** Channel names by id for one engine, read from the CLI config section. */
export type ChannelNames = ReadonlyMap<string, string>;

export interface StalePin {
  /** official: pinned to 官方配置; missing: pinned to a channel that was deleted. */
  kind: "official" | "missing";
  pinned: string;
  current: string;
}

/**
 * A session pinned to a channel the engine has since moved away from in a way
 * that usually breaks it: 官方配置 (the local CLI login, often absent once the
 * user runs on a relay channel) or a channel that no longer exists (e.g. the
 * ccpl channel removed when the ccpl token switched to another engine group).
 *
 * Sessions used to pin the engine default they first ran on, so many carry
 * 官方配置 without the user ever choosing it. Nothing is rewritten silently —
 * the notice offers moving the session to the engine's current channel.
 *
 * Returns null when nothing is pinned, the pin is a live channel, or the engine
 * has no usable current channel to move to.
 */
export function stalePin(
  pinned: string | null | undefined,
  current: string | null | undefined,
  channels: ChannelNames,
): StalePin | null {
  const pin = pinned?.trim();
  const now = current?.trim();
  if (!pin || !now || pin === now) return null;
  if (now === PSEUDO_LOCAL || now === PSEUDO_DISABLED || !channels.has(now)) return null;
  if (pin === PSEUDO_LOCAL) return { kind: "official", pinned: pin, current: now };
  if (pin === PSEUDO_DISABLED) return null;
  if (!channels.has(pin)) return { kind: "missing", pinned: pin, current: now };
  return null;
}

/** Channel id → display name for one engine's section of the CLI config. */
export function channelNames(section: { providers?: Record<string, unknown> } | null | undefined): ChannelNames {
  const names = new Map<string, string>();
  for (const [id, raw] of Object.entries(section?.providers ?? {})) {
    const name = (raw as { name?: unknown } | null)?.name;
    names.set(id, typeof name === "string" && name.trim() ? name.trim() : id);
  }
  return names;
}
