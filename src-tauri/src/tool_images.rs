//! Read-only image loading for the chat timeline: pictures that tools and
//! engines produced (Codex `image_generation`, MCP image tools, …) and report
//! by absolute path.
//!
//! `read_file` only reaches registered workspaces, granted folders and the
//! pasted-image dir — and those roots also gate writes. Engine output dirs
//! (Codex saves generated pictures under `<CODEX_HOME>/generated_images`) sit
//! next to that engine's credentials (`~/.codex/auth.json`), so they are NOT
//! added to the shared allow-list. This command reads raster images only, from
//! the shared roots plus each engine's dedicated image-output dir, and never
//! writes.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine as _;

/// Generated pictures run larger than editor previews (a 1792×1024 PNG is
/// several MB), so this cap is wider than `files::MAX_IMAGE_BYTES`.
const MAX_TOOL_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

/// Raster formats only: an SVG is a document that can carry script and
/// external references, and tool output is untrusted.
fn is_raster_image(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
    )
}

/// Each engine's dedicated image-output directory (not its whole home).
fn engine_image_roots() -> Vec<PathBuf> {
    vec![crate::engine::codex_home().join("generated_images")]
}

/// Canonical `path` when it is a raster image inside one of `roots`
/// (roots are canonicalized here too, so a symlinked root still matches and
/// `..` / links cannot step outside).
fn resolve_allowed(path: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("empty path".to_string());
    }
    let resolved = crate::files::canonicalize_lenient(Path::new(path))?;
    if !is_raster_image(&resolved) {
        return Err(format!("not a supported image: {path}"));
    }
    let inside = roots
        .iter()
        .filter_map(|root| crate::files::canonicalize_lenient(root).ok())
        .any(|root| resolved.starts_with(&root));
    if !inside {
        return Err(format!("image is outside the readable folders: {path}"));
    }
    Ok(resolved)
}

fn read_data_url(file: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(file).map_err(|e| format!("stat {}: {e}", file.display()))?;
    if !meta.is_file() {
        return Err(format!("not a file: {}", file.display()));
    }
    if meta.len() > MAX_TOOL_IMAGE_BYTES {
        return Err("image exceeds the 25MB preview limit".to_string());
    }
    let bytes = std::fs::read(file).map_err(|e| format!("read {}: {e}", file.display()))?;
    Ok(format!(
        "data:{};base64,{}",
        crate::files::image_mime(file),
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn read_tool_image_blocking(db: &crate::db::Db, path: &str) -> Result<String, String> {
    let mut roots = crate::files::allowed_roots(db);
    roots.extend(engine_image_roots());
    read_data_url(&resolve_allowed(path, &roots)?)
}

/// Data URL of a tool/engine-produced image, for the timeline thumbnail.
#[tauri::command]
pub async fn read_tool_image(
    db: tauri::State<'_, Arc<crate::db::Db>>,
    path: String,
) -> Result<String, String> {
    let db = Arc::clone(db.inner());
    tauri::async_runtime::spawn_blocking(move || read_tool_image_blocking(&db, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccgui-tool-images-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_a_raster_image_inside_an_allowed_root() {
        let home = scratch("ok");
        let images = home.join("generated_images").join("thread");
        std::fs::create_dir_all(&images).unwrap();
        let png = images.join("exec-1.png");
        std::fs::write(&png, [0x89, b'P', b'N', b'G']).unwrap();
        let file = resolve_allowed(png.to_str().unwrap(), &[home.join("generated_images")]).unwrap();
        let url = read_data_url(&file).unwrap();
        std::fs::remove_dir_all(&home).ok();
        assert!(url.starts_with("data:image/png;base64,"), "{url}");
    }

    #[test]
    fn refuses_the_engine_home_outside_its_image_dir() {
        // The image root is <home>/generated_images; the CLI's credentials in
        // <home> itself must stay unreachable, by name or by `..`.
        let home = scratch("creds");
        let images = home.join("generated_images");
        std::fs::create_dir_all(&images).unwrap();
        std::fs::write(home.join("auth.json"), "{}").unwrap();
        std::fs::write(home.join("avatar.png"), "x").unwrap();
        let roots = [images.clone()];
        let auth = resolve_allowed(home.join("auth.json").to_str().unwrap(), &roots);
        let sibling = resolve_allowed(home.join("avatar.png").to_str().unwrap(), &roots);
        let escape = resolve_allowed(images.join("..").join("avatar.png").to_str().unwrap(), &roots);
        std::fs::remove_dir_all(&home).ok();
        assert!(auth.is_err());
        assert!(sibling.unwrap_err().contains("outside"));
        assert!(escape.unwrap_err().contains("outside"));
    }

    #[test]
    fn refuses_non_raster_files_even_inside_a_root() {
        let root = scratch("kinds");
        for name in ["note.json", "icon.svg", "page.html"] {
            std::fs::write(root.join(name), "x").unwrap();
        }
        let roots = [root.clone()];
        let results: Vec<_> = ["note.json", "icon.svg", "page.html"]
            .iter()
            .map(|name| resolve_allowed(root.join(name).to_str().unwrap(), &roots))
            .collect();
        std::fs::remove_dir_all(&root).ok();
        for result in results {
            assert!(result.unwrap_err().contains("not a supported image"));
        }
    }

    #[test]
    fn engine_image_roots_are_only_the_output_dirs() {
        for root in engine_image_roots() {
            assert_eq!(root.file_name().and_then(|n| n.to_str()), Some("generated_images"));
        }
    }
}
