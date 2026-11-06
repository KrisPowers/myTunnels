//! The duplicate finder: files kept more than once across Storage's two
//! spaces, found by size and then by content, so a renamed copy counts too.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use axum::extract::State;
use axum::{Extension, Json};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::permissions::Caller;
use crate::state::AppState;
use crate::storage::{Space, Store};
use crate::util::{ApiError, ApiResult};

/// One copy of a file kept more than once.
#[derive(Serialize, Clone, Debug, PartialEq)]
struct Copy {
    space: &'static str,
    path: String,
    size: u64,
    modified: i64,
}

/// Every set of identical files in the spaces the caller may view, the biggest
/// first, each set oldest first.
pub async fn find(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
) -> ApiResult<Json<Value>> {
    let mut roots = Vec::new();
    for (space, name, permission) in [
        (Space::Media, "media", "media.view"),
        (Space::Drive, "drive", "drive.view"),
    ] {
        if caller.can(permission) {
            roots.push((name, Store::open(&state, space)?.real(&[])?));
        }
    }
    let groups = tokio::task::spawn_blocking(move || groups(&roots))
        .await
        .map_err(|e| ApiError::from(anyhow::anyhow!(e)))?;
    Ok(Json(json!({ "groups": groups })))
}

fn groups(roots: &[(&'static str, PathBuf)]) -> Vec<Vec<Copy>> {
    let mut files = Vec::new();
    for (space, root) in roots {
        walk(space, root, root, &mut files);
    }
    // Only files sharing a size can be the same, so only those are read.
    let mut by_size: HashMap<u64, Vec<(Copy, PathBuf)>> = HashMap::new();
    for (copy, real) in files {
        if copy.size > 0 {
            by_size.entry(copy.size).or_default().push((copy, real));
        }
    }
    let mut out: Vec<Vec<Copy>> = Vec::new();
    for (_, same_size) in by_size.into_iter().filter(|(_, v)| v.len() > 1) {
        let mut by_hash: HashMap<String, Vec<Copy>> = HashMap::new();
        for (copy, real) in same_size {
            if let Some(hash) = hash(&real) {
                by_hash.entry(hash).or_default().push(copy);
            }
        }
        for (_, mut copies) in by_hash.into_iter().filter(|(_, v)| v.len() > 1) {
            copies.sort_by_key(|c| (c.modified, c.path.clone()));
            out.push(copies);
        }
    }
    out.sort_by_key(|g| std::cmp::Reverse(g[0].size * (g.len() as u64 - 1)));
    out
}

/// Every file under `dir`, skipping the space's own hidden workings.
fn walk(space: &'static str, root: &Path, dir: &Path, out: &mut Vec<(Copy, PathBuf)>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.ends_with(".mtpart") {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk(space, root, &path, out);
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(root)
                .map(|p| {
                    p.components()
                        .map(|c| c.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/")
                })
                .unwrap_or_default();
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs() as i64);
            out.push((
                Copy {
                    space,
                    path: rel,
                    size: meta.len(),
                    modified,
                },
                path,
            ));
        }
    }
}

fn hash(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_same_content_under_other_names_only() {
        let dir = std::env::temp_dir().join(format!("dupes-{}", crate::util::random_hex(6)));
        let media = dir.join("media");
        let drive = dir.join("drive");
        std::fs::create_dir_all(media.join("2026")).unwrap();
        std::fs::create_dir_all(media.join(".thumbs")).unwrap();
        std::fs::create_dir_all(&drive).unwrap();
        std::fs::write(media.join("a.jpg"), b"same bytes").unwrap();
        std::fs::write(media.join("2026/copy.jpg"), b"same bytes").unwrap();
        std::fs::write(drive.join("other.pdf"), b"same size!").unwrap();
        std::fs::write(media.join(".thumbs/a.jpg.jpg"), b"same bytes").unwrap();
        let found = groups(&[("media", media), ("drive", drive)]);
        assert_eq!(found.len(), 1);
        let mut paths: Vec<&str> = found[0].iter().map(|c| c.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, ["2026/copy.jpg", "a.jpg"]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
