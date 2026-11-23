import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import CircleUser from "lucide-react/dist/esm/icons/circle-user";
import LogIn from "lucide-react/dist/esm/icons/log-in";
import LogOut from "lucide-react/dist/esm/icons/log-out";
import Settings from "lucide-react/dist/esm/icons/settings";
import UserRound from "lucide-react/dist/esm/icons/user-round";
import { cx } from "@/utils/cx";
import {
  Dropdown,
  DropdownDivider,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import { ipc } from "@/lib/ipc";
import { useAccountStore, type AccountQuota } from "./account-store";
import { initials } from "./account-usage";

export const ACCOUNT_SETTINGS_PATH = "/settings?page=ccplAccount";

/** Round initials badge; a person glyph when there is no name. */
export function AccountAvatar({ name, size = "sm" }: { name: string; size?: "sm" | "lg" }) {
  const letters = initials(name);
  return (
    <span
      aria-hidden
      className={cx(
        "flex shrink-0 items-center justify-center rounded-full bg-button-primary font-medium text-text-white select-none",
        size === "lg" ? "size-16 text-title-3-medium" : "size-6 text-caption-1-medium",
      )}
    >
      {letters || <UserRound className={size === "lg" ? "size-8" : "size-3.5"} />}
    </span>
  );
}

/** One-line quota state under the name; null before the 账号 page fetched it. */
export function quotaLine(t: (key: string, options?: Record<string, unknown>) => string, quota: AccountQuota | null) {
  if (!quota) return null;
  if (quota.quotaPending) return t("account.quotaPendingShort");
  const spent = `$${quota.dailySpent.toFixed(2)}`;
  return quota.dailyLimit > 0
    ? t("account.quotaToday", { spent, limit: `$${quota.dailyLimit.toFixed(2)}` })
    : t("account.quotaTodayUnlimited", { spent });
}

/**
 * Sidebar footer account entry (replaces the bare 设置 row): avatar + name,
 * opening a menu with 个人资料 / 设置 / 退出登录 (or 登录 / 注册 when signed
 * out). Reads only the saved account and the last fetched quota — opening
 * the menu never calls the server.
 */
export function AccountMenu({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { t } = useTranslation();
  const status = useAccountStore((s) => s.status);
  const quota = useAccountStore((s) => s.quota);
  const load = useAccountStore((s) => s.load);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const signedIn = !!status?.signedIn;
  const name = signedIn ? status!.username || t("account.unnamed") : "";
  const go = (path: string) => {
    setOpen(false);
    onNavigate(path);
  };
  const logout = async () => {
    setOpen(false);
    try {
      await ipc.ccplLogout();
    } finally {
      // Re-read the saved account: gone after a successful logout, unchanged
      // (still signed in) if removing the file failed.
      await load();
    }
  };
  const line = signedIn ? quotaLine(t, quota) : null;

  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <DropdownTrigger
        aria-label={signedIn ? t("account.menuLabel", { name }) : t("account.signInOrRegister")}
        className="flex w-full items-center gap-2 rounded-2lg p-2 transition-colors duration-150 ease hover:bg-background-secondary-hover"
      >
        {signedIn ? (
          <AccountAvatar name={name} />
        ) : (
          <CircleUser className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
        )}
        <span className="truncate text-body-2-medium text-text-secondary">
          {signedIn ? name : t("account.signInOrRegister")}
        </span>
      </DropdownTrigger>
      <DropdownPopover aria-label={t("account.title")} placement="top start" offset={6}>
        {signedIn && (
          <>
            <div className="flex items-center gap-2 px-2 py-1.5">
              <AccountAvatar name={name} />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-body-2-medium text-text-primary">{name}</span>
                {line && <span className="truncate text-caption-1-regular text-text-tertiary">{line}</span>}
              </div>
            </div>
            <DropdownDivider />
          </>
        )}
        {signedIn ? (
          <DropdownItem onSelect={() => go(ACCOUNT_SETTINGS_PATH)}>
            <UserRound className="size-4 text-foreground-icon-secondary" aria-hidden />
            <span className="text-body-2-regular">{t("account.profile")}</span>
          </DropdownItem>
        ) : (
          <DropdownItem onSelect={() => go(ACCOUNT_SETTINGS_PATH)}>
            <LogIn className="size-4 text-foreground-icon-secondary" aria-hidden />
            <span className="text-body-2-regular">{t("account.signInOrRegister")}</span>
          </DropdownItem>
        )}
        <DropdownItem onSelect={() => go("/settings")}>
          <Settings className="size-4 text-foreground-icon-secondary" aria-hidden />
          <span className="text-body-2-regular">{t("settings.title")}</span>
        </DropdownItem>
        {signedIn && (
          <>
            <DropdownDivider />
            <DropdownItem onSelect={() => void logout()}>
              <LogOut className="size-4 text-foreground-icon-secondary" aria-hidden />
              <span className="text-body-2-regular">{t("account.logout")}</span>
            </DropdownItem>
          </>
        )}
      </DropdownPopover>
    </Dropdown>
  );
}
