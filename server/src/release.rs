//! A container built from a GitHub repository can update when a new release
//! is published: its latest release, read from GitHub.

use serde_json::Value;

use crate::state::AppState;

/// The owner and name of a repository at github.com.
fn github(url: &str) -> Option<(String, String)> {
    let path = url
        .strip_prefix("https://github.com/")?
        .trim_end_matches('/')
        .trim_end_matches(".git");
    let (owner, repo) = path.split_once('/')?;
    (!owner.is_empty() && !repo.is_empty() && !repo.contains('/'))
        .then(|| (owner.to_owned(), repo.to_owned()))
}

/// The latest published release of a GitHub repository: its tag and the
/// commit it points at.
pub async fn latest_release(
    state: &AppState,
    url: &str,
    token: Option<&str>,
) -> Result<(String, String), String> {
    let (owner, repo) =
        github(url).ok_or("Releases are read from GitHub; the repository is elsewhere")?;
    let ask = |path: String, accept: &'static str| {
        let mut r = state
            .http
            .get(format!(
                "https://api.github.com/repos/{owner}/{repo}/{path}"
            ))
            .header("User-Agent", "mytunnels")
            .header("Accept", accept);
        if let Some(t) = token {
            r = r.bearer_auth(t);
        }
        r
    };
    let release: Value = ask("releases/latest".into(), "application/vnd.github+json")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("GitHub: {e}"))?
        .json()
        .await
        .map_err(|e| format!("GitHub: {e}"))?;
    let tag = release["tag_name"]
        .as_str()
        .ok_or("The repository has no release yet")?
        .to_owned();
    let sha = ask(format!("commits/{tag}"), "application/vnd.github.sha")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("GitHub: {e}"))?
        .text()
        .await
        .map_err(|e| format!("GitHub: {e}"))?;
    let sha = sha.trim().to_owned();
    if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("GitHub named no commit for {tag}"));
    }
    Ok((tag, sha))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_github_addresses_only() {
        assert_eq!(
            github("https://github.com/me/app.git"),
            Some(("me".into(), "app".into()))
        );
        assert_eq!(
            github("https://github.com/me/app/"),
            Some(("me".into(), "app".into()))
        );
        assert_eq!(github("https://gitlab.com/me/app"), None);
        assert_eq!(github("https://github.com/me"), None);
    }
}
