import { describe, expect, it } from "vitest";
import { isImageGenerationTool, redactImageData, toolImages } from "./tool-images";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

describe("toolImages", () => {
  it("reads Codex image_generation's savedPath (Windows and POSIX)", () => {
    expect(toolImages({ status: "completed", savedPath: "C:\\Users\\me\\.codex\\generated_images\\t\\exec-1.png" })).toEqual([
      "C:\\Users\\me\\.codex\\generated_images\\t\\exec-1.png",
    ]);
    expect(toolImages({ saved_path: "/home/me/out/cat.webp" })).toEqual(["/home/me/out/cat.webp"]);
  });

  it("reads MCP / ACP image content blocks", () => {
    expect(toolImages({ content: [{ type: "text", text: "done" }, { type: "image", data: PNG, mimeType: "image/png" }] })).toEqual([
      `data:image/png;base64,${PNG}`,
    ]);
  });

  it("reads Anthropic base64 image blocks", () => {
    expect(toolImages([{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: PNG } }])).toEqual([
      `data:image/jpeg;base64,${PNG}`,
    ]);
  });

  it("reads OpenAI-style image_url parts and bare data URLs", () => {
    const url = `data:image/png;base64,${PNG}`;
    expect(toolImages({ contentItems: [{ type: "inputImage", imageUrl: url }] })).toEqual([url]);
    expect(toolImages({ type: "image_url", image_url: { url } })).toEqual([url]);
    expect(toolImages({ output: url })).toEqual([url]);
  });

  it("ignores relative paths, non-images and remote URLs", () => {
    expect(toolImages({ savedPath: "out/cat.png" })).toEqual([]);
    expect(toolImages({ savedPath: "C:\\out\\notes.txt", path: "/tmp/a.svg" })).toEqual([]);
    expect(toolImages({ type: "image_url", image_url: "https://example.com/a.png" })).toEqual([]);
    expect(toolImages(null)).toEqual([]);
    expect(toolImages("plain text")).toEqual([]);
  });

  it("dedupes and caps the number of pictures", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ savedPath: `/out/${i}.png` }));
    expect(toolImages([...many, many[0]])).toHaveLength(8);
    expect(toolImages([{ savedPath: "/a.png" }, { imagePath: "/a.png" }])).toEqual(["/a.png"]);
  });

  it("survives cyclic payloads", () => {
    const loop: Record<string, unknown> = { savedPath: "/a.png" };
    loop.self = loop;
    expect(toolImages(loop)).toEqual(["/a.png"]);
  });
});

describe("isImageGenerationTool", () => {
  it("matches image-generating tools across engines and MCP servers", () => {
    for (const name of ["image_generation", "imagegen", "generate_image", "mcp__openai__generate_image", "flux.text_to_image", "dall-e", "imagine"]) {
      expect(isImageGenerationTool(name), name).toBe(true);
    }
  });

  it("leaves screenshot, read and unrelated tools alone", () => {
    for (const name of ["Read", "screenshot", "computer_use", "Bash", "web_search", "image_reader", "drawio_export_xml"]) {
      expect(isImageGenerationTool(name), name).toBe(false);
    }
  });
});

describe("redactImageData", () => {
  it("replaces inline image payloads but keeps the rest", () => {
    const out = redactImageData({ status: "ok", content: [{ type: "image", data: PNG.repeat(200), mimeType: "image/png" }] }) as {
      status: string;
      content: { data: string; mimeType: string }[];
    };
    expect(out.status).toBe("ok");
    expect(out.content[0].mimeType).toBe("image/png");
    expect(out.content[0].data).toMatch(/^<image data, \d+ KB>$/);
  });
});
