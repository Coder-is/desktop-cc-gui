import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { ModalShell } from "@/components/dialogs";
import type { BotGroup } from "@/lib/ipc";
import { useBotStore, visibleBots } from "@/features/bots/bot-store";
import { BotAvatarView } from "@/features/bots/bot-avatar";
import { useChatStore } from "@/features/chat/store";
import { engineDisplayName } from "@/features/mission/components/execution-format";
import { defaultEngineFor, defaultWorkspaceFor, newId, usableEngines } from "../runtime";
import { useBotTeamStore } from "../store";
import { fieldClass, labelClass } from "./ui";

const MIN_MEMBERS = 2;
const MAX_MEMBERS = 6;

/** 新建 / 编辑群聊：名称、成员（2–6 个 Bot）、引擎、工作目录、轮数上限。 */
export function GroupEditor({ group, onClose }: { group: BotGroup | null; onClose: () => void }) {
  const { t } = useTranslation();
  const bots = visibleBots(useBotStore((s) => s.bots));
  const workspaces = useChatStore((s) => s.workspaces);
  const saveGroup = useBotTeamStore((s) => s.saveGroup);
  const select = useBotTeamStore((s) => s.select);
  const engines = usableEngines();

  const [name, setName] = useState(group?.name ?? "");
  const [members, setMembers] = useState<string[]>(group?.memberBotIds ?? []);
  const firstBot = bots.find((b) => b.id === members[0]) ?? null;
  const [engine, setEngine] = useState(group?.engine ?? defaultEngineFor(firstBot));
  const [workspacePath, setWorkspacePath] = useState(group?.workspacePath ?? defaultWorkspaceFor(firstBot));
  const [maxRounds, setMaxRounds] = useState(String(group?.maxRounds ?? 3));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setMembers((list) =>
      list.includes(id) ? list.filter((m) => m !== id) : list.length >= MAX_MEMBERS ? list : [...list, id],
    );

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveGroup({
        id: group?.id ?? newId("group"),
        name,
        memberBotIds: members,
        engine,
        workspacePath,
        model: group?.model ?? null,
        providerId: group?.providerId ?? null,
        maxRounds: Number(maxRounds) || 3,
        maxBotMessagesPerSend: group?.maxBotMessagesPerSend ?? 10,
        memberSessions: group?.memberSessions ?? {},
        needsUser: group?.needsUser ?? false,
        createdAt: group?.createdAt ?? 0,
        updatedAt: group?.updatedAt ?? 0,
      });
      select({ kind: "group", id: saved.id });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const workspaceKnown = workspaces.some((w) => w.path === workspacePath);
  const memberCountOk = members.length >= MIN_MEMBERS && members.length <= MAX_MEMBERS;

  return (
    <ModalShell
      onClose={onClose}
      label={group ? t("botTeam.editGroup") : t("botTeam.newGroup")}
      className="w-[min(560px,calc(100vw-2rem))] p-6"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <h2 className="text-title-3-medium text-text-primary">{group ? t("botTeam.editGroup") : t("botTeam.newGroup")}</h2>
        <label className="block">
          <span className={labelClass}>{t("botTeam.groupName")}</span>
          <input className={fieldClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <fieldset>
          <legend className={labelClass}>{t("botTeam.groupMembers", { min: MIN_MEMBERS, max: MAX_MEMBERS })}</legend>
          {bots.length === 0 ? (
            <p className="mt-1 text-caption-1-regular text-text-tertiary">{t("botTeam.noBots")}</p>
          ) : (
            <div className="mt-1 grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto">
              {bots.map((bot) => {
                const checked = members.includes(bot.id);
                return (
                  <label
                    key={bot.id}
                    className={
                      "flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 transition-colors duration-150 " +
                      (checked
                        ? "border-button-primary bg-status-blue-background/20"
                        : "border-border-button-default hover:bg-background-secondary-hover")
                    }
                  >
                    <input type="checkbox" className="sr-only" checked={checked} onChange={() => toggle(bot.id)} />
                    <BotAvatarView avatar={bot.avatar} seed={bot.id} size={20} title={bot.name} />
                    <span className="min-w-0 flex-1 truncate text-body-2-regular text-text-primary">{bot.name}</span>
                    <span className="text-caption-1-regular text-text-tertiary">@{bot.slug}</span>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelClass}>{t("botTeam.engine")}</span>
            <select className={fieldClass} value={engine} onChange={(e) => setEngine(e.target.value)}>
              {!engines.some((e) => e.id === engine) && <option value={engine}>{engineDisplayName(engine)}</option>}
              {engines.map((info) => (
                <option key={info.id} value={info.id}>
                  {engineDisplayName(info.id)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelClass}>{t("botTeam.maxRounds")}</span>
            <input
              className={fieldClass}
              type="number"
              min={1}
              max={10}
              value={maxRounds}
              onChange={(e) => setMaxRounds(e.target.value)}
            />
          </label>
        </div>
        <label className="block">
          <span className={labelClass}>{t("botTeam.workspace")}</span>
          <select className={fieldClass} value={workspacePath} onChange={(e) => setWorkspacePath(e.target.value)}>
            {!workspaceKnown && <option value={workspacePath}>{workspacePath || t("botTeam.pickWorkspace")}</option>}
            {workspaces.map((w) => (
              <option key={w.id} value={w.path}>
                {w.name} — {w.path}
              </option>
            ))}
          </select>
        </label>
        <p className="text-caption-1-regular text-text-tertiary">{t("botTeam.groupPermissionNote")}</p>
        {error && <p className="text-caption-1-regular text-status-rose-text">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button size="small" variant="secondary" type="button" onClick={onClose}>
            {t("botTeam.cancel")}
          </Button>
          <Button size="small" type="submit" disabled={saving || !name.trim() || !memberCountOk || !workspacePath}>
            {t("botTeam.save")}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}
