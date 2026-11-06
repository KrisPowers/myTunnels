//! The Images page: every image the engine keeps, the containers using each,
//! one image's details and layers, and deleting one nothing uses.

use std::time::Duration;

use axum::extract::Path;
use axum::http::StatusCode;
use axum::Json;
use hyper::Method;
use serde_json::{json, Value};

use crate::docker::{self, Endpoint};
use crate::util::{ApiError, ApiResult};

const DELETE_WAIT: Duration = Duration::from_secs(60);

fn engine_error(err: anyhow::Error) -> ApiError {
    ApiError(StatusCode::BAD_GATEWAY, format!("{err:#}"))
}

/// An image named in a request: its full ID and nothing else.
fn checked(id: &str) -> ApiResult<String> {
    let hex = id.strip_prefix("sha256:").unwrap_or(id);
    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(format!("sha256:{}", hex.to_ascii_lowercase()))
    } else {
        Err(ApiError::bad("No such image"))
    }
}

/// The names a container goes by in the list, without the leading slash.
fn name_of(names: &Value) -> String {
    names[0]
        .as_str()
        .unwrap_or_default()
        .trim_start_matches('/')
        .to_owned()
}

fn tags(image: &Value) -> Vec<String> {
    image["RepoTags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|t| *t != "<none>:<none>")
        .map(str::to_owned)
        .collect()
}

/// Which containers use which image, by image ID: `(id, name, state)`.
async fn users(endpoint: &Endpoint) -> ApiResult<Vec<(String, Value)>> {
    let listed = docker::get(endpoint, "/containers/json?all=1")
        .await
        .map_err(engine_error)?;
    Ok(listed
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            (
                c["ImageID"].as_str().unwrap_or_default().to_owned(),
                json!({ "id": c["Id"], "name": name_of(&c["Names"]), "state": c["State"] }),
            )
        })
        .collect())
}

pub async fn list() -> ApiResult<Json<Value>> {
    let endpoint = Endpoint::from_env();
    let listed = docker::get(&endpoint, "/images/json")
        .await
        .map_err(engine_error)?;
    let users = users(&endpoint).await?;
    let images: Vec<Value> = listed
        .as_array()
        .into_iter()
        .flatten()
        .map(|i| {
            let id = i["Id"].as_str().unwrap_or_default();
            let used: Vec<&Value> = users
                .iter()
                .filter(|(of, _)| of == id)
                .map(|(_, c)| c)
                .collect();
            json!({
                "id": id,
                "tags": tags(i),
                "created": i["Created"],
                "size": i["Size"],
                "containers": used,
            })
        })
        .collect();
    Ok(Json(json!(images)))
}

/// One image in full: where it came from, what it runs, and its layers.
pub async fn inspect(Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let endpoint = Endpoint::from_env();
    let id = checked(&id)?;
    let i = docker::get(&endpoint, &format!("/images/{id}/json"))
        .await
        .map_err(engine_error)?;
    let history = docker::get(&endpoint, &format!("/images/{id}/history"))
        .await
        .map_err(engine_error)?;
    let config = &i["Config"];
    let strings = |v: &Value| -> Vec<String> {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    };
    let ports: Vec<String> = config["ExposedPorts"]
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let layers: Vec<Value> = history
        .as_array()
        .into_iter()
        .flatten()
        .map(|l| {
            json!({
                "created": l["Created"],
                "command": l["CreatedBy"].as_str().unwrap_or_default().trim_start_matches("/bin/sh -c #(nop) ").trim(),
                "size": l["Size"],
            })
        })
        .collect();
    let used: Vec<Value> = users(&endpoint)
        .await?
        .into_iter()
        .filter(|(of, _)| *of == id)
        .map(|(_, c)| c)
        .collect();
    Ok(Json(json!({
        "id": id,
        "tags": tags(&i),
        "digests": strings(&i["RepoDigests"]),
        "created": i["Created"],
        "size": i["Size"],
        "platform": format!("{}/{}", i["Os"].as_str().unwrap_or("?"), i["Architecture"].as_str().unwrap_or("?")),
        "entrypoint": strings(&config["Entrypoint"]),
        "command": strings(&config["Cmd"]),
        "workdir": config["WorkingDir"],
        "user": config["User"],
        "ports": ports,
        "env": strings(&config["Env"]),
        "labels": config["Labels"],
        "layers": layers,
        "containers": used,
    })))
}

/// Deletes an image no container uses; the engine refuses one that is used.
pub async fn remove(Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let endpoint = Endpoint::from_env();
    let id = checked(&id)?;
    docker::call(
        &endpoint,
        Method::DELETE,
        &format!("/images/{id}"),
        DELETE_WAIT,
    )
    .await
    .map_err(engine_error)?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_full_image_ids_are_taken() {
        let hex = "a".repeat(64);
        assert_eq!(checked(&hex).unwrap(), format!("sha256:{hex}"));
        assert_eq!(
            checked(&format!("sha256:{hex}")).unwrap(),
            format!("sha256:{hex}")
        );
        assert!(checked("nginx:latest").is_err());
        assert!(checked(&format!("{hex}/../x")).is_err());
    }

    #[test]
    fn untagged_images_have_no_tags() {
        let image = json!({ "RepoTags": ["<none>:<none>", "nginx:1.27"] });
        assert_eq!(tags(&image), ["nginx:1.27"]);
    }
}
