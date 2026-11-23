import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import FileImage from "lucide-react/dist/esm/icons/file-image";
import { ipc } from "@/lib/ipc";
import { ImageLightbox } from "@/components/base/image-lightbox";
import { fileName } from "@/features/files/store";
import { cx } from "@/utils/cx";

/** Loaded data URLs by path, shared across rows: the timeline re-mounts rows
 *  on scroll and the same picture should not be re-read each time. Bounded so
 *  a long session of generated images does not pin them all in memory. */
const CACHE_LIMIT = 24;
const cache = new Map<string, string>();
function remember(path: string, url: string) {
  cache.delete(path);
  cache.set(path, url);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

function nameOf(ref: string): string {
  return ref.startsWith("data:") ? "image" : fileName(ref);
}

/**
 * Thumbnails of pictures a tool produced (any engine). Data URLs render as is;
 * file paths load through `read_tool_image`. A picture that cannot be read —
 * deleted, on a remote (WSL) host, outside the readable folders — degrades to
 * a file-name chip with the full path on hover. Click opens the lightbox.
 */
export function ToolImages({ images, size = "md" }: { images: string[]; size?: "sm" | "md" }) {
  const { t } = useTranslation();
  // ref -> data URL; absent = loading, null = unreadable.
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const [zoom, setZoom] = useState<{ src: string; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const initial: Record<string, string | null> = {};
    for (const ref of images) {
      if (ref.startsWith("data:")) initial[ref] = ref;
      else if (cache.has(ref)) initial[ref] = cache.get(ref)!;
    }
    setUrls(initial);
    for (const ref of images) {
      if (ref in initial) continue;
      ipc
        .readToolImage(ref)
        .then((url) => {
          remember(ref, url);
          if (!cancelled) setUrls((prev) => ({ ...prev, [ref]: url }));
        })
        .catch(() => {
          if (!cancelled) setUrls((prev) => ({ ...prev, [ref]: null }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [images]);

  if (images.length === 0) return null;
  const thumb = size === "sm" ? "max-h-32 max-w-48" : "max-h-72 max-w-full sm:max-w-96";

  return (
    <>
      <div className="flex flex-wrap gap-2 py-1.5" data-tool-images="">
        {images.map((ref) => {
          const url = urls[ref];
          const name = nameOf(ref);
          if (url === undefined) {
            return (
              <div
                key={ref}
                className={cx("animate-pulse rounded-lg bg-background-tertiary-default", size === "sm" ? "h-24 w-32" : "h-48 w-64")}
                aria-label={t("chat.toolImageLoading")}
              />
            );
          }
          if (url === null) {
            return (
              <span
                key={ref}
                className="inline-flex items-center gap-1 rounded-md bg-background-tertiary-default px-2 py-1 text-caption-1-medium text-text-secondary"
                title={ref.startsWith("data:") ? undefined : ref}
              >
                <FileImage className="size-3.5" aria-hidden />
                {t("chat.toolImageUnavailable", { name })}
              </span>
            );
          }
          return (
            <button
              key={ref}
              type="button"
              onClick={() => setZoom({ src: url, name })}
              className="cursor-zoom-in overflow-hidden rounded-lg border border-border-button-default"
              aria-label={t("chat.toolImageOpen", { name })}
              title={ref.startsWith("data:") ? undefined : ref}
            >
              <img src={url} alt={name} className={cx("block rounded-lg object-contain", thumb)} loading="lazy" />
            </button>
          );
        })}
      </div>
      {zoom && <ImageLightbox src={zoom.src} name={zoom.name} onClose={() => setZoom(null)} />}
    </>
  );
}
