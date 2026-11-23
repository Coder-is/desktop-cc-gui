import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import KeyRound from "lucide-react/dist/esm/icons/key-round";
import LogIn from "lucide-react/dist/esm/icons/log-in";
import LogOut from "lucide-react/dist/esm/icons/log-out";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import UserPlus from "lucide-react/dist/esm/icons/user-plus";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Switch } from "@/components/base/switch/switch";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import {
  ipc,
  type CcplAccountStatus,
  type CcplCaptcha,
  type CcplMe,
  type CcplProvider,
  type CcplServerInfo,
  type CcplSession,
} from "@/lib/ipc";
import { CCPL_BASE_URL } from "./providerPresets";
import { AccountProfileHeader, AccountUsagePanel } from "./AccountProfile";
import { AccountChannels } from "./AccountChannels";
import { useAccountStore } from "./account-store";
import { applyCcplChannels, type CcplEngine } from "./ccplChannels";

type Mode = "login" | "register" | "token";
type Range = "24h" | "7d" | "30d";

/** Brand-literal engine names, as in CLI_DISPLAY_NAMES. */
const ENGINE_NAMES: Record<CcplEngine, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };
const GROUP_NAMES: Record<CcplProvider, string> = {
  anthropic: "Claude",
  codex: "Codex",
  grok: "Grok",
  antigravity: "Gemini (Antigravity)",
};

function engineList(engines: CcplEngine[]): string {
  return engines.map((engine) => ENGINE_NAMES[engine]).join(" / ");
}

interface CcplError {
  status?: number;
  message?: string;
  captchaRequired?: boolean;
  retryAfter?: number | null;
  network?: string;
}

/** Backend errors arrive as a JSON string (see ccpl_account.rs error_text);
 *  anything else is shown as-is. */
export function parseCcplError(e: unknown): CcplError {
  const text = String(e);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as CcplError;
  } catch {
    // plain string
  }
  return { message: text };
}

export function usd(nano: number): string {
  return `$${(nano / 1e9).toFixed(2)}`;
}

/**
 * 设置 → ccpl 账号: sign in to (or register on) a self-hosted ccpl pool,
 * write the account token into the ccpl channel of the engine its group
 * serves (Claude / Codex / Grok),
 * and show the account's daily quota and usage. Registration starts with no
 * quota; the ccpl admin grants a daily limit before the token can be used.
 * Network calls only run on page open and on the user's clicks.
 */
