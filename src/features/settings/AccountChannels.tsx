import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { ipc, type CliConfig } from "@/lib/ipc";
import {
  CLI_CONFIG_CHANGED_EVENT,
  notifyCliConfigChanged,
  PSEUDO_DISABLED,
  PSEUDO_LOCAL,
} from "./providers";
import { CCPL_CHANNEL_ID, CCPL_ENGINES, type CcplEngine } from "./ccplChannels";

export type ChannelState =
  | { kind: "active" }
  | { kind: "disabled" }
  | { kind: "other"; current: string };

/** Per-engine state of the ccpl channel; engines without one are omitted. */
export function ccplChannelStates(config: CliConfig | null): { engine: CcplEngine; state: ChannelState }[] {
  if (!config) return [];
  return CCPL_ENGINES.flatMap((engine) => {
    const section = config[engine];
    if (!section?.providers?.[CCPL_CHANNEL_ID]) return [];
    const current = (section.current ?? "").trim();
    if (current === CCPL_CHANNEL_ID) return [{ engine, state: { kind: "active" } as ChannelState }];
    if (current === PSEUDO_DISABLED) return [{ engine, state: { kind: "disabled" } as ChannelState }];
    return [{ engine, state: { kind: "other", current: current || PSEUDO_LOCAL } as ChannelState }];
  });
}

/**
 * 设置 → 账号: which CLIs currently run on the ccpl channel (Claude Code's
 * /status, for this app). A channel switched away elsewhere gets a one-click
 * 切回; a disabled engine is only reported — re-enabling an engine is not
 * this page's call. Reads the local channel config only, no network.
 */
export function AccountChannels() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<CliConfig | null>(null);
  const [pending, setPending] = useState<CcplEngine | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    // A failed read (or a host without the command) hides the card; it must
    // never take the rest of the account page down with it.
    Promise.resolve()
      .then(() => ipc.getCliConfig())
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    reload();
    window.addEventListener(CLI_CONFIG_CHANGED_EVENT, reload);
    return () => window.removeEventListener(CLI_CONFIG_CHANGED_EVENT, reload);
  }, [reload]);

  const switchBack = async (engine: CcplEngine) => {
    setPending(engine);
    setError(null);
    try {
      await ipc.setCurrentProvider(engine, CCPL_CHANNEL_ID);
      notifyCliConfigChanged();
    } catch (e) {
      setError(t("account.switchFailed", { detail: String(e) }));
    } finally {
      setPending(null);
    }
  };

  const channelName = (engine: CcplEngine, id: string) => {
    if (id === PSEUDO_LOCAL) return t("settings.cliOfficial");
    const entry = config?.[engine]?.providers?.[id] as { name?: unknown } | undefined;
    return typeof entry?.name === "string" && entry.name.trim() ? entry.name : id;
  };

  const states = ccplChannelStates(config);
  if (!config) return null;

  return (
    <div className="flex w-full flex-col gap-2">
      <SettingsSectionLabel>{t("account.channels")}</SettingsSectionLabel>
      <SettingsCard>
        {states.length === 0 ? (
          <SettingsRow anchor="ccplChannelsNone" label={t("account.channelsNone")} description={t("account.channelsNoneDesc")}>
            <span />
          </SettingsRow>
        ) : (
          states.map(({ engine, state }) => (
            <SettingsRow
              key={engine}
              anchor={`ccplChannel-${engine}`}
              label={t(`settings.engines.${engine}`, { defaultValue: engine })}
              description={
                state.kind === "other"
                  ? t("account.channelOtherDesc", { channel: channelName(engine, state.current) })
                  : state.kind === "disabled"
                    ? t("account.channelDisabledDesc")
                    : undefined
              }
            >
              {state.kind === "active" ? (
                <span className="text-body-2-regular text-state-success-text">{t("account.channelActive")}</span>
              ) : state.kind === "disabled" ? (
                <span className="text-body-2-regular text-text-tertiary">{t("account.channelDisabled")}</span>
              ) : (
                <Button size="xs" disabled={pending !== null} onClick={() => void switchBack(engine)}>
                  {t("account.channelSwitchBack")}
                </Button>
              )}
            </SettingsRow>
          ))
        )}
      </SettingsCard>
      {error && (
        <p role="alert" className="px-3 text-body-2-regular text-text-error-primary">
          {error}
        </p>
      )}
    </div>
  );
}
