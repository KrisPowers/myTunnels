//! Automations: what happens between a container's new build and running it.
//!
//! A container built from a repository updates when its branch moves, when a
//! new GitHub release is published, on a timer, or when Update is pressed
//! (its `updates`). Its flow is the steps every new build passes first, in
//! order: a test is a command run in the new image, which must exit 0; a
//! review holds the build until someone approves it on the Automations page.
//! A build that passes every step goes live; one that fails a test, or is
//! turned down, never does, and the running container stays as it was.

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::Method;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::docker::{self, Endpoint};
use crate::state::AppState;
use crate::util::{ApiError, ApiResult};

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Step {
    /// A command run in the new image, with the container's environment.
    Test { name: String, command: String },
    /// Waits for someone to approve the build.
    Review,
}

/// The longest a test may run.
const TEST_WAIT: Duration = Duration::from_secs(30 * 60);
/// The most a test may print into the build's log.
const TEST_LOG: usize = 256 * 1024;

fn key(id: &str) -> String {
    format!("flow:{id}")
}

pub fn steps(state: &AppState, id: &str) -> Vec<Step> {
    state
        .db
        .setting(&key(id))
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn forget(state: &AppState, id: &str) {
    let _ = state.db.delete_setting(&key(id));
}

/// Steps worth keeping: tests with a command, each name and command trimmed,
/// at most twenty of them.
fn clean(steps: Vec<Step>) -> ApiResult<Vec<Step>> {
    if steps.len() > 20 {
        return Err(ApiError::bad("Up to 20 steps"));
    }
    steps
        .into_iter()
        .map(|s| match s {
            Step::Test { name, command } => {
                let command = command.trim().to_owned();
                if command.is_empty() || command.len() > 2000 {
                    return Err(ApiError::bad(
                        "Give each test a command, up to 2,000 characters",
                    ));
                }
                let name = name.trim();
                let name = if name.is_empty() { "Test" } else { name };
                Ok(Step::Test {
                    name: name.chars().take(60).collect(),
                    command,
                })
            }
            Step::Review => Ok(Step::Review),
        })
        .collect()
}

#[derive(Deserialize)]
pub struct StepsIn {
    steps: Vec<Step>,
}

pub async fn get_steps(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    state.db.deploy(&id)?.ok_or_else(ApiError::not_found)?;
    Ok(Json(json!({ "steps": steps(&state, &id) })))
}

pub async fn set_steps(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<StepsIn>,
) -> ApiResult<Json<Value>> {
    state.db.deploy(&id)?.ok_or_else(ApiError::not_found)?;
    let steps = clean(body.steps)?;
    state.db.set_setting(
        &key(&id),
        &serde_json::to_string(&steps).unwrap_or_default(),
    )?;
    Ok(Json(json!({ "steps": steps })))
}

/// Runs `command` in `image` as a container of its own, named after the
/// build, and says what it printed; Err when it did not exit 0.
pub async fn test(
    name: &str,
    image: &str,
    command: &str,
    env: &[String],
) -> Result<String, (String, String)> {
    let endpoint = Endpoint::from_env();
    let spec = json!({
        "Image": image,
        "Entrypoint": ["/bin/sh", "-c"],
        "Cmd": [command],
        "Env": env,
        "Tty": true,
        "Labels": { "mytunnels.test": "1" },
    });
    let fail = |why: String| (String::new(), why);
    let _ = docker::call(
        &endpoint,
        Method::DELETE,
        &format!("/containers/{name}?force=true"),
        Duration::from_secs(20),
    )
    .await;
    docker::call_with(
        &endpoint,
        Method::POST,
        &format!("/containers/create?name={name}"),
        Some(&spec),
        Duration::from_secs(60),
    )
    .await
    .map_err(|e| fail(format!("{e:#}")))?;
    let ran = async {
        docker::call(
            &endpoint,
            Method::POST,
            &format!("/containers/{name}/start"),
            Duration::from_secs(60),
        )
        .await?;
        let waited = docker::call(
            &endpoint,
            Method::POST,
            &format!("/containers/{name}/wait"),
            TEST_WAIT,
        )
        .await?;
        let code = serde_json::from_slice::<Value>(&waited)
            .ok()
            .and_then(|v| v["StatusCode"].as_i64())
            .unwrap_or(-1);
        let printed = docker::call(
            &endpoint,
            Method::GET,
            &format!("/containers/{name}/logs?stdout=1&stderr=1"),
            Duration::from_secs(60),
        )
        .await
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
        anyhow::Ok((code, printed))
    }
    .await;
    let _ = docker::call(
        &endpoint,
        Method::DELETE,
        &format!("/containers/{name}?force=true"),
        Duration::from_secs(20),
    )
    .await;
    let (code, mut printed) = ran.map_err(|e| fail(format!("{e:#}")))?;
    if printed.len() > TEST_LOG {
        printed.truncate(printed.floor_char_boundary(TEST_LOG));
        printed.push_str("\n[cut short]\n");
    }
    if code == 0 {
        Ok(printed)
    } else {
        Err((printed, format!("it exited with code {code}")))
    }
}

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

    #[test]
    fn steps_are_cleaned() {
        let out = clean(vec![
            Step::Test {
                name: " ".into(),
                command: " npm test ".into(),
            },
            Step::Review,
        ])
        .unwrap();
        assert_eq!(
            out,
            vec![
                Step::Test {
                    name: "Test".into(),
                    command: "npm test".into()
                },
                Step::Review
            ]
        );
        assert!(clean(vec![Step::Test {
            name: "x".into(),
            command: "  ".into()
        }])
        .is_err());
    }
}
