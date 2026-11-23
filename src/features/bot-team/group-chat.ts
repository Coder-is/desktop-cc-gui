import type { BotGroup, BotGroupMessage } from "@/lib/ipc";

/**
 * Bot 群聊的轮转（docs/plans/bots-upgrade-plan.zh-CN.md §11.2），纯逻辑：
 * 运行成员、落盘消息都由注入的 deps 完成，这里只决定「谁说、说几轮、何时停」。
 *
 *  - 用户 @ 了成员 → 本轮只有被 @ 的人发言；否则全部成员
 *  - 回复 `[PASS]` → 不显示、不算发言
 *  - 回复里 @ 了别的成员 → 下一轮加入他们
 *  - 回复里 @user → 群聊标记「需要你」，本次结束
 *  - 一轮没人发言 / 达到轮数上限 / 达到本次消息上限 / 用户点停止 → 结束
 *  - 「@某人 停」这类紧挨着 @ 的停止词暂停该成员（代码块与引用里的忽略）
 */

export interface GroupMember {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
}

export const USER_HANDLE = "user";
export const PASS_TOKEN = "[PASS]";
/** 每个成员一次看到的群消息上限（计划 §11.2：约 200 条或 32,000 字符）。 */
export const TRANSCRIPT_MESSAGE_LIMIT = 200;
export const TRANSCRIPT_CHAR_LIMIT = 32_000;

const STOP_WORDS = ["stop", "pause", "停", "停止", "暂停", "别说了"];

/** 去掉代码块、行内代码和引用行：这些地方的 @ 与停止词都不算数。 */
export function stripNonProse(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

export interface Mentions {
  /** 被 @ 的成员 id（按出现顺序去重）。 */
  botIds: string[];
  mentionsUser: boolean;
  /** 被「@x 停」暂停的成员 id。 */
  stopped: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseMentions(text: string, members: GroupMember[]): Mentions {
  const prose = stripNonProse(text);
  const found: { index: number; id: string }[] = [];
  const stopped: string[] = [];
  // 长 slug 先匹配，避免 @dev 抢走 @dev-ops。
  const ordered = [...members].sort((a, b) => b.slug.length - a.slug.length);
  const taken = new Set<number>();
  for (const member of ordered) {
    if (!member.slug) continue;
    const pattern = new RegExp(`@${escapeRegExp(member.slug)}(?![\\w-])`, "giu");
    for (const match of prose.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (taken.has(index)) continue;
      taken.add(index);
      found.push({ index, id: member.id });
      const after = prose.slice(index + match[0].length, index + match[0].length + 8);
      const before = prose.slice(Math.max(0, index - 6), index);
      const near = `${before} ${after}`.toLowerCase();
      if (STOP_WORDS.some((word) => near.includes(word)) && !stopped.includes(member.id)) {
        stopped.push(member.id);
      }
    }
  }
  found.sort((a, b) => a.index - b.index);
  const botIds: string[] = [];
  for (const { id } of found) if (!botIds.includes(id)) botIds.push(id);
  const mentionsUser = new RegExp(`@${USER_HANDLE}(?![\\w-])`, "iu").test(prose);
  return { botIds, mentionsUser, stopped };
}

export function isPass(reply: string): boolean {
  const trimmed = reply.trim();
  if (!trimmed) return true;
  return trimmed.toUpperCase().startsWith(PASS_TOKEN) && trimmed.length <= PASS_TOKEN.length + 40;
}

/** 群聊成员额外的规则（计划 §11.2 的固定文案）。 */
export function groupRules(group: Pick<BotGroup, "name">, members: GroupMember[], self: GroupMember): string {
  const roster = members
    .map((m) => `- @${m.slug}${m.id === self.id ? "（你）" : ""}：${m.name}${m.description ? ` - ${m.description}` : ""}`)
    .join("\n");
  return [
    "# 群聊规则",
    `你在群聊「${group.name}」中，你的身份是 @${self.slug}。成员有：`,
    roster,
    `- @${USER_HANDLE}：用户`,
    "",
    `- 只在你有新的、有价值的内容要补充时才发言，并且保持简短；否则只回复 ${PASS_TOKEN}`,
    "- 需要某位成员参与时，用 @slug 叫对方",
    `- 遇到需要用户拍板的事，用 @${USER_HANDLE} 提问，然后停止`,
    "- 不要重复别人已经说过的话，不要互相客套",
    "- 直接输出你要发到群里的内容，不要加自己的名字前缀",
  ].join("\n");
}

function authorLabel(author: string, members: GroupMember[]): string {
  if (author === USER_HANDLE) return `@${USER_HANDLE}`;
  const member = members.find((m) => m.id === author);
  return member ? `@${member.slug}` : "@unknown";
}

/** 该成员上次发言之后的群消息，按上限截断（超出时注明省略了多少条）。 */
export function transcriptSince(
  messages: BotGroupMessage[],
  memberId: string,
  members: GroupMember[],
): string {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].author === memberId) {
      start = i + 1;
      break;
    }
  }
  const slice = messages.slice(start).filter((m) => m.status !== "error");
  const lines: string[] = [];
  let chars = 0;
  let kept = 0;
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    const line = `${authorLabel(slice[i].author, members)}: ${slice[i].text}`;
    if (kept >= TRANSCRIPT_MESSAGE_LIMIT || chars + line.length > TRANSCRIPT_CHAR_LIMIT) break;
    lines.unshift(line);
    chars += line.length;
    kept += 1;
  }
  const omitted = slice.length - kept;
  const header = omitted > 0 ? `（更早的 ${omitted} 条消息已省略）\n` : "";
  return header + lines.join("\n\n");
}

