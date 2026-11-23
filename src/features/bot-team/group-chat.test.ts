import { describe, expect, it } from "vitest";
import type { BotGroup, BotGroupMessage } from "@/lib/ipc";
import {
  buildMemberPrompt,
  isPass,
  parseMentions,
  runRotation,
  transcriptSince,
  type GroupMember,
} from "./group-chat";

const members: GroupMember[] = [
  { id: "a", slug: "alice", name: "Alice" },
  { id: "b", slug: "bob", name: "Bob" },
  { id: "c", slug: "bob-ops", name: "Bob Ops" },
];

const group: BotGroup = {
  id: "g",
  name: "Team",
  memberBotIds: ["a", "b", "c"],
  engine: "claude",
  workspacePath: "/tmp",
  maxRounds: 3,
  maxBotMessagesPerSend: 10,
  memberSessions: {},
  needsUser: false,
  createdAt: 0,
  updatedAt: 0,
};

function userMessage(text: string): BotGroupMessage {
  return { id: "u1", groupId: "g", author: "user", text, createdAt: 1, status: "ok" };
}

function harness(replies: Record<string, string[]>, overrides: Partial<BotGroup> = {}) {
  const calls: string[] = [];
  let n = 0;
  const messages: BotGroupMessage[] = [];
  const deps = {
    group: { ...group, ...overrides },
    members,
    messages,
    newMessageId: () => `m${++n}`,
    now: () => n,
    shouldStop: () => false,
    append: () => {},
    runMember: async (member: GroupMember, _prompt: string) => {
      calls.push(member.id);
      const queue = replies[member.id] ?? [];
      return queue.shift() ?? "[PASS]";
    },
  };
  return { deps, calls, messages };
}

describe("parseMentions", () => {
  it("prefers the longest slug and keeps order", () => {
    const m = parseMentions("@bob-ops please, then @alice", members);
    expect(m.botIds).toEqual(["c", "a"]);
    expect(m.mentionsUser).toBe(false);
  });

  it("ignores mentions in code and quotes", () => {
    const m = parseMentions("```\n@alice\n```\n> @bob said\n`@user`", members);
    expect(m.botIds).toEqual([]);
    expect(m.mentionsUser).toBe(false);
  });

  it("detects @user and stop words next to a mention", () => {
    expect(parseMentions("ask @user to decide", members).mentionsUser).toBe(true);
    expect(parseMentions("@bob 停一下", members).stopped).toEqual(["b"]);
    expect(parseMentions("@alice stop", members).stopped).toEqual(["a"]);
  });
});

describe("isPass", () => {
  it("treats [PASS] and empty replies as passing", () => {
    expect(isPass("[PASS]")).toBe(true);
    expect(isPass("  [pass] ")).toBe(true);
    expect(isPass("")).toBe(true);
    expect(isPass("I think [PASS] is wrong here because of many reasons in this long sentence")).toBe(false);
  });
});

describe("runRotation", () => {
  it("only the mentioned member answers", async () => {
    const h = harness({ a: ["hi"] });
    const out = await runRotation(h.deps, userMessage("@alice hello"));
    expect(h.calls[0]).toBe("a");
    expect(h.messages.map((m) => m.author)).toEqual(["a"]);
    expect(out.botMessages).toBe(1);
  });

  it("ends when a round has no speaker", async () => {
    const h = harness({});
    const out = await runRotation(h.deps, userMessage("anyone?"));
    expect(h.calls).toEqual(["a", "b", "c"]);
    expect(out.rounds).toBe(1);
    expect(out.botMessages).toBe(0);
  });

  it("a bot mention pulls that member into the next round", async () => {
    const h = harness({ a: ["@bob what do you think?"], b: ["looks fine"] });
    await runRotation(h.deps, userMessage("@alice review"));
    expect(h.calls).toEqual(["a", "b", "a", "b", "c"]);
    expect(h.messages.map((m) => m.text)).toEqual(["@bob what do you think?", "looks fine"]);
  });

  it("stops when someone asks the user", async () => {
    const h = harness({ a: ["@user should we ship?"], b: ["more"] });
    const out = await runRotation(h.deps, userMessage("plan"));
    expect(out.needsUser).toBe(true);
    expect(h.calls).toEqual(["a"]);
  });

  it("respects the message cap", async () => {
    const h = harness({ a: ["1", "2", "3"], b: ["1", "2", "3"], c: ["1", "2", "3"] }, { maxBotMessagesPerSend: 4 });
    const out = await runRotation(h.deps, userMessage("go"));
    expect(out.botMessages).toBe(4);
  });

  it("respects the round cap", async () => {
    const h = harness({ a: ["1", "2", "3", "4"] }, { maxRounds: 2 });
    const out = await runRotation(h.deps, userMessage("go"));
    expect(out.rounds).toBe(2);
    expect(out.botMessages).toBe(2);
  });

  it("records a failed member and keeps going", async () => {
    const h = harness({ b: ["ok"] });
    h.deps.runMember = async (member: GroupMember) => {
      h.calls.push(member.id);
      if (member.id === "a") throw new Error("boom");
      return member.id === "b" && h.calls.filter((c) => c === "b").length === 1 ? "ok" : "[PASS]";
    };
    await runRotation(h.deps, userMessage("go"));
    expect(h.messages[0]).toMatchObject({ author: "a", status: "error", text: "boom" });
    expect(h.messages[1]).toMatchObject({ author: "b", status: "ok", text: "ok" });
  });

  it("stop halts before the next member", async () => {
    const h = harness({ a: ["one"], b: ["two"] });
    let stop = false;
    h.deps.shouldStop = () => stop;
    const run = h.deps.runMember;
    h.deps.runMember = async (member: GroupMember, prompt: string) => {
      const reply = await run(member, prompt);
      stop = true;
      return reply;
    };
    const out = await runRotation(h.deps, userMessage("go"));
    expect(out.stoppedByUser).toBe(true);
    expect(h.calls).toEqual(["a"]);
    expect(h.messages).toHaveLength(0);
  });

  it("paused members are skipped until mentioned again", async () => {
    const h = harness({ a: ["x"], b: ["y"], c: ["z"] });
    const out = await runRotation(h.deps, userMessage("@bob stop"));
    expect(out.paused).toEqual(["b"]);
    expect(h.calls).not.toContain("b");
    const h2 = harness({ b: ["back"] });
    const out2 = await runRotation(h2.deps, userMessage("@bob you there?"), out.paused);
    expect(h2.calls[0]).toBe("b");
    expect(out2.paused).toEqual([]);
  });
});

describe("member prompt", () => {
  it("shows only messages since the member last spoke", () => {
    const messages: BotGroupMessage[] = [
      { id: "1", groupId: "g", author: "user", text: "first", createdAt: 1 },
      { id: "2", groupId: "g", author: "a", text: "mine", createdAt: 2 },
      { id: "3", groupId: "g", author: "b", text: "after", createdAt: 3 },
    ];
    expect(transcriptSince(messages, "a", members)).toBe("@bob: after");
    const prompt = buildMemberPrompt({ group, members, self: members[0], messages });
    expect(prompt).toContain("你的身份是 @alice");
    expect(prompt).toContain("@bob: after");
    expect(prompt).not.toContain("first");
  });
});
