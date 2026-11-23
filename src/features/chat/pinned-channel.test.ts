import { describe, expect, it } from "vitest";
import { channelNames, stalePin } from "./pinned-channel";

const channels = channelNames({ providers: { "ccpl-account": { name: "ccpl" }, other: {} } });

describe("stalePin", () => {
  it("flags a session pinned to 官方配置 while the engine runs on a channel", () => {
    expect(stalePin("__local_settings_json__", "ccpl-account", channels)).toEqual({
      kind: "official",
      pinned: "__local_settings_json__",
      current: "ccpl-account",
    });
  });

  it("flags a session pinned to a deleted channel", () => {
    expect(stalePin("old-channel", "ccpl-account", channels)?.kind).toBe("missing");
  });

  it("leaves live pins, unpinned sessions and same-channel sessions alone", () => {
    expect(stalePin("other", "ccpl-account", channels)).toBeNull();
    expect(stalePin(null, "ccpl-account", channels)).toBeNull();
    expect(stalePin("ccpl-account", "ccpl-account", channels)).toBeNull();
  });

  it("offers nothing when the engine has no usable channel to move to", () => {
    expect(stalePin("__local_settings_json__", "__local_settings_json__", channels)).toBeNull();
    expect(stalePin("old-channel", "__disabled__", channels)).toBeNull();
    expect(stalePin("old-channel", "gone-too", channels)).toBeNull();
  });

  it("names channels by their display name, falling back to the id", () => {
    expect(channels.get("ccpl-account")).toBe("ccpl");
    expect(channels.get("other")).toBe("other");
  });
});