export function CcplAccountSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CcplAccountStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState(CCPL_BASE_URL);
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Token mode: an `sk-…` key issued elsewhere (e.g. the ccpl web console).
  const [token, setToken] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [server, setServer] = useState<CcplServerInfo | null>(null);
  const [captcha, setCaptcha] = useState<CcplCaptcha | null>(null);
  const [captchaCode, setCaptchaCode] = useState("");
  const [activate, setActivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Failure of the quota / usage query (`/v1/me`) only: shown inside the
  // server card, so a server without the account API does not paint the whole
  // page as broken while the local usage panel above works fine.
  const [meError, setMeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [me, setMe] = useState<CcplMe | null>(null);
  const [range, setRange] = useState<Range>("24h");

  // Mirror into the shared store so the sidebar avatar menu follows sign-in,
  // sign-out and the last fetched quota without asking the server itself.
  useEffect(() => {
    if (status) useAccountStore.getState().setStatus(status);
  }, [status]);
  useEffect(() => {
    useAccountStore.getState().setMe(me);
  }, [me]);

  const errorText = useCallback(
    (e: unknown): string => {
      const err = parseCcplError(e);
      if (err.message === "invalid_url") return t("ccplAccount.invalidUrl");
      if (err.message === "insecure_url") return t("ccplAccount.insecureUrl");
      if (err.message === "invalid_token") return t("ccplAccount.invalidToken");
      if (err.message === "not_ccpl_api") return t("ccplAccount.notCcplApi");
      if (err.network) return t("ccplAccount.networkError", { detail: err.network });
      if (err.status === 401 && !err.message) return t("ccplAccount.signedOut");
      return err.message || t("ccplAccount.unknownError");
    },
    [t],
  );

  const loadMe = useCallback(
    async (nextRange: Range) => {
      setBusy(true);
      setMeError(null);
      try {
        setMe(await ipc.ccplMe(nextRange));
      } catch (e) {
        setMe(null);
        setMeError(
          parseCcplError(e).message === "not_ccpl_api" ? t("account.serverNoQuota") : errorText(e),
        );
      } finally {
        setBusy(false);
      }
    },
    [errorText, t],
  );

  useEffect(() => {
    let cancelled = false;
    ipc
      .ccplAccountStatus()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        if (s.signedIn) {
          setBaseUrl(s.baseUrl);
          void loadMe("24h");
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
    // Mount-only: page open is the user's action that asks for the status.
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const refreshCaptcha = async () => {
    setCaptchaCode("");
    try {
      setCaptcha(await ipc.ccplCaptcha(baseUrl));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const switchMode = async (next: Mode) => {
    setMode(next);
    setError(null);
    if (next !== "register") return;
    setBusy(true);
    try {
      const info = await ipc.ccplServerInfo(baseUrl);
      setServer(info);
      if (info?.registration) await refreshCaptcha();
    } catch (e) {
      setServer(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (session: CcplSession) => {
    const notices: string[] = [];
    try {
      const result = await applyCcplChannels(
        session.baseUrl,
        session.token,
        session.username,
        activate,
        session.provider,
      );
      notices.push(
        result.written.length > 0
          ? t("ccplAccount.signedInOk", { engines: engineList(result.written) })
          : t("ccplAccount.signedInNoEngine", {
              group: session.provider ? GROUP_NAMES[session.provider] : "",
            }),
      );
      if (result.removed.length > 0) {
        notices.push(t("ccplAccount.removedStale", { engines: engineList(result.removed) }));
      }
    } catch (e) {
      setError(t("ccplAccount.applyFailed", { detail: String(e) }));
      notices.push(t("ccplAccount.signedIn"));
    }
    if (session.quotaPending) notices.push(t("ccplAccount.quotaPendingNote"));
    setPassword("");
    setToken("");
    setCaptcha(null);
    setCaptchaCode("");
    setStatus(await ipc.ccplAccountStatus());
    setNotice(notices.join(" "));
    await loadMe(range);
  };

  const submitToken = async () => {
    if (!token.trim()) {
      setError(t("ccplAccount.fillToken"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const session = await ipc.ccplTokenLogin({ baseUrl, token: token.trim() });
      setBusy(false);
      await finish(session);
    } catch (e) {
      setBusy(false);
      // 401/403 from /v1/me: the server does not accept this key (wrong, revoked or expired).
      const err = parseCcplError(e);
      setError(
        err.status === 401 || err.status === 403
          ? t("ccplAccount.tokenRejected", { detail: err.message || err.status })
          : errorText(e),
      );
    }
  };

  const submit = async () => {
    if (busy) return;
    if (mode === "token") {
      await submitToken();
      return;
    }
    if (!username.trim() || !password) {
      setError(t("ccplAccount.fillAll"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const form = {
      baseUrl,
      username: username.trim(),
      password,
      inviteCode: inviteCode.trim(),
      captchaId: captcha?.id ?? "",
      captchaCode: captchaCode.trim(),
    };
    try {
      const session = mode === "register" ? await ipc.ccplRegister(form) : await ipc.ccplLogin(form);
      setBusy(false);
      await finish(session);
    } catch (e) {
      setBusy(false);
      const err = parseCcplError(e);
      setError(errorText(e));
      // A captcha is single-use: fetch a fresh one whenever one is (or becomes) needed.
      if (mode === "register" || err.captchaRequired) await refreshCaptcha();
    }
  };

  const reapply = async () => {
    setError(null);
    setNotice(null);
    // The token is not exposed to the page outside sign-in; re-applying means signing in again.
    setStatus((s) => (s ? { ...s, signedIn: false } : s));
    setMe(null);
    setMode("login");
    setUsername(status?.username ?? "");
  };

  const logout = async () => {
    try {
      await ipc.ccplLogout();
      setStatus({ signedIn: false, baseUrl: "", username: "", tokenHint: "", provider: "" });
      setMe(null);
      setNotice(t("ccplAccount.loggedOut"));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const changeRange = (next: Range) => {
    setRange(next);
    void loadMe(next);
  };

  const signedIn = !!status?.signedIn;
  // The server's current group type (newer ccpl) wins over the one recorded at
  // sign-in; a difference means an admin moved the token and the channels
  // written back then no longer match.
  const currentGroup: CcplProvider | "" = me?.provider ?? status?.provider ?? "";
  const groupChanged = !!me?.provider && !!status?.provider && me.provider !== status.provider;
  const total = me?.usage?.total;
  const limitText =
    me && me.dailyLimit > 0 ? `${usd(me.dailySpent * 1e9)} / ${usd(me.dailyLimit * 1e9)}` : null;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex w-full flex-col gap-2">
        <SettingsSectionLabel>{t("ccplAccount.title")}</SettingsSectionLabel>
        <p className="px-3 text-body-2-regular text-text-secondary">{t("ccplAccount.desc")}</p>

        {signedIn ? (
          <>
            {status && <AccountProfileHeader status={status} me={me} />}
            <AccountUsagePanel />
            <SettingsSectionLabel>{t("account.serverSection")}</SettingsSectionLabel>
            <SettingsCard>
              <SettingsRow anchor="ccplUser" label={t("ccplAccount.account")}>
                <span className="text-body-2-regular text-text-primary">
                  {status?.username} · <span className="font-mono">{status?.tokenHint}</span>
                </span>
              </SettingsRow>
              <SettingsRow anchor="ccplServer" label={t("ccplAccount.server")}>
                <span className="font-mono text-body-2-regular text-text-secondary">{status?.baseUrl}</span>
              </SettingsRow>
              {meError && (
                <SettingsRow anchor="ccplServerStatus" label={t("account.serverStatus")}>
                  <span role="status" className="text-right text-body-2-regular text-text-tertiary">
                    {meError}
                  </span>
                </SettingsRow>
              )}
              {currentGroup && (
                <SettingsRow
                  anchor="ccplGroup"
                  label={t("ccplAccount.group")}
                  description={
                    groupChanged
                      ? t("ccplAccount.groupChanged", { group: GROUP_NAMES[currentGroup] })
                      : currentGroup === "antigravity"
                        ? t("ccplAccount.groupNoEngine")
                        : t("ccplAccount.groupDesc")
                  }
                >
                  <span
                    className={
                      groupChanged
                        ? "text-body-2-regular text-text-error-primary"
                        : "text-body-2-regular text-text-primary"
                    }
                  >
                    {GROUP_NAMES[currentGroup]}
                  </span>
                </SettingsRow>
              )}
              <SettingsRow
                anchor="ccplQuota"
                label={t("ccplAccount.dailyQuota")}
                description={me?.quotaPending ? t("ccplAccount.pendingDesc") : t("ccplAccount.quotaDesc")}
              >
                <span
                  className={
                    me?.quotaPending
                      ? "text-body-2-regular text-text-error-primary"
                      : "font-mono text-body-2-regular text-text-primary"
                  }
                >
                  {!me
                    ? "—"
                    : me.quotaPending
                      ? t("ccplAccount.pending")
                      : (limitText ?? t("ccplAccount.unlimited", { spent: usd(me.dailySpent * 1e9) }))}
                </span>
              </SettingsRow>
              {me?.expiresAt && (
                <SettingsRow anchor="ccplExpires" label={t("ccplAccount.expires")}>
                  <span className="font-mono text-body-2-regular text-text-secondary">
                    {new Date(me.expiresAt).toLocaleString()}
                  </span>
                </SettingsRow>
              )}
              {me && <SettingsRow anchor="ccplUsage" label={t("ccplAccount.usage")}>
                <div className="flex items-center gap-2">
                  {(["24h", "7d", "30d"] as const).map((r) => (
                    <Button
                      key={r}
                      size="xs"
                      variant={range === r ? "primary" : "ghost"}
                      disabled={busy}
                      onClick={() => changeRange(r)}
                    >
                      {t(`ccplAccount.range${r}`)}
                    </Button>
                  ))}
                </div>
              </SettingsRow>}
              {total && (
                <SettingsRow anchor="ccplUsageTotal" label={t("ccplAccount.usageTotal")}>
                  <span className="font-mono text-body-2-regular text-text-primary">
                    {t("ccplAccount.usageLine", {
                      requests: total.requests,
                      cost: usd(total.costNano),
                      tokens: (
                        total.inputTokens +
                        total.outputTokens +
                        total.cacheWriteTokens +
                        total.cacheReadTokens
                      ).toLocaleString(),
                    })}
                  </span>
                </SettingsRow>
              )}
              {me?.usage?.models?.map((row) => (
                <SettingsRow key={row.key} anchor={`ccplModel-${row.key}`} label={row.key}>
                  <span className="font-mono text-body-2-regular text-text-secondary">
                    {t("ccplAccount.modelLine", { requests: row.requests, cost: usd(row.costNano) })}
                  </span>
                </SettingsRow>
              ))}
            </SettingsCard>
            <AccountChannels />
            {me?.announcement?.text && (
              <p className="px-3 text-body-2-regular text-text-secondary">{t("ccplAccount.announcement", { text: me.announcement.text })}</p>
            )}
            <div className="flex flex-wrap items-center gap-3 px-3 pt-2">
              <Button size="small" leadingIcon={RefreshCw} disabled={busy} onClick={() => void loadMe(range)}>
                {t("ccplAccount.refresh")}
              </Button>
              <Button size="small" variant="ghost" disabled={busy} onClick={() => void reapply()}>
                {t("ccplAccount.relogin")}
              </Button>
              <Button size="small" variant="ghost" leadingIcon={LogOut} disabled={busy} onClick={() => void logout()}>
                {t("ccplAccount.logout")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 px-3">
              <Button size="xs" variant={mode === "login" ? "primary" : "ghost"} disabled={busy} onClick={() => void switchMode("login")}>
                {t("ccplAccount.login")}
              </Button>
              <Button size="xs" variant={mode === "register" ? "primary" : "ghost"} disabled={busy} onClick={() => void switchMode("register")}>
                {t("ccplAccount.register")}
              </Button>
              <Button size="xs" variant={mode === "token" ? "primary" : "ghost"} disabled={busy} onClick={() => void switchMode("token")}>
                {t("ccplAccount.tokenLogin")}
              </Button>
            </div>
            <SettingsCard>
              <SettingsRow anchor="ccplServerUrl" label={t("ccplAccount.server")} description={t("ccplAccount.serverDesc")}>
                <Input
                  aria-label={t("ccplAccount.server")}
                  size="small"
                  className="w-72"
                  value={baseUrl}
                  placeholder={CCPL_BASE_URL}
                  onChange={(v) => {
                    setBaseUrl(v);
                    setServer(null);
                    setCaptcha(null);
                  }}
                />
              </SettingsRow>
              {mode === "token" ? (
                <>
                  <SettingsRow anchor="ccplToken" label={t("ccplAccount.token")} description={t("ccplAccount.tokenDesc")}>
                    <Input
                      aria-label={t("ccplAccount.token")}
                      size="small"
                      className="w-72"
                      type="password"
                      value={token}
                      placeholder="sk-ccpl-…"
                      autoComplete="off"
                      onChange={setToken}
                    />
                  </SettingsRow>
                  <SettingsRow anchor="ccplActivate" label={t("ccplAccount.activate")} description={t("ccplAccount.activateDesc")}>
                    <Switch size="sm" aria-label={t("ccplAccount.activate")} isSelected={activate} onChange={setActivate} />
                  </SettingsRow>
                </>
              ) : mode === "register" && server && !server.registration ? (
                <SettingsRow anchor="ccplClosed" label={t("ccplAccount.register")}>
                  <span className="text-body-2-regular text-text-secondary">{t("ccplAccount.registrationClosed")}</span>
                </SettingsRow>
              ) : (
                <>
                  <SettingsRow anchor="ccplUsername" label={t("ccplAccount.username")}>
                    <Input
                      aria-label={t("ccplAccount.username")}
                      size="small"
                      className="w-56"
                      value={username}
                      autoComplete="username"
                      onChange={setUsername}
                    />
                  </SettingsRow>
                  <SettingsRow
                    anchor="ccplPassword"
                    label={t("ccplAccount.password")}
                    description={mode === "register" ? t("ccplAccount.passwordRule") : undefined}
                  >
                    <Input
                      aria-label={t("ccplAccount.password")}
                      size="small"
                      className="w-56"
                      type="password"
                      value={password}
                      autoComplete={mode === "register" ? "new-password" : "current-password"}
                      onChange={setPassword}
                    />
                  </SettingsRow>
                  {mode === "register" && server?.inviteRequired && (
                    <SettingsRow anchor="ccplInvite" label={t("ccplAccount.inviteCode")}>
                      <Input aria-label={t("ccplAccount.inviteCode")} size="small" className="w-56" value={inviteCode} onChange={setInviteCode} />
                    </SettingsRow>
                  )}
                  {captcha && (
                    <SettingsRow anchor="ccplCaptcha" label={t("ccplAccount.captcha")}>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="cursor-pointer rounded border border-border-secondary"
                          title={t("ccplAccount.captchaRefresh")}
                          onClick={() => void refreshCaptcha()}
                        >
                          {/* Server-drawn PNG data URL; no remote fetch from the webview. */}
                          <img src={captcha.image} alt={t("ccplAccount.captcha")} className="h-8" />
                        </button>
                        <Input aria-label={t("ccplAccount.captcha")} size="small" className="w-24" value={captchaCode} onChange={setCaptchaCode} />
                      </div>
                    </SettingsRow>
                  )}
                  <SettingsRow anchor="ccplActivate" label={t("ccplAccount.activate")} description={t("ccplAccount.activateDesc")}>
                    <Switch size="sm" aria-label={t("ccplAccount.activate")} isSelected={activate} onChange={setActivate} />
                  </SettingsRow>
                </>
              )}
            </SettingsCard>
            <div className="flex items-center gap-3 px-3 pt-2">
              <Button
                size="small"
                leadingIcon={mode === "register" ? UserPlus : mode === "token" ? KeyRound : LogIn}
                disabled={busy || (mode === "register" && (!server || !server.registration))}
                onClick={() => void submit()}
              >
                {mode === "register"
                  ? t("ccplAccount.registerSubmit")
                  : mode === "token"
                    ? t("ccplAccount.tokenSubmit")
                    : t("ccplAccount.loginSubmit")}
              </Button>
            </div>
            {mode === "register" && <p className="px-3 text-body-2-regular text-text-tertiary">{t("ccplAccount.registerHint")}</p>}
          </>
        )}
        {notice && <p className="px-3 text-body-2-regular text-state-success-text">{notice}</p>}
        {error && (
          <p role="alert" className="px-3 text-body-2-regular text-text-error-primary">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
