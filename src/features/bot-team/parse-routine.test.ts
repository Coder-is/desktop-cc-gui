import { describe, expect, it } from "vitest";
import { buildParsePrompt, parseRoutineDraft } from "./parse-routine";

describe("parseRoutineDraft", () => {
  it("accepts a fenced JSON reply and normalizes the time", () => {
    const draft = parseRoutineDraft(
      '```json\n{"name":"晨报","prompt":"总结昨天的提交","botSlug":"dev","schedule":{"kind":"weekly","time":"9:00","weekdays":[5,1,2,3,4,1]}}\n```',
    );
    expect(draft).toEqual({
      name: "晨报",
      prompt: "总结昨天的提交",
      botSlug: "dev",
      schedule: { kind: "weekly", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    });
  });

  it("defaults a missing time to 09:00", () => {
    expect(parseRoutineDraft('{"name":"n","prompt":"p","schedule":{"kind":"daily"}}').schedule).toEqual({
      kind: "daily",
      time: "09:00",
    });
  });

  it("rejects too-frequent intervals, bad kinds and missing fields", () => {
    expect(() => parseRoutineDraft('{"name":"n","prompt":"p","schedule":{"kind":"interval","everyMinutes":1}}')).toThrow();
    expect(() => parseRoutineDraft('{"name":"n","prompt":"p","schedule":{"kind":"cron"}}')).toThrow();
    expect(() => parseRoutineDraft('{"prompt":"p","schedule":{"kind":"daily"}}')).toThrow();
    expect(() => parseRoutineDraft("sorry, I can't")).toThrow();
  });
});

describe("buildParsePrompt", () => {
  it("fences the user sentence as data", () => {
    const prompt = buildParsePrompt("每天 8 点提醒我", [{ slug: "dev", name: "Dev" }], new Date(2026, 10, 2, 10));
    expect(prompt).toContain("<<<\n每天 8 点提醒我\n>>>");
    expect(prompt).toContain("- dev：Dev");
  });
});
