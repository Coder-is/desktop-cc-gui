import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readToolImage = vi.fn();
vi.mock("@/lib/ipc", () => ({ ipc: { readToolImage: (path: unknown) => readToolImage(path) } }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useReducedMotion: () => true,
}));

import i18n from "@/lib/i18n";
import { ProcessDisclosure } from "./ProcessDisclosure";
import { GenericToolViewer } from "./ToolPayloadViewer";
import type { ProcessItem } from "./timeline-rows";

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const SAVED = "C:\\Users\\me\\.codex\\generated_images\\t\\exec-1.png";
const DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  readToolImage.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function render(items: ProcessItem[]) {
  return act(async () =>
    root.render(<ProcessDisclosure items={items} processId={1} seenTools={new Set()} />),
  );
}

describe("generated images in the conversation", () => {
  it("shows a Codex picture under the folded tool group", async () => {
    readToolImage.mockResolvedValue(DATA);
    await render([
      { type: "tool", text: "js", args: { code: "1" } },
      { type: "tool", text: "image_generation", args: { revisedPrompt: "kitten" }, result: { status: "completed", savedPath: SAVED } },
    ]);
    // Folded (header only), yet the picture is in view.
    expect(container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
    expect(readToolImage).toHaveBeenCalledExactlyOnceWith(SAVED);
    const img = container.querySelector("[data-tool-images] img");
    expect(img?.getAttribute("src")).toBe(DATA);
  });

  it("works for any engine's image tool returning inline image data", async () => {
    await render([
      { type: "tool", text: "mcp__flux__generate_image", result: { content: [{ type: "image", data: DATA.split(",")[1], mimeType: "image/png" }] } },
    ]);
    expect(readToolImage).not.toHaveBeenCalled();
    expect(container.querySelector("[data-tool-images] img")?.getAttribute("src")).toBe(DATA);
  });

  it("degrades to the file name when the picture cannot be read", async () => {
    // A path not loaded before (successful reads are cached per session).
    const gone = "C:\\Users\\me\\.codex\\generated_images\\t\\deleted.png";
    readToolImage.mockRejectedValue("image is outside the readable folders");
    await render([{ type: "tool", text: "image_generation", result: { status: "completed", savedPath: gone } }]);
    expect(container.querySelector("[data-tool-images] img")).toBeNull();
    expect(container.textContent).toContain(i18n.t("chat.toolImageUnavailable", { name: "deleted.png" }));
  });

  it("does not promote screenshots or images from non-generation tools", async () => {
    await render([{ type: "tool", text: "screenshot", result: { content: [{ type: "image", data: DATA.split(",")[1] }] } }]);
    expect(container.querySelector("[data-tool-images]")).toBeNull();
  });
});

describe("GenericToolViewer with image results", () => {
  it("shows thumbnails and prints a short note instead of base64", async () => {
    const big = "iVBORw0KGgo" + "A".repeat(20000);
    await act(async () =>
      root.render(<GenericToolViewer args={{ q: 1 }} result={{ content: [{ type: "image", data: big, mimeType: "image/png" }] }} />),
    );
    expect(container.querySelector("[data-tool-images] img")?.getAttribute("src")).toBe(`data:image/png;base64,${big}`);
    expect(container.textContent).not.toContain("AAAAAAAAAAAAAAAA");
    expect(container.textContent).toMatch(/<image data, \d+ KB>/);
  });
});
