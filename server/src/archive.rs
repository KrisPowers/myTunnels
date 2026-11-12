//! Zip and unzip in Files: open a ZIP, 7z or RAR archive into a folder beside
//! it, or pack files and folders into a ZIP. Archives are read with `unar`,
//! which the image includes, and written here.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use axum::http::StatusCode;
use serde_json::{json, Value};
use tokio::process::Command;

use crate::storage::{io_error, size_of, takes, Store};
use crate::util::{ApiError, ApiResult};

/// Kinds of archive that open.
const ARCHIVES: [&str; 3] = ["zip", "7z", "rar"];
/// The most an archive may hold once opened.
const MAX_OPENED: u64 = 100 * 1024 * 1024 * 1024;
const LIMIT: Duration = Duration::from_secs(30 * 60);

fn ext_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

/// A name for something new in `dir`: `name`, or `name (2)`, keeping `ext`.
fn free(dir: &Path, stem: &str, ext: &str) -> String {
    (1..)
        .map(|n| {
            let tail = if n == 1 {
                String::new()
            } else {
                format!(" ({n})")
            };
            format!("{stem}{tail}{ext}")
        })
        .find(|name| std::fs::symlink_metadata(dir.join(name)).is_err())
        .unwrap_or_default()
}

/// Opens the archive at `rel` into a folder beside it, named after it. Files
/// Storage does not keep are left out, as are links. Returns the folder and how
/// many were left out.
pub async fn extract(store: &Store, rel: &[String]) -> ApiResult<Value> {
    let name = rel.last().cloned().ok_or_else(ApiError::not_found)?;
    if !ARCHIVES.contains(&ext_of(&name).as_str()) {
        return Err(ApiError::bad("Only ZIP, 7z and RAR files open"));
    }
    let archive = store.real(rel)?;
    if !archive.is_file() {
        return Err(ApiError::not_found());
    }
    let dir = archive.parent().ok_or_else(ApiError::not_found)?.to_owned();

    // How big it is once opened, before anything is written.
    let listed = run(Command::new("lsar").arg("-j").arg(&archive), "lsar").await?;
    let opened = opened_size(&listed);
    if opened > MAX_OPENED {
        return Err(ApiError::bad("That archive opens to more than 100 GB"));
    }
    store.room(opened)?;

    let stem = name.rsplit_once('.').map_or(name.as_str(), |(s, _)| s);
    let folder = free(&dir, stem, "");
    let target = dir.join(&folder);
    tokio::fs::create_dir(&target).await.map_err(io_error)?;
    let result = run(
        Command::new("unar")
            .args(["-q", "-f", "-D", "-o"])
            .arg(&target)
            .arg(&archive),
        "unar",
    )
    .await;
    if let Err(err) = result {
        let _ = tokio::fs::remove_dir_all(&target).await;
        return Err(err);
    }
    let kept = target.clone();
    let skipped = tokio::task::spawn_blocking(move || tidy(&kept))
        .await
        .map_err(|e| ApiError::from(anyhow::anyhow!(e)))?;
    let mut path = rel[..rel.len() - 1].to_vec();
    path.push(folder);
    Ok(json!({ "path": path.join("/"), "skipped": skipped }))
}

/// The total size of what `lsar -j` lists.
fn opened_size(listed: &[u8]) -> u64 {
    serde_json::from_slice::<Value>(listed)
        .ok()
        .and_then(|v| v.get("lsarContents").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|e| e.get("XADFileSize").and_then(Value::as_u64))
        .sum()
}

/// Removes links and files Storage does not keep from what an archive opened to;
/// returns how many went.
fn tidy(dir: &Path) -> usize {
    let mut gone = 0;
    let Ok(read) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in read.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if meta.file_type().is_symlink() {
            let _ = std::fs::remove_file(&path).or_else(|_| std::fs::remove_dir(&path));
            gone += 1;
        } else if meta.is_dir() {
            gone += tidy(&path);
        } else if name.starts_with('.') || takes(&name).is_err() {
            let _ = std::fs::remove_file(&path);
            gone += 1;
        }
    }
    gone
}

