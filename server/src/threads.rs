//! Issues and pull requests in Git's repositories, kept in the database and
//! numbered together per repository. A pull request asks to merge one branch
//! into another; merging it makes the merge commit in the repository itself.

use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::code::{self, Level, Viewer};
use crate::db::{Comment, Thread};
use crate::permissions::Caller;
use crate::state::AppState;
use crate::util::{now, random_hex, ApiError, ApiResult};

const MAX_TITLE: usize = 200;
const MAX_BODY: usize = 64 * 1024;

/// How a person shows on issues and pull requests, and signs a merge.
fn person(state: &AppState, id: &str) -> (String, String) {
    match state.snapshot().users.get(id) {
        Some(u) => (
            if u.name.is_empty() {
                u.username.clone()
            } else {
                u.name.clone()
            },
            u.email.clone(),
        ),
        None => ("Removed account".into(), String::new()),
    }
}

fn shown(state: &AppState, t: &Thread, comments: i64) -> Value {
    json!({
        "number": t.number,
        "kind": t.kind,
        "title": t.title,
        "body": t.body,
        "state": t.state,
        "author": person(state, &t.author).0,
        "base": t.base,
        "head": t.head,
        "merged_commit": t.merged_commit,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
        "comments": comments,
    })
}

fn kind_of(kind: &str) -> ApiResult<&'static str> {
    match kind {
        "issue" | "issues" => Ok("issue"),
        "pull" | "pulls" => Ok("pull"),
        _ => Err(ApiError::bad("Issues or pull requests")),
    }
}

fn found(state: &AppState, repo: &str, number: i64) -> ApiResult<Thread> {
    state
        .db
        .thread(repo, number)?
        .ok_or_else(ApiError::not_found)
}

/// A repository's issues or pull requests.
pub async fn list(
    state: &AppState,
    viewer: &Viewer,
    repo: &str,
    kind: &str,
) -> ApiResult<Json<Value>> {
    code::need(state, viewer, repo, Level::Read)?;
    let kind = kind_of(kind)?;
    let threads: Vec<Value> = state
        .db
        .threads(repo, kind)?
        .iter()
        .map(|(t, n)| shown(state, t, *n))
        .collect();
    Ok(Json(json!({ "threads": threads })))
}

#[derive(Deserialize)]
pub struct NewThread {
    kind: String,
    title: String,
    #[serde(default)]
    body: String,
    base: Option<String>,
    head: Option<String>,
}

/// Opens an issue, or a pull request from one branch into another.
pub async fn open(
    state: &AppState,
    caller: &Caller,
    repo: &str,
    body: NewThread,
) -> ApiResult<Json<Value>> {
    let dir = code::need(state, &Viewer::of(caller), repo, Level::Read)?;
    let kind = kind_of(&body.kind)?;
    let title = body.title.trim();
    if title.is_empty() || title.len() > MAX_TITLE {
        return Err(ApiError::bad("Give it a title, up to 200 characters"));
    }
    if body.body.len() > MAX_BODY {
        return Err(ApiError::bad("That description is too long"));
    }
    let (base, head) = if kind == "pull" {
        let base = code::checked_ref(body.base.as_deref().unwrap_or(""))?.to_owned();
        let head = code::checked_ref(body.head.as_deref().unwrap_or(""))?.to_owned();
        if base == head {
            return Err(ApiError::bad("Pick two different branches"));
        }
        for b in [&base, &head] {
            code::git(&dir, &["rev-parse", "--verify", &format!("refs/heads/{b}")])
                .await
                .map_err(|_| ApiError::bad(format!("There is no branch {b}")))?;
        }
        (Some(base), Some(head))
    } else {
        (None, None)
    };
    let now = now();
    let mut thread = Thread {
        repo: repo.to_owned(),
        number: 0,
        kind: kind.to_owned(),
        title: title.to_owned(),
        body: body.body,
        state: "open".into(),
        author: caller.id().to_owned(),
        base,
        head,
        merged_commit: None,
        created_at: now,
        updated_at: now,
    };
    thread.number = state.db.insert_thread(&thread)?;
    Ok(Json(shown(state, &thread, 0)))
}

