//! What mail serves through the tunnel: the address the Email Worker posts
//! received mail to, and the lookups mail apps make to find their settings
//! from an address alone (Autodiscover for Outlook, autoconfig for
//! Thunderbird and others).

use axum::body::{to_bytes, Body};
use axum::extract::Request;
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use super::mta::{relay_info, Inbound};
use super::{get, message, Receive, MAX_MESSAGE};

/// The hostnames mail answers through the tunnel.
pub fn hosts() -> Vec<String> {
    let Some(mail) = get() else {
        return Vec::new();
    };
    let s = mail.settings();
    if !s.ready() {
        return Vec::new();
    }
    let mut out = Vec::new();
    if s.receive == Receive::Cloudflare {
        out.push(s.inbound_host());
    }
    for d in &s.domains {
        out.push(format!("autodiscover.{}", d.name));
        out.push(format!("autoconfig.{}", d.name));
    }
    out
}

pub fn serves(host: &str) -> bool {
    hosts().iter().any(|h| h == host)
}

fn plain(code: StatusCode, text: &str) -> Response {
    (code, text.to_owned()).into_response()
}

pub async fn handle(host: &str, req: Request) -> Response {
    let Some(mail) = get() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let settings = mail.settings();
    let path = req.uri().path().to_ascii_lowercase();
    if host == settings.inbound_host() {
        return match (req.method(), path.as_str()) {
            (&Method::GET, "/health") => plain(StatusCode::OK, "mail ok"),
            (&Method::POST, "/inbound") => inbound(&mail, req).await,
            _ => StatusCode::NOT_FOUND.into_response(),
        };
    }
    let domain = host
        .strip_prefix("autodiscover.")
        .or_else(|| host.strip_prefix("autoconfig."))
        .unwrap_or("");
    let Some((imap_host, imap_port, smtp_host, smtp_port)) = settings.app_servers(&mail).await
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    let xml = |body: String| {
        (
            [(header::CONTENT_TYPE, "application/xml; charset=utf-8")],
            body,
        )
            .into_response()
    };
    if path.starts_with("/autodiscover/autodiscover.json") {
        return axum::Json(json!({
            "Protocol": "AutodiscoverV1",
            "Url": format!("https://{host}/autodiscover/autodiscover.xml"),
        }))
        .into_response();
    }
    if path == "/autodiscover/autodiscover.xml" {
        let body = to_bytes(req.into_body(), 64 << 10)
            .await
            .unwrap_or_default();
        let text = String::from_utf8_lossy(&body);
        let login = text
            .split("<EMailAddress>")
            .nth(1)
            .and_then(|s| s.split("</EMailAddress>").next())
            .map(|e| format!("\n        <LoginName>{}</LoginName>", esc(e.trim())))
            .unwrap_or_default();
        return xml(format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>{ih}</Server>
        <Port>{imap_port}</Port>{login}
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <SSL>on</SSL>
        <AuthRequired>on</AuthRequired>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>{sh}</Server>
        <Port>{smtp_port}</Port>{login}
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <SSL>on</SSL>
        <AuthRequired>on</AuthRequired>
        <UsePOPAuth>off</UsePOPAuth>
        <SMTPLast>off</SMTPLast>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>
"#,
            ih = esc(&imap_host),
            sh = esc(&smtp_host),
        ));
    }
    if path == "/mail/config-v1.1.xml" || path == "/.well-known/autoconfig/mail/config-v1.1.xml" {
        return xml(format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<clientConfig version="1.1">
  <emailProvider id="{d}">
    <domain>{d}</domain>
    <displayName>{d}</displayName>
    <incomingServer type="imap">
      <hostname>{ih}</hostname>
      <port>{imap_port}</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>{sh}</hostname>
      <port>{smtp_port}</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>
"#,
            d = esc(domain),
            ih = esc(&imap_host),
            sh = esc(&smtp_host),
        ));
    }
    StatusCode::NOT_FOUND.into_response()
}

/// `POST /inbound` from the Email Worker: 200 filed, 550 refused for good
/// (the Worker rejects the message), anything else tried again.
async fn inbound(mail: &super::Mail, req: Request) -> Response {
    let (from, rcpt, given) = {
        let head = |name: &str| {
            req.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .trim()
                .to_owned()
        };
        (
            head("x-mail-from"),
            head("x-rcpt-to"),
            head("authorization"),
        )
    };
    let settings = mail.settings();
    let given = given.strip_prefix("Bearer ").unwrap_or("");
    let secret = settings.secret.as_bytes();
    if secret.is_empty() || !super::same(given.as_bytes(), secret) {
        return plain(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    if rcpt.is_empty() {
        return plain(StatusCode::BAD_REQUEST, "missing recipient");
    }
    let body: Body = req.into_body();
    let Ok(body) = to_bytes(body, MAX_MESSAGE + 1).await else {
        return plain(
            StatusCode::from_u16(552).unwrap_or(StatusCode::PAYLOAD_TOO_LARGE),
            "message too large",
        );
    };
    let data = message::normalize_crlf(&body);
    let (ip, helo, spf) = relay_info(&data);
    let size = data.len();
    let got = mail
        .receive(
            Inbound {
                ip,
                helo,
                from: from.clone(),
                to: vec![rcpt.clone()],
                data,
                via: "Cloudflare Email Routing",
            },
            spf,
        )
        .await;
    match got {
        Ok(junk) => {
            mail.store.log(
                "in",
                &from,
                &rcpt,
                size,
                if junk { "junk" } else { "delivered" },
                "",
            );
            plain(StatusCode::OK, "stored")
        }
        Err(r) if r.code >= 500 => {
            mail.store.log("in", &from, &rcpt, size, "rejected", &r.msg);
            plain(
                StatusCode::from_u16(550).unwrap_or(StatusCode::BAD_REQUEST),
                &r.msg,
            )
        }
        Err(r) => {
            mail.store.log("in", &from, &rcpt, size, "failed", &r.msg);
            plain(StatusCode::SERVICE_UNAVAILABLE, "temporary failure")
        }
    }
}