export function buildMemberPrompt(input: {
  group: Pick<BotGroup, "name">;
  members: GroupMember[];
  self: GroupMember;
  messages: BotGroupMessage[];
}): string {
  const transcript = transcriptSince(input.messages, input.self.id, input.members);
  return [
    groupRules(input.group, input.members, input.self),
    "",
    "# 群里的新消息（自你上次发言以来）",
    transcript || "（没有新消息）",
    "",
    `现在轮到你（@${input.self.slug}）。有价值就简短发言，否则只回复 ${PASS_TOKEN}。`,
  ].join("\n");
}

export interface RotationDeps {
  group: BotGroup;
  members: GroupMember[];
  /** 当前完整的群消息（含刚发出的用户消息）；运行中会被追加。 */
  messages: BotGroupMessage[];
  /** 运行一个成员，返回它的原始回复。抛错 = 该成员这次失败。 */
  runMember: (member: GroupMember, prompt: string) => Promise<string>;
  /** 落盘并展示一条消息。 */
  append: (message: BotGroupMessage) => Promise<void> | void;
  newMessageId: () => string;
  now: () => number;
  /** 用户点了停止。 */
  shouldStop: () => boolean;
  /** 「正在思考」指示。 */
  onSpeaking?: (memberId: string | null) => void;
}

export interface RotationOutcome {
  botMessages: number;
  rounds: number;
  needsUser: boolean;
  stoppedByUser: boolean;
  /** 被「@x 停」暂停的成员（本次之后仍然暂停，直到用户再次 @ 它）。 */
  paused: string[];
}

/** 用户发了一条消息之后的整轮群聊。 */
export async function runRotation(
  deps: RotationDeps,
  userMessage: BotGroupMessage,
  pausedBefore: string[] = [],
): Promise<RotationOutcome> {
  const { group, members } = deps;
  const userMentions = parseMentions(userMessage.text, members);
  const paused = new Set(pausedBefore);
  // 用户再次 @ 的成员解除暂停；「@x 停」的成员加入暂停。
  for (const id of userMentions.botIds) paused.delete(id);
  for (const id of userMentions.stopped) paused.add(id);
  const active = (ids: string[]) => ids.filter((id) => !paused.has(id));
  const allIds = members.map((m) => m.id);
  const explicit = userMentions.botIds.filter((id) => !userMentions.stopped.includes(id));
  let speakers = active(explicit.length > 0 ? explicit : allIds);

  let rounds = 0;
  let botMessages = 0;
  let needsUser = false;
  let stoppedByUser = false;

  outer: while (rounds < group.maxRounds && botMessages < group.maxBotMessagesPerSend) {
    rounds += 1;
    let anyoneSpoke = false;
    const mentionedNext: string[] = [];
    for (const id of speakers) {
      if (deps.shouldStop()) {
        stoppedByUser = true;
        break outer;
      }
      if (botMessages >= group.maxBotMessagesPerSend) break outer;
      const member = members.find((m) => m.id === id);
      if (!member) continue;
      deps.onSpeaking?.(member.id);
      const prompt = buildMemberPrompt({ group, members, self: member, messages: deps.messages });
      let reply: string;
      try {
        reply = await deps.runMember(member, prompt);
      } catch (error) {
        if (deps.shouldStop()) {
          stoppedByUser = true;
          break outer;
        }
        const failed: BotGroupMessage = {
          id: deps.newMessageId(),
          groupId: group.id,
          author: member.id,
          text: error instanceof Error ? error.message : String(error),
          createdAt: deps.now(),
          status: "error",
        };
        deps.messages.push(failed);
        await deps.append(failed);
        continue;
      }
      if (deps.shouldStop()) {
        stoppedByUser = true;
        break outer;
      }
      if (isPass(reply)) continue;
      const message: BotGroupMessage = {
        id: deps.newMessageId(),
        groupId: group.id,
        author: member.id,
        text: reply.trim(),
        createdAt: deps.now(),
        status: "ok",
      };
      deps.messages.push(message);
      await deps.append(message);
      anyoneSpoke = true;
      botMessages += 1;
      const mentions = parseMentions(message.text, members);
      if (mentions.mentionsUser) {
        needsUser = true;
        break outer;
      }
      for (const target of mentions.botIds) {
        if (target !== member.id && !mentionedNext.includes(target)) mentionedNext.push(target);
      }
    }
    if (!anyoneSpoke) break;
    speakers = active(mentionedNext.length > 0 ? mentionedNext : allIds);
    if (speakers.length === 0) break;
  }
  deps.onSpeaking?.(null);
  return { botMessages, rounds, needsUser, stoppedByUser, paused: [...paused] };
}