/// One issue or pull request with its comments; a pull request also with its
/// commits, changes and whether it can merge.
pub async fn get(
    state: &AppState,
    viewer: &Viewer,
    repo: &str,
    number: i64,
) -> ApiResult<Json<Value>> {
    let dir = code::need(state, viewer, repo, Level::Read)?;
    let thread = found(state, repo, number)?;
    let comments: Vec<Value> = state
        .db
        .comments(repo, number)?
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                "author": person(state, &c.author).0,
                "body": c.body,
                "created_at": c.created_at,
            })
        })
        .collect();
    let mut view = shown(state, &thread, comments.len() as i64);
    view["thread"] = json!(comments);
    if let (Some(base), Some(head)) = (&thread.base, &thread.head) {
        // A merged pull request shows what it brought; an open one, what it would.
        let changes = match &thread.merged_commit {
            Some(commit) => {
                code::compare(&dir, &format!("{commit}^1"), &format!("{commit}^2")).await
            }
            None => code::compare(&dir, base, head).await,
        };
        view["changes"] = changes.unwrap_or_else(|e| json!({ "error": e.1 }));
    }
    Ok(Json(view))
}

#[derive(Deserialize)]
pub struct ThreadEdit {
    title: Option<String>,
    body: Option<String>,
    /// "open" or "closed".
    state: Option<String>,
}

/// Retitles, rewrites, closes or reopens an issue or pull request.
pub async fn edit(
    state: &AppState,
    caller: &Caller,
    repo: &str,
    number: i64,
    body: ThreadEdit,
) -> ApiResult<Json<Value>> {
    let viewer = Viewer::of(caller);
    code::need(state, &viewer, repo, Level::Read)?;
    let mut thread = found(state, repo, number)?;
    if let Some(title) = body.title {
        let title = title.trim();
        if title.is_empty() || title.len() > MAX_TITLE {
            return Err(ApiError::bad("Give it a title, up to 200 characters"));
        }
        thread.title = title.to_owned();
    }
    if let Some(text) = body.body {
        if text.len() > MAX_BODY {
            return Err(ApiError::bad("That description is too long"));
        }
        thread.body = text;
    }
    if let Some(next) = body.state {
        if thread.state == "merged" {
            return Err(ApiError::bad("A merged pull request stays merged"));
        }
        if next != "open" && next != "closed" {
            return Err(ApiError::bad("Open or closed"));
        }
        thread.state = next;
    }
    thread.updated_at = now();
    state.db.update_thread(&thread)?;
    get(state, &viewer, repo, number).await
}

#[derive(Deserialize)]
pub struct NewComment {
    body: String,
}

pub async fn comment(
    state: &AppState,
    caller: &Caller,
    repo: &str,
    number: i64,
    body: NewComment,
) -> ApiResult<Json<Value>> {
    let viewer = Viewer::of(caller);
    code::need(state, &viewer, repo, Level::Read)?;
    let mut thread = found(state, repo, number)?;
    let text = body.body.trim();
    if text.is_empty() || text.len() > MAX_BODY {
        return Err(ApiError::bad("Write a comment"));
    }
    state.db.insert_comment(
        repo,
        number,
        &Comment {
            id: random_hex(8),
            author: caller.id().to_owned(),
            body: text.to_owned(),
            created_at: now(),
        },
    )?;
    thread.updated_at = now();
    state.db.update_thread(&thread)?;
    get(state, &viewer, repo, number).await
}

/// Merges an open pull request into its base branch, signed by `caller`.
pub async fn merge(
    state: &AppState,
    caller: &Caller,
    repo: &str,
    number: i64,
) -> ApiResult<Json<Value>> {
    let viewer = Viewer::of(caller);
    let dir = code::need(state, &viewer, repo, Level::Write)?;
    let mut thread = found(state, repo, number)?;
    let (Some(base), Some(head)) = (thread.base.clone(), thread.head.clone()) else {
        return Err(ApiError::bad("Only a pull request merges"));
    };
    if thread.state != "open" {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Only an open pull request merges".into(),
        ));
    }
    let (name, email) = person(state, caller.id());
    let message = format!(
        "Merge pull request #{number} from {head}\n\n{}",
        thread.title
    );
    let commit = code::merge(&dir, &base, &head, &message, (&name, &email)).await?;
    thread.state = "merged".into();
    thread.merged_commit = Some(commit);
    thread.updated_at = now();
    state.db.update_thread(&thread)?;
    get(state, &viewer, repo, number).await
}
