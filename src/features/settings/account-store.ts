import { migrateCcplChannels } from "./ccplChannels";
import { create } from "zustand";
import { ipc, type CcplAccountStatus, type CcplMe } from "@/lib/ipc";

/** What the sidebar avatar menu shows without asking the server: the saved
 *  account (local file read) plus the last quota the 账号 page fetched. The
 *  menu never triggers network calls — only the 账号 page does, on open and
 *  on the user's clicks. */
export interface AccountQuota {
  quotaPending: boolean;
  dailyLimit: number;
  dailySpent: number;
}

interface AccountState {
  status: CcplAccountStatus | null;
  quota: AccountQuota | null;
  /** Re-read the saved account (`ccpl-account.json`); no network. */
  load: () => Promise<void>;
  setStatus: (status: CcplAccountStatus | null) => void;
  setMe: (me: CcplMe | null) => void;
}

export const useAccountStore = create<AccountState>((set) => ({
  status: null,
  quota: null,
  load: async () => {
    try {
      const status = await ipc.ccplAccountStatus();
      set((state) => ({ status, quota: status.signedIn ? state.quota : null }));
      // 旧版本写进 ccpl 渠道的模型映射（列表显示 5.5、实际发 4.5）清掉，不用重新登录。
      if (status.signedIn) void migrateCcplChannels();
    } catch {
      // Web access has no account commands: the menu falls back to 登录 / 设置.
      set({ status: null, quota: null });
    }
  },
  setStatus: (status) => set((state) => ({ status, quota: status?.signedIn ? state.quota : null })),
  setMe: (me) =>
    set({
      quota: me
        ? { quotaPending: me.quotaPending, dailyLimit: me.dailyLimit, dailySpent: me.dailySpent }
        : null,
    }),
}));
