use std::net::IpAddr;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use hyper_util::rt::TokioIo;

use crate::db::Route;
use crate::gate;
use crate::state::{AppState, Snapshot};

/// Marks a request the gateway has already forwarded once.
pub const HOP_HEADER: &str = "x-gateway-hop";

const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Forwards a request to the tunnel's local app, including WebSocket upgrades.
pub async fn forward(
    state: &AppState,
    snap: &Snapshot,
    route: &Route,
    ip: Option<IpAddr>,
    mut req: Request,
) -> Response {
    let host = route.target_host.as_deref().unwrap_or(&snap.upstream_host);
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let path = req.uri().path_and_query().map_or("/", |p| p.as_str());
    let url = format!(
        "{}://{}:{}{}",
        route.target_scheme, host, route.target_port, path
    );

    let upgrade = is_upgrade(req.headers());
    let client_upgrade = upgrade.then(|| hyper::upgrade::on(&mut req));
    let (parts, body) = req.into_parts();
    let has_body = parts.headers.contains_key(header::TRANSFER_ENCODING)
        || parts
            .headers
            .get(header::CONTENT_LENGTH)
            .is_some_and(|v| v.as_bytes() != b"0");

    let mut headers = parts.headers;
    let original_host = headers.get(header::HOST).cloned();
    strip_hop_by_hop(&mut headers, upgrade);
    strip_gate_cookies(&mut headers);
    if let Some(ip) = ip.and_then(|ip| HeaderValue::from_str(&ip.to_string()).ok()) {
        headers.insert("x-forwarded-for", ip.clone());
        headers.insert("x-real-ip", ip);
    }
    headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
    headers.insert(HOP_HEADER, HeaderValue::from_static("1"));
    // The app sees the request as if opened on this machine, which apps that
    // only answer to localhost need; the public name travels as X-Forwarded-Host.
    let local = format!(
        "{}:{}",
        route.target_host.as_deref().unwrap_or("localhost"),
        route.target_port
    );
    let local_origin = format!("{}://{local}", route.target_scheme);
    let public_origin = format!("https://{}", route.hostname);
    if let Ok(value) = HeaderValue::from_str(&local) {
        headers.insert(header::HOST, value);
    }
    for name in [header::ORIGIN, header::REFERER] {
        swap_origin(&mut headers, name, &public_origin, &local_origin);
    }
    if let Some(original_host) = original_host {
        headers.insert("x-forwarded-host", original_host);
    }

    let mut outbound = state.proxy.request(parts.method, url).headers(headers);
    if has_body {
        outbound = outbound.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }
    let upstream = match outbound.send().await {
        Ok(resp) => resp,
        Err(err) => {
            tracing::warn!("{} upstream failed: {err}", route.hostname);
            return gate::page(
                StatusCode::BAD_GATEWAY,
                "message",
                &route.hostname,
                "App not responding",
                &format!("Nothing answered on port {}.", route.target_port),
            );
        }
    };

    let status = upstream.status();
    let mut response_headers = upstream.headers().clone();

    if status == StatusCode::SWITCHING_PROTOCOLS {
        let Some(client_upgrade) = client_upgrade else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        let mut upstream_io = match upstream.upgrade().await {
            Ok(io) => io,
            Err(err) => {
                tracing::warn!("{} upgrade failed: {err}", route.hostname);
                return StatusCode::BAD_GATEWAY.into_response();
            }
        };
        tokio::spawn(async move {
            match client_upgrade.await {
                Ok(client) => {
                    let mut client_io = TokioIo::new(client);
                    let _ = tokio::io::copy_bidirectional(&mut client_io, &mut upstream_io).await;
                }
                Err(err) => tracing::debug!("client upgrade failed: {err}"),
            }
        });
        let mut response = Response::new(Body::empty());
        *response.status_mut() = status;
        *response.headers_mut() = response_headers;
        return response;
    }

    strip_hop_by_hop(&mut response_headers, false);
    // Redirects to the app's local address go to the public one instead.
    for from in [
        local_origin.clone(),
        format!("{}://127.0.0.1:{}", route.target_scheme, route.target_port),
    ] {
        swap_origin(
            &mut response_headers,
            header::LOCATION,
            &from,
            &public_origin,
        );
    }
    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;
    response
}

/// Replaces a leading `from` origin in a header with `to`.
fn swap_origin(headers: &mut HeaderMap, name: HeaderName, from: &str, to: &str) {
    let swapped = headers
        .get(&name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix(from))
        .filter(|rest| rest.is_empty() || rest.starts_with('/') || rest.starts_with('?'))
        .and_then(|rest| HeaderValue::from_str(&format!("{to}{rest}")).ok());
    if let Some(value) = swapped {
        headers.insert(name, value);
    }
}

fn is_upgrade(headers: &HeaderMap) -> bool {
    headers.contains_key(header::UPGRADE)
        && headers
            .get_all(header::CONNECTION)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
}

fn strip_hop_by_hop(headers: &mut HeaderMap, keep_upgrade: bool) {
    let listed: Vec<HeaderName> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|token| HeaderName::from_bytes(token.trim().as_bytes()).ok())
        .collect();
    for name in listed {
        if !(keep_upgrade && name == header::UPGRADE) {
            headers.remove(name);
        }
    }
    for name in HOP_BY_HOP {
        if keep_upgrade && (name == "connection" || name == "upgrade") {
            continue;
        }
        headers.remove(name);
    }
}

/// Keeps the gateway's own cookies away from the apps behind it.
fn strip_gate_cookies(headers: &mut HeaderMap) {
    let cookies: Vec<&str> = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .collect();
    if !cookies.iter().any(|c| c.starts_with("__gate_")) {
        return;
    }
    let kept = cookies
        .into_iter()
        .filter(|c| !c.starts_with("__gate_"))
        .collect::<Vec<_>>()
        .join("; ");
    headers.remove(header::COOKIE);
    if let Ok(value) = HeaderValue::from_str(&kept) {
        if !kept.is_empty() {
            headers.insert(header::COOKIE, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_swap_only_on_a_whole_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::LOCATION,
            HeaderValue::from_static("http://localhost:8090/login?x=1"),
        );
        swap_origin(
            &mut headers,
            header::LOCATION,
            "http://localhost:8090",
            "https://app.example.com",
        );
        assert_eq!(
            headers.get(header::LOCATION).unwrap(),
            "https://app.example.com/login?x=1"
        );

        headers.insert(
            header::LOCATION,
            HeaderValue::from_static("http://localhost:80901/x"),
        );
        swap_origin(
            &mut headers,
            header::LOCATION,
            "http://localhost:8090",
            "https://app.example.com",
        );
        assert_eq!(
            headers.get(header::LOCATION).unwrap(),
            "http://localhost:80901/x"
        );
    }

    #[test]
    fn gate_cookies_never_reach_the_app() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; __gate_device=secret; b=2; __gate_session=x"),
        );
        strip_gate_cookies(&mut headers);
        assert_eq!(headers.get(header::COOKIE).unwrap(), "a=1; b=2");
    }

    #[test]
    fn upgrade_headers_survive_only_for_upgrades() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONNECTION,
            HeaderValue::from_static("keep-alive, Upgrade"),
        );
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert("keep-alive", HeaderValue::from_static("timeout=5"));
        assert!(is_upgrade(&headers));

        let mut kept = headers.clone();
        strip_hop_by_hop(&mut kept, true);
        assert!(kept.contains_key(header::UPGRADE));
        assert!(!kept.contains_key("keep-alive"));

        strip_hop_by_hop(&mut headers, false);
        assert!(headers.is_empty());
    }
}
