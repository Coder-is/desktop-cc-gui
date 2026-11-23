import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { CLI_CONFIG_CHANGED_EVENT } from "@/features/settings/providers";
import { sessionKey, useChatStore } from "../store";
import { channelNames, stalePin, type ChannelNames } from "../pinned-channel";

/**
 * Notice above an open session whose pinned channel is 官方配置 or a deleted
 * channel while the engine runs on a real channel — the state behind
 * "Not logged in · Please run /login" after signing in to ccpl. One click moves
 * the session to the engine's current channel; nothing changes on its own.
 */
export function PinnedChannelNotice({
  engine,
  sessionId,
  workspacePath,
}: {
  engine: string;
  sessionId: string | null;
  workspacePath: string;
}) {
  const { t } = useTranslation();
  const pinned = useChatStore((s) => {
    if (!sessionId) return null;
    const own = s.bySession[sessionKey(engine, sessionId, workspacePath)]?.activeProvider;
    if (own) return own;
    return s.sessions.find((m) => m.engine === engine && m.sessionId === sessionId)?.provider ?? null;
  });
  const current = useChatStore((s) => s.providers[engine]);
  const setProvider = useChatStore((s) => s.setProvider);
  const [names, setNames] = useState<ChannelNames>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      ipc
        .getCliConfig?.()
        ?.then((config) => {
          if (!cancelled) setNames(channelNames((config as unknown as Record<string, { providers?: Record<string, unknown> }>)[engine]));
        })
        .catch(() => {});
    };
    load();
    window.addEventListener(CLI_CONFIG_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(CLI_CONFIG_CHANGED_EVENT, load);
    };
  }, [engine]);

  const pin = stalePin(pinned, current, names);
  if (!pin) return null;
  const currentName = names.get(pin.current) ?? pin.current;
  const message =
    pin.kind === "official"
      ? t("chat.pinnedChannelOfficial", { current: currentName })
      : t("chat.pinnedChannelMissing", { pinned: pin.pinned, current: currentName });
  return (
    <div
      role="status"
      className="mx-4 mt-3 flex min-w-0 shrink-0 items-center gap-2 rounded-lg border border-border-secondary bg-background-tertiary px-3 py-2 text-body-regular text-text-secondary"
    >
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={() => void setProvider(engine, pin.current)}
        className="shrink-0 cursor-pointer rounded px-2 py-0.5 text-text-primary hover:bg-background-tertiary-hover"
      >
        {t("chat.pinnedChannelSwitch", { current: currentName })}
      </button>
    </div>
  );
}
