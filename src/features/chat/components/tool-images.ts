/** Pictures inside a tool call's result, for every engine: Codex
 *  `image_generation` (`savedPath`), MCP / ACP image content blocks
 *  (`{type: "image", data, mimeType}`), Anthropic image blocks
 *  (`{type: "image", source: {type: "base64", media_type, data}}`), OpenAI
 *  style `image_url` / `input_image` / `output_image` parts and bare
 *  `data:image/…` strings. A ref is either a data URL (renders directly) or an
 *  absolute file path (loaded through `read_tool_image`). */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const DATA_URL = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i;
/** Result keys that name a file the tool produced. */
const PATH_KEYS = ["savedPath", "saved_path", "imagePath", "image_path", "outputPath", "output_path", "filePath", "file_path", "path"];
/** One picture-producing call should not turn into a wall of thumbnails. */
const MAX_IMAGES = 8;
/** Bound the walk on deep or cyclic payloads. */
const MAX_DEPTH = 6;

/** Tools whose whole point is making a picture: their images are promoted out
 *  of the folded tool group into the conversation. Everything else (screenshots,
 *  reading an image file) shows its pictures only inside the expanded call. */
const GENERATION_TOOL = /(^|[^a-z])(image_?gen(eration)?|imagegen|generate_?image|gen_?image|create_?image|text_?to_?image|txt2img|imagine|dall_?e|draw(_?image)?|paint)([^a-z]|$)/i;

export function isImageGenerationTool(name: string): boolean {
  return GENERATION_TOOL.test(name.replace(/[\s.:/-]+/g, "_"));
}

function isAbsolutePath(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value);
}

function mimeOf(block: Record<string, unknown>): string {
  const mime = block.mimeType ?? block.mime_type ?? block.mediaType ?? block.media_type;
  return typeof mime === "string" && mime.startsWith("image/") ? mime : "image/png";
}

function asDataUrl(data: unknown, mime: string): string | null {
  if (typeof data !== "string" || data.length < 8) return null;
  if (DATA_URL.test(data)) return data;
  // Raw base64 payload of an image block.
  return /^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 256)) ? `data:${mime};base64,${data}` : null;
}

function imageUrlOf(value: unknown): string | null {
  const url = typeof value === "string" ? value : (value as { url?: unknown } | null)?.url;
  if (typeof url !== "string") return null;
  if (DATA_URL.test(url)) return url;
  return isAbsolutePath(url) && IMAGE_EXT.test(url) ? url : null;
}

/** Image refs in `result`, deduped, at most MAX_IMAGES. */
export function toolImages(result: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const add = (ref: string | null) => {
    if (ref && !found.includes(ref) && found.length < MAX_IMAGES) found.push(ref);
  };
  const walk = (value: unknown, depth: number) => {
    if (found.length >= MAX_IMAGES || depth > MAX_DEPTH || value == null) return;
    if (typeof value === "string") {
      if (DATA_URL.test(value)) add(value);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const obj = value as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : "";
    if (type === "image") {
      const source = obj.source as Record<string, unknown> | undefined;
      if (source && typeof source === "object") {
        add(source.type === "url" ? imageUrlOf(source.url) : asDataUrl(source.data, mimeOf(source)));
      } else {
        add(asDataUrl(obj.data, mimeOf(obj)));
      }
    } else if (/^(image_url|input_image|output_image|inputImage|outputImage)$/.test(type)) {
      add(imageUrlOf(obj.image_url ?? obj.imageUrl ?? obj.url));
    }
    for (const key of PATH_KEYS) {
      const candidate = obj[key];
      if (typeof candidate === "string" && isAbsolutePath(candidate) && IMAGE_EXT.test(candidate)) add(candidate);
    }
    for (const [key, child] of Object.entries(obj)) {
      if (key === "data" && type === "image") continue;
      walk(child, depth + 1);
    }
  };
  walk(result, 0);
  return found;
}

/** Copy of `result` with every inline image payload replaced by a short note,
 *  so the expanded tool view prints JSON instead of megabytes of base64. */
export function redactImageData(result: unknown): unknown {
  const redact = (value: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH + 2) return value;
    if (typeof value === "string") {
      if (DATA_URL.test(value) || (value.length > 4096 && /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 512)))) {
        return `<image data, ${Math.round((value.length * 3) / 4 / 1024)} KB>`;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) out[key] = redact(child, depth + 1);
      return out;
    }
    return value;
  };
  return redact(result, 0);
}
