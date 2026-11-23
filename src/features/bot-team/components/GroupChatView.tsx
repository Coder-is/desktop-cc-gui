import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import Settings2 from "lucide-react/dist/esm/icons/settings-2";
import Square from "lucide-react/dist/esm/icons/square";
import { Button } from "@/components/base/buttons/button";
import { ConfirmDialog } from "@/components/dialogs";
import type { BotGroup } from "@/lib/ipc";
import { BotAvatarView } from "@/features/bots/bot-avatar";
import { botById, useBotStore } from "@/features/bots/bot-store";
import { USER_HANDLE } from "../group-chat";
import { resetGroup, sendGroupMessage, stopGroup } from "../runtime";
import { useBotTeamStore } from "../store";
import { GroupEditor } from "./GroupEditor";
import { formatTime } from "./ui";

/** 群聊窗口：消息按时间排列、@ 点名、停止、需要你徽标。 */
export function GroupChatView({ group }: { group: BotGroup }) {
  const { t } = useTranslation();
  // 订阅 bots：成员改名 / 换头像时消息头跟着刷新。
  const bots = useBotStore((s) => s.bots);
  const messages = useBotTeamStore((s) => s.messagesByGroup[group.id]);
  const speaking = useBotTeamStore((s) => s.groupSpeaking[group.id]);
  const paused = useBotTeamStore((s) => s.pausedByGroup[group.id]);
  const deleteGroup = useBotTeamStore((s) => s.deleteGroup);
  const loadMessages = useBotTeamStore((s) => s.loadMessages);
  const busy = speaking !== undefined;
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"clear" | "delete" | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadMessages(group.id).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [group.id, loadMessages]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length, speaking]);

  const members = useMemo(
    () => group.memberBotIds.map((id) => ({ id, bot: bots.find((b) => b.id === id) ?? null })),
    [group.memberBotIds, bots],
  );

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    sendGroupMessage(group.id, text).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  const insertMention = (slug: string) => setInput((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}@${slug} `);

  const runConfirm = async () => {
    const action = confirm;
    setConfirm(null);
    try {
      if (action === "clear") await resetGroup(group.id);
      if (action === "delete") await deleteGroup(group.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-separator-border px-5 py-3">
        <div className="flex -space-x-1.5">
          {members.slice(0, 4).map(({ id, bot }) => (
            <BotAvatarView key={id} avatar={bot?.avatar} seed={id} size={28} title={bot?.name} />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 truncate text-body-medium text-text-primary">
            {group.name}
            {group.needsUser && (
              <span className="rounded-sm bg-status-rose-background px-1.5 text-caption-1-medium text-status-rose-text">
                {t("botTeam.needsYou")}
              </span>
            )}
          </div>
          <div className="truncate text-caption-1-regular text-text-tertiary">
            {members.map(({ bot }) => (bot ? `@${bot.slug}` : t("botTeam.botMissing"))).join(" · ")}
          </div>
        </div>
        <Button size="small" variant="ghost" disabled={busy} onClick={() => setConfirm("clear")}>
          {t("botTeam.clear")}
        </Button>
        <Button size="small" variant="ghost" disabled={busy} onClick={() => setConfirm("delete")}>
          {t("botTeam.delete")}
        </Button>
        <Button
          size="small"
          variant="ghost"
          iconOnly
          leadingIcon={Settings2}
          aria-label={t("botTeam.editGroup")}
          disabled={busy}
          onClick={() => setEditing(true)}
        />
      </header>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {messages && messages.length === 0 && (
          <p className="mx-auto max-w-md py-10 text-center text-body-2-regular text-text-tertiary">{t("botTeam.groupEmpty")}</p>
        )}
        <ul className="space-y-4">
          {(messages ?? []).map((message) => {
            const isUser = message.author === USER_HANDLE;
            const bot = isUser ? null : botById(message.author);
            return (
              <li key={message.id} className={"flex gap-2.5 " + (isUser ? "flex-row-reverse" : "")}>
                {!isUser && <BotAvatarView avatar={bot?.avatar} seed={message.author} size={28} title={bot?.name} />}
                <div className={"min-w-0 max-w-[80%] " + (isUser ? "text-right" : "")}>
                  <div className="mb-0.5 text-caption-1-regular text-text-tertiary">
                    {isUser ? t("botTeam.you") : (bot?.name ?? t("botTeam.botMissing"))} · {formatTime(message.createdAt)}
                  </div>
                  <div
                    className={
                      "inline-block whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-left text-body-2-regular select-text " +
                      (message.status === "error"
                        ? "border border-status-rose-text/40 text-status-rose-text"
                        : isUser
                          ? "bg-status-blue-background/30 text-text-primary"
                          : "bg-background-secondary-default text-text-primary")
                    }
                  >
                    {message.status === "error" ? t("botTeam.memberFailed", { error: message.text }) : message.text}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {busy && (
          <p className="mt-4 text-caption-1-regular text-text-tertiary" aria-live="polite">
            {speaking
              ? t("botTeam.speaking", { name: botById(speaking)?.name ?? "…" })
              : t("botTeam.thinking")}
          </p>
        )}
      </div>

      <div className="shrink-0 px-5 pb-4">
        {paused && paused.length > 0 && (
          <p className="mb-1 text-caption-1-regular text-text-tertiary">
            {t("botTeam.pausedMembers", {
              names: paused.map((id) => botById(id)?.name ?? id).join("、"),
            })}
          </p>
        )}
        {error && <p className="mb-1 text-caption-1-regular text-status-rose-text">{error}</p>}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
          className="rounded-lg border border-border-button-default bg-background-primary-default p-2 shadow-xs transition-colors focus-within:border-status-blue-text/60"
        >
          <label htmlFor="bot-team-group-input" className="sr-only">
            {t("botTeam.groupInput")}
          </label>
          <textarea
            id="bot-team-group-input"
            value={input}
            rows={2}
            maxLength={8000}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
            placeholder={t("botTeam.groupPlaceholder")}
            className="w-full resize-y bg-transparent text-body-2-regular text-text-primary outline-none placeholder:text-text-placeholder"
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap gap-1">
              {members.map(({ id, bot }) =>
                bot ? (
                  <button
                    key={id}
                    type="button"
                    onClick={() => insertMention(bot.slug)}
                    className="cursor-pointer rounded-md border border-separator-border px-1.5 py-0.5 text-caption-1-regular text-text-secondary transition-colors hover:bg-background-secondary-hover"
                  >
                    @{bot.slug}
                  </button>
                ) : null,
              )}
            </div>
            {busy ? (
              <Button size="small" variant="secondary" leadingIcon={Square} type="button" onClick={() => stopGroup(group.id)}>
                {t("botTeam.stop")}
              </Button>
            ) : (
              <Button
                type="submit"
                size="small"
                iconOnly
                leadingIcon={ArrowUp}
                aria-label={t("botTeam.send")}
                disabled={input.trim() === ""}
              />
            )}
          </div>
        </form>
      </div>

      {editing && <GroupEditor group={group} onClose={() => setEditing(false)} />}
      {confirm && (
        <ConfirmDialog
          danger
          message={
            confirm === "clear"
              ? t("botTeam.confirmClear", { name: group.name })
              : t("botTeam.confirmDeleteGroup", { name: group.name })
          }
          confirmLabel={confirm === "clear" ? t("botTeam.clear") : t("botTeam.delete")}
          onConfirm={() => void runConfirm()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
