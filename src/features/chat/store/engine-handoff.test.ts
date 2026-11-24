import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/ipc";
import { buildHandoffContext, HANDOFF_MAX_CHARS, HANDOFF_MAX_MESSAGE_CHARS } from "./engine-handoff";

const msg = (seq: number, role: string, text: string): Message => ({ seq, role, text, ts: null });

describe("buildHandoffContext", () => {
  it("只带用户和助手的话，去掉内部附加内容，按原顺序", () => {
    const text = buildHandoffContext(
      [
        msg(1, "user", "改一下颜色\n\n[CCGUI internal system-tail]\n插件塞的东西"),
        msg(2, "tool", "Read src/a.ts"),
        msg(3, "thinking", "想一想"),
        msg(4, "assistant", "已经改成 #000000"),
      ],
      "codex",
    );
    expect(text).toContain("Codex");
    expect(text).toMatch(/用户：改一下颜色\n助手：已经改成 #000000$/);
    expect(text).not.toContain("插件塞的东西");
    expect(text).not.toContain("Read src/a.ts");
    expect(text).not.toContain("想一想");
  });

  it("没有可带的内容时为空", () => {
    expect(buildHandoffContext([], "codex")).toBe("");
    expect(buildHandoffContext([msg(1, "tool", "x")], "codex")).toBe("");
  });

  it("单条过长截断，总长超出时只留最近的", () => {
    const long = "字".repeat(HANDOFF_MAX_MESSAGE_CHARS + 500);
    const messages: Message[] = [];
    for (let i = 0; i < 40; i++) messages.push(msg(i, i % 2 ? "assistant" : "user", `第${i}条 ${long}`));
    const text = buildHandoffContext(messages, "codex");
    expect(text).toContain("第39条");
    expect(text).not.toContain("第0条 ");
    expect(text).toContain("（后面省略）");
    expect(text.length).toBeLessThan(HANDOFF_MAX_CHARS + 600);
  });
});
