//! The panel over HTTPS on the LAN, so passwords and sessions never cross the
//! network in clear text. It serves the certificate in `<data>/tls`: one made on
//! first start, or the owner's own put there in its place.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Router;
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use tokio::net::TcpListener;
use tokio_rustls::rustls::pki_types::pem::PemObject;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;
use tower::ServiceExt;

/// Marks a request that reached the panel over HTTPS, here or through a tunnel,
/// so its cookies are set `Secure`.
#[derive(Clone, Copy)]
pub struct Https;

/// The certificate and key in `dir`, made self-signed when there are none.
pub fn acceptor(dir: &Path) -> Result<TlsAcceptor> {
    let cert = dir.join("cert.pem");
    let key = dir.join("key.pem");
    if !cert.exists() || !key.exists() {
        std::fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
        let mut names = vec!["localhost".to_owned()];
        names.extend(std::env::var("HOSTNAME").ok().filter(|h| !h.is_empty()));
        let made = rcgen::generate_simple_self_signed(names)?;
        std::fs::write(&cert, made.cert.pem())?;
        std::fs::write(&key, made.key_pair.serialize_pem())?;
        tracing::info!("made a self-signed certificate in {}", dir.display());
    }
    let chain = CertificateDer::pem_file_iter(&cert)
        .with_context(|| format!("cannot read {}", cert.display()))?
        .collect::<Result<Vec<_>, _>>()?;
    let private = PrivateKeyDer::from_pem_file(&key)
        .with_context(|| format!("cannot read {}", key.display()))?;
    let mut config = ServerConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_no_client_auth()
    .with_single_cert(chain, private)?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// Serves `app` over TLS on `listener`, each request knowing its peer.
pub async fn serve(listener: TcpListener, acceptor: TlsAcceptor, app: Router) -> Result<()> {
    loop {
        let (tcp, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(err) => {
                tracing::debug!("https accept failed: {err}");
                continue;
            }
        };
        let acceptor = acceptor.clone();
        let app = app.clone();
        tokio::spawn(async move {
            let Ok(stream) = acceptor.accept(tcp).await else {
                return;
            };
            let service = app.map_request(move |mut req: Request<hyper::body::Incoming>| {
                req.extensions_mut().insert(ConnectInfo::<SocketAddr>(peer));
                req.extensions_mut().insert(Https);
                req
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), TowerToHyperService::new(service))
                .with_upgrades()
                .await;
        });
    }
}

/// On the plain HTTP port, a browser on another machine is sent to HTTPS before
/// it can sign in. This machine and git keep plain HTTP.
pub async fn send_to_https(State(port): State<u16>, req: Request, next: Next) -> Response {
    let local = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|c| c.0.ip().is_loopback());
    let path = req.uri().path();
    if local || path.starts_with("/git/") {
        return next.run(req).await;
    }
    if path.starts_with("/api/") {
        return (
            StatusCode::FORBIDDEN,
            "Open the panel over HTTPS, on port {port}.".replace("{port}", &port.to_string()),
        )
            .into_response();
    }
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|h| {
            h.rsplit_once(':')
                .filter(|(_, p)| p.bytes().all(|b| b.is_ascii_digit()))
                .map_or(h, |(h, _)| h)
        })
        .unwrap_or("localhost");
    let target = req.uri().path_and_query().map_or("/", |p| p.as_str());
    let mut response = StatusCode::PERMANENT_REDIRECT.into_response();
    if let Ok(location) = HeaderValue::from_str(&format!("https://{host}:{port}{target}")) {
        response.headers_mut().insert(header::LOCATION, location);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_and_reloads_a_certificate() {
        let dir = std::env::temp_dir().join(format!("tls-{}", crate::util::random_hex(6)));
        assert!(acceptor(&dir).is_ok());
        assert!(dir.join("cert.pem").exists());
        assert!(acceptor(&dir).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }
}