/// Packs `rels`, files and folders in one folder, into a ZIP beside them: named
/// after the one item, or "Archive". Returns its path.
pub async fn compress(store: &Store, rels: &[Vec<String>]) -> ApiResult<Value> {
    let first = rels
        .first()
        .ok_or_else(|| ApiError::bad("Pick what to pack"))?;
    let parent = &first[..first.len().saturating_sub(1)];
    if first.is_empty()
        || rels
            .iter()
            .any(|r| r.is_empty() || &r[..r.len() - 1] != parent)
    {
        return Err(ApiError::bad("Pack items from one folder at a time"));
    }
    let items = rels
        .iter()
        .map(|r| store.real(r))
        .collect::<ApiResult<Vec<PathBuf>>>()?;
    // Packed, it takes up no more than its items do.
    store.room(items.iter().map(|i| size_of(i)).sum())?;
    let dir = store.real(parent)?;
    let stem = if rels.len() == 1 {
        let name = &first[first.len() - 1];
        if items[0].is_dir() {
            name.clone()
        } else {
            name.rsplit_once('.')
                .map_or(name.clone(), |(s, _)| s.to_owned())
        }
    } else {
        "Archive".to_owned()
    };
    let file = free(&dir, &stem, ".zip");
    let target = dir.join(&file);
    let out = target.clone();
    tokio::task::spawn_blocking(move || pack(&out, &items))
        .await
        .map_err(|e| ApiError::from(anyhow::anyhow!(e)))?
        .map_err(|e| {
            let _ = std::fs::remove_file(&target);
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Could not pack it: {e}"),
            )
        })?;
    let mut path = parent.to_vec();
    path.push(file);
    Ok(json!({ "path": path.join("/") }))
}

fn pack(out: &Path, items: &[PathBuf]) -> anyhow::Result<()> {
    let mut zip = zip::ZipWriter::new(std::fs::File::create(out)?);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);
    for item in items {
        let base = item.parent().unwrap_or(item);
        add(&mut zip, base, item, options)?;
    }
    zip.finish()?;
    Ok(())
}

fn add(
    zip: &mut zip::ZipWriter<std::fs::File>,
    base: &Path,
    path: &Path,
    options: zip::write::SimpleFileOptions,
) -> anyhow::Result<()> {
    let name = path
        .strip_prefix(base)?
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    let meta = std::fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() {
        zip.add_directory(format!("{name}/"), options)?;
        for entry in std::fs::read_dir(path)?.flatten() {
            let child = entry.file_name().to_string_lossy().into_owned();
            if !child.starts_with('.') && !child.ends_with(".mtpart") {
                add(zip, base, &entry.path(), options)?;
            }
        }
    } else {
        zip.start_file(name, options)?;
        std::io::copy(&mut std::fs::File::open(path)?, zip)?;
        zip.flush()?;
    }
    Ok(())
}

/// Runs a tool to the end, giving its output, or why it failed.
async fn run(cmd: &mut Command, name: &str) -> ApiResult<Vec<u8>> {
    let output = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(LIMIT, output)
        .await
        .map_err(|_| ApiError::bad(format!("{name} took too long and was stopped")))?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ApiError(
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!("{name} is not installed on this host"),
                )
            } else {
                io_error(e)
            }
        })?;
    if !out.status.success() {
        let said = String::from_utf8_lossy(&out.stderr);
        let last = said
            .lines()
            .rfind(|l| !l.trim().is_empty())
            .unwrap_or("it could not read the archive");
        return Err(ApiError::bad(format!("Could not open it: {}", last.trim())));
    }
    Ok(out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_what_an_archive_holds() {
        let listed =
            br#"{"lsarContents":[{"XADFileSize":10},{"XADFileSize":32},{"XADIsDirectory":1}]}"#;
        assert_eq!(opened_size(listed), 42);
        assert_eq!(opened_size(b"not json"), 0);
    }

    #[test]
    fn packs_a_folder_and_names_things_freely() {
        let dir = std::env::temp_dir().join(format!("zip-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(dir.join("docs/inner")).unwrap();
        std::fs::write(dir.join("docs/a.txt"), b"hello").unwrap();
        std::fs::write(dir.join("docs/inner/b.txt"), b"world").unwrap();
        std::fs::write(dir.join("docs/.hidden"), b"x").unwrap();
        let out = dir.join("docs.zip");
        pack(&out, &[dir.join("docs")]).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        let mut names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            ["docs/", "docs/a.txt", "docs/inner/", "docs/inner/b.txt"]
        );
        assert_eq!(free(&dir, "docs", ".zip"), "docs (2).zip");
        let _ = std::fs::remove_dir_all(dir);
    }
}
