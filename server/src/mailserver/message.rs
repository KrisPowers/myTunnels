//! Messages as RFC 5322 and MIME see them: header fields with their exact
//! bytes, which IMAP and DKIM need, and a tree of parts kept as ranges into
//! the raw message.

use std::ops::Range;

use base64::Engine;

/// One header field.
#[derive(Clone, Debug)]
pub struct Field {
    /// As written, such as `Content-Type`.
    pub name: String,
    /// Unfolded, with the whitespace around it trimmed.
    pub value: String,
    /// The exact bytes, folding and the CRLF ending included.
    pub raw: Vec<u8>,
}

/// The first field named `name`, ignoring case, or "".
pub fn get<'a>(header: &'a [Field], name: &str) -> &'a str {
    header
        .iter()
        .find(|f| f.name.eq_ignore_ascii_case(name))
        .map_or("", |f| f.value.as_str())
}

pub fn has(header: &[Field], name: &str) -> bool {
    header.iter().any(|f| f.name.eq_ignore_ascii_case(name))
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Where the header ends, the blank line that closes it included.
pub fn header_len(raw: &[u8]) -> usize {
    if raw.starts_with(b"\r\n") {
        return 2;
    }
    find(raw, b"\r\n\r\n").map_or(raw.len(), |i| i + 4)
}

/// The header, with the blank line that closes it, and the body.
pub fn split_header(raw: &[u8]) -> (&[u8], &[u8]) {
    raw.split_at(header_len(raw))
}

pub fn parse_header(hdr: &[u8]) -> Vec<Field> {
    let mut fields = Vec::new();
    let mut rest = hdr;
    while !rest.is_empty() {
        // A field ends at a CRLF not followed by a space or tab.
        let mut end = 0;
        loop {
            match find(&rest[end..], b"\r\n") {
                None => {
                    end = rest.len();
                    break;
                }
                Some(i) => {
                    end += i + 2;
                    if end >= rest.len() || (rest[end] != b' ' && rest[end] != b'\t') {
                        break;
                    }
                }
            }
        }
        let (raw, next) = rest.split_at(end);
        rest = next;
        if raw == b"\r\n" {
            break;
        }
        let Some(colon) = raw.iter().position(|&b| b == b':') else {
            continue;
        };
        let name = String::from_utf8_lossy(&raw[..colon]).trim_end().to_owned();
        let value = String::from_utf8_lossy(&raw[colon + 1..])
            .replace(['\r', '\n'], "")
            .trim()
            .to_owned();
        fields.push(Field {
            name,
            value,
            raw: raw.to_vec(),
        });
    }
    fields
}

/// A node of the MIME tree; the root is the whole message.
#[derive(Debug)]
pub struct Part {
    pub header: Vec<Field>,
    /// The header and the blank line after it.
    pub head: Range<usize>,
    pub body: Range<usize>,
    /// Lowercased, such as `text` and `plain`.
    pub kind: String,
    pub sub: String,
    /// Content-Type parameters, their names lowercased.
    pub params: Vec<(String, String)>,
    pub children: Vec<Part>,
    /// The message inside a message/rfc822 part.
    pub embedded: Option<Box<Part>>,
}

impl Part {
    pub fn param(&self, name: &str) -> &str {
        self.params
            .iter()
            .find(|(k, _)| k == name)
            .map_or("", |(_, v)| v.as_str())
    }

    pub fn is_multipart(&self) -> bool {
        self.kind == "multipart"
    }

    /// Calls `f` for this part and every one under it.
    pub fn walk<'a>(&'a self, f: &mut impl FnMut(&'a Part)) {
        f(self);
        for c in &self.children {
            c.walk(f);
        }
        if let Some(e) = &self.embedded {
            e.walk(f);
        }
    }

    /// The body with its transfer encoding undone.
    pub fn decoded(&self, raw: &[u8]) -> Vec<u8> {
        let body = &raw[self.body.clone()];
        match get(&self.header, "Content-Transfer-Encoding")
            .to_ascii_lowercase()
            .as_str()
        {
            "base64" => base64_lenient(body),
            "quoted-printable" => quoted_printable(body),
            _ => body.to_vec(),
        }
    }

    /// The attachment's file name, from Content-Disposition or Content-Type.
    pub fn file_name(&self) -> String {
        let name = parse_media_type(get(&self.header, "Content-Disposition"))
            .and_then(|(_, p)| p.into_iter().find(|(k, _)| k == "filename").map(|(_, v)| v))
            .unwrap_or_else(|| self.param("name").to_owned());
        decode_header(name.trim())
    }
}

const MAX_DEPTH: usize = 32;

pub fn parse(raw: &[u8]) -> Part {
    parse_part(raw, 0..raw.len(), "text/plain", 0)
}

fn parse_part(raw: &[u8], at: Range<usize>, default: &str, depth: usize) -> Part {
    let slice = &raw[at.clone()];
    let hlen = header_len(slice);
    let header = parse_header(&slice[..hlen]);
    let (media, mut params) = parse_media_type(get(&header, "Content-Type"))
        .filter(|(m, _)| m.contains('/'))
        .unwrap_or_else(|| {
            let params = if default == "text/plain" {
                vec![("charset".to_owned(), "us-ascii".to_owned())]
            } else {
                Vec::new()
            };
            (default.to_owned(), params)
        });
    let (kind, sub) = media.split_once('/').unwrap_or(("text", "plain"));
    params.retain(|(k, _)| !k.is_empty());
    let mut part = Part {
        header,
        head: at.start..at.start + hlen,
        body: at.start + hlen..at.end,
        kind: kind.to_owned(),
        sub: sub.to_owned(),
        params,
        children: Vec::new(),
        embedded: None,
    };
    if depth >= MAX_DEPTH {
        return part;
    }
    let boundary = part.param("boundary").to_owned();
    if part.kind == "multipart" && !boundary.is_empty() {
        let child = if part.sub == "digest" {
            "message/rfc822"
        } else {
            "text/plain"
        };
        let base = part.body.start;
        for r in split_multipart(&raw[part.body.clone()], &boundary) {
            part.children.push(parse_part(
                raw,
                base + r.start..base + r.end,
                child,
                depth + 1,
            ));
        }
    } else if part.kind == "message" && part.sub == "rfc822" {
        part.embedded = Some(Box::new(parse_part(
            raw,
            part.body.clone(),
            "text/plain",
            depth + 1,
        )));
    }
    part
}

/// The bodies between the boundary lines, without preamble or epilogue.
fn split_multipart(body: &[u8], boundary: &str) -> Vec<Range<usize>> {
    let delim = format!("--{boundary}");
    let delim = delim.as_bytes();
    let mut parts = Vec::new();
    let mut start: Option<usize> = None;
    let mut off = 0;
    while off <= body.len() {
        let (line, next) = match find(&body[off..], b"\r\n") {
            Some(i) => (&body[off..off + i], off + i + 2),
            None => (&body[off..], body.len() + 1),
        };
        if let Some(rest) = line.strip_prefix(delim) {
            let closing = rest.starts_with(b"--");
            if closing || rest.iter().all(|&b| b == b' ' || b == b'\t') {
                if let Some(s) = start {
                    // The CRLF before a boundary belongs to the boundary.
                    let end = off.saturating_sub(2).max(s);
                    parts.push(s..end);
                }
                if closing {
                    return parts;
                }
                start = Some(next.min(body.len()));
            }
        }
        off = next;
    }
    if let Some(s) = start.filter(|&s| s < body.len()) {
        parts.push(s..body.len());
    }
    parts
}

/// A Content-Type or Content-Disposition value: the lowercased media type and
/// its parameters. RFC 2231 `name*=utf-8''...` values are decoded.
pub fn parse_media_type(v: &str) -> Option<(String, Vec<(String, String)>)> {
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    let mut chars = v.char_indices().peekable();
    let mut media_end = v.len();
    for (i, c) in chars.by_ref() {
        if c == ';' {
            media_end = i;
            break;
        }
    }
    let media = v[..media_end].trim().to_ascii_lowercase();
    if media.is_empty() {
        return None;
    }
    let mut params = Vec::new();
    let mut rest = v.get(media_end + 1..).unwrap_or("");
    while !rest.trim().is_empty() {
        let Some(eq) = rest.find('=') else { break };
        let key = rest[..eq].trim().to_ascii_lowercase();
        let after = rest[eq + 1..].trim_start();
        let (value, remaining) = if let Some(q) = after.strip_prefix('"') {
            let mut out = String::new();
            let mut esc = false;
            let mut end = q.len();
            for (i, c) in q.char_indices() {
                if esc {
                    out.push(c);
                    esc = false;
                } else if c == '\\' {
                    esc = true;
                } else if c == '"' {
                    end = i + 1;
                    break;
                } else {
                    out.push(c);
                }
            }
            let tail = &q[end.min(q.len())..];
            (out, tail.find(';').map_or("", |i| &tail[i + 1..]))
        } else {
            match after.find(';') {
                Some(i) => (after[..i].trim().to_owned(), &after[i + 1..]),
                None => (after.trim().to_owned(), ""),
            }
        };
        rest = remaining;
        if let Some(base) = key.strip_suffix('*') {
            // charset'language'percent-encoded
            let decoded = value
                .splitn(3, '\'')
                .nth(2)
                .map(|enc| String::from_utf8_lossy(&percent_decode(enc)).into_owned())
                .unwrap_or(value);
            params.push((base.to_owned(), decoded));
        } else if let Some((base, _)) = key.split_once("*0") {
            params.push((base.to_owned(), value));
        } else {
            params.push((key, value));
        }
    }
    Some((media, params))
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if let Some(v) = b
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// Counts lines as IMAP BODYSTRUCTURE does.
pub fn lines(b: &[u8]) -> usize {
    let n = b.iter().filter(|&&c| c == b'\n').count();
    if b.last().is_some_and(|&c| c != b'\n') {
        n + 1
    } else {
        n
    }
}

/// Bare LF and bare CR line endings made CRLF.
pub fn normalize_crlf(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len() + b.len() / 50);
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\r' => {
                out.extend_from_slice(b"\r\n");
                if b.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
            }
            b'\n' => out.extend_from_slice(b"\r\n"),
            c => out.push(c),
        }
        i += 1;
    }
    out
}

pub fn base64_lenient(body: &[u8]) -> Vec<u8> {
    let clean: Vec<u8> = body
        .iter()
        .copied()
        .filter(|c| c.is_ascii_alphanumeric() || *c == b'+' || *c == b'/')
        .collect();
    // A lone leftover character carries no whole byte.
    let usable = clean.len() - usize::from(clean.len() % 4 == 1);
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    LENIENT.decode(&clean[..usable]).unwrap_or_default()
}

pub fn quoted_printable(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len());
    let mut i = 0;
    while i < body.len() {
        if body[i] == b'=' {
            if body.get(i + 1..i + 3) == Some(b"\r\n") {
                i += 3;
                continue;
            }
            if body.get(i + 1) == Some(&b'\n') {
                i += 2;
                continue;
            }
            if let Some(v) = body
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(body[i]);
        i += 1;
    }
    out
}

/// Text in `charset` as UTF-8: UTF-8 and ASCII as they are, Latin-1 mapped.
pub fn charset_text(bytes: &[u8], charset: &str) -> String {
    match charset.to_ascii_lowercase().as_str() {
        "iso-8859-1" | "latin1" | "windows-1252" | "us-ascii"
            if std::str::from_utf8(bytes).is_err() =>
        {
            bytes.iter().map(|&b| b as char).collect()
        }
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// RFC 2047 encoded words decoded.
pub fn decode_header(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    let mut last_was_word = false;
    while let Some(start) = rest.find("=?") {
        let before = &rest[..start];
        let tail = &rest[start + 2..];
        let decoded = (|| {
            let (charset, tail) = tail.split_once('?')?;
            let (enc, tail) = tail.split_once('?')?;
            let end = tail.find("?=")?;
            let text = &tail[..end];
            let bytes = match enc.to_ascii_lowercase().as_str() {
                "b" => base64_lenient(text.as_bytes()),
                "q" => quoted_printable(text.replace('_', " ").as_bytes()),
                _ => return None,
            };
            let charset = charset.split('*').next().unwrap_or(charset);
            Some((charset_text(&bytes, charset), &tail[end + 2..]))
        })();
        match decoded {
            Some((text, after)) => {
                // Whitespace between two encoded words is dropped.
                if !(last_was_word && before.trim().is_empty()) {
                    out.push_str(before);
                }
                out.push_str(&text);
                rest = after;
                last_was_word = true;
            }
            None => {
                out.push_str(&rest[..start + 2]);
                rest = &rest[start + 2..];
                last_was_word = false;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Attachment types that run code when opened.
const RISKY: &[&str] = &[
    "exe", "scr", "com", "pif", "bat", "cmd", "cpl", "msi", "msp", "jar", "js", "jse", "vbs",
    "vbe", "wsf", "wsh", "ps1", "hta", "lnk", "reg", "scf", "iso", "img", "vhd", "vhdx", "docm",
    "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam",
];

pub fn risky_files(raw: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    parse(raw).walk(&mut |p| {
        let name = p.file_name();
        if let Some((_, ext)) = name.rsplit_once('.') {
            if RISKY.contains(&ext.to_ascii_lowercase().as_str()) {
                out.push(name);
            }
        }
    });
    out
}

/// Whether the header marks a newsletter or marketing send.
pub fn bulk(header: &[Field]) -> bool {
    has(header, "List-Unsubscribe")
        || matches!(
            get(header, "Precedence")
                .trim()
                .to_ascii_lowercase()
                .as_str(),
            "bulk" | "list" | "junk"
        )
}

/// One address of an address list.
#[derive(Clone, Debug, PartialEq)]
pub struct Address {
    pub name: String,
    pub email: String,
}

/// An address list such as a From or To value. Groups are flattened.
pub fn addresses(v: &str) -> Vec<Address> {
    let mut items = Vec::new();
    let mut cur = String::new();
    let (mut quoted, mut angle, mut comment) = (false, false, 0);
    let mut esc = false;
    for c in v.chars() {
        if esc {
            cur.push(c);
            esc = false;
            continue;
        }
        match c {
            '\\' if quoted => {
                esc = true;
                cur.push(c);
            }
            '"' if comment == 0 => {
                quoted = !quoted;
                cur.push(c);
            }
            '(' if !quoted => comment += 1,
            ')' if !quoted && comment > 0 => comment -= 1,
            _ if comment > 0 => {}
            '<' if !quoted => {
                angle = true;
                cur.push(c);
            }
            '>' if !quoted => {
                angle = false;
                cur.push(c);
            }
            ',' | ';' if !quoted && !angle => items.push(std::mem::take(&mut cur)),
            ':' if !quoted && !angle => cur.clear(),
            _ => cur.push(c),
        }
    }
    items.push(cur);
    items
        .into_iter()
        .filter_map(|item| {
            let item = item.trim();
            if item.is_empty() {
                return None;
            }
            let (name, email) = match (item.rfind('<'), item.rfind('>')) {
                (Some(a), Some(b)) if a < b => (item[..a].trim(), item[a + 1..b].trim()),
                _ => ("", item),
            };
            if !email.contains('@') {
                return None;
            }
            let name = name.trim_matches('"').replace("\\\"", "\"");
            Some(Address {
                name: decode_header(name.trim()),
                email: email.to_owned(),
            })
        })
        .collect()
}

// ---- dates ----

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];

/// Year, month (1-12) and day of a count of days since 1970-01-01.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Midnight UTC of a day given as `2-Jan-2006`.
pub fn parse_day(v: &str) -> Option<i64> {
    let mut it = v.split('-');
    let d: u32 = it.next()?.parse().ok()?;
    let month = it.next()?;
    let m = MONTHS.iter().position(|n| n.eq_ignore_ascii_case(month))? as u32 + 1;
    let y: i64 = it.next()?.parse().ok()?;
    Some(days_from_civil(y, m, d) * 86_400)
}

fn parts_of(ts: i64) -> (i64, u32, u32, i64, i64, i64, usize) {
    let days = ts.div_euclid(86_400);
    let secs = ts.rem_euclid(86_400);
    let (y, m, d) = civil(days);
    (
        y,
        m,
        d,
        secs / 3600,
        secs % 3600 / 60,
        secs % 60,
        days.rem_euclid(7) as usize,
    )
}

/// IMAP's date-time, such as ` 2-Jan-2006 15:04:05 +0000`.
pub fn imap_date(ts: i64) -> String {
    let (y, m, d, h, mi, s, _) = parts_of(ts);
    format!(
        "{d:>2}-{}-{y} {h:02}:{mi:02}:{s:02} +0000",
        MONTHS[(m - 1) as usize]
    )
}

/// RFC 5322's date, such as `Mon, 2 Jan 2006 15:04:05 +0000`.
pub fn rfc_date(ts: i64) -> String {
    let (y, m, d, h, mi, s, wd) = parts_of(ts);
    format!(
        "{}, {d} {} {y} {h:02}:{mi:02}:{s:02} +0000",
        DAYS[wd],
        MONTHS[(m - 1) as usize]
    )
}

/// A Date header or an IMAP date-time, as seconds since 1970.
pub fn parse_date(v: &str) -> Option<i64> {
    let v = v.split('(').next().unwrap_or(v);
    let words: Vec<&str> = v
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|w| !w.is_empty())
        .collect();
    let mut i = 0;
    if words.first()?.chars().all(|c| c.is_ascii_alphabetic()) {
        i = 1;
    }
    let (d, m, y) = if words.get(i)?.contains('-') {
        let mut it = words[i].split('-');
        let r = (it.next()?, it.next()?, it.next()?);
        i += 1;
        r
    } else {
        let r = (*words.get(i)?, *words.get(i + 1)?, *words.get(i + 2)?);
        i += 3;
        r
    };
    let d: u32 = d.parse().ok()?;
    let m = MONTHS.iter().position(|n| n.eq_ignore_ascii_case(m))? as u32 + 1;
    let mut y: i64 = y.parse().ok()?;
    if y < 100 {
        y += if y < 50 { 2000 } else { 1900 };
    }
    let mut t = words.get(i).copied().unwrap_or("0:0:0").split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let mi: i64 = t.next().unwrap_or("0").parse().ok()?;
    let s: i64 = t.next().unwrap_or("0").parse().unwrap_or(0);
    let zone = words.get(i + 1).copied().unwrap_or("+0000");
    let offset = match zone.as_bytes().first() {
        Some(b'+' | b'-') if zone.len() == 5 => {
            let n: i64 = zone[1..].parse().ok()?;
            let o = (n / 100) * 3600 + (n % 100) * 60;
            if zone.starts_with('-') {
                -o
            } else {
                o
            }
        }
        _ => 0,
    };
    Some(days_from_civil(y, m, d) * 86_400 + h * 3600 + mi * 60 + s - offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_round_trip() {
        let ts = 1_136_214_245; // 2006-01-02 15:04:05 UTC
        assert_eq!(imap_date(ts), " 2-Jan-2006 15:04:05 +0000");
        assert_eq!(rfc_date(ts), "Mon, 2 Jan 2006 15:04:05 +0000");
        assert_eq!(parse_date(&rfc_date(ts)), Some(ts));
        assert_eq!(parse_date(" 2-Jan-2006 15:04:05 +0000"), Some(ts));
        assert_eq!(parse_date("Mon, 2 Jan 2006 08:04:05 -0700"), Some(ts));
        assert_eq!(parse_day("2-Jan-2006"), Some(ts - 15 * 3600 - 4 * 60 - 5));
    }

    #[test]
    fn multipart_parts_are_found() {
        let raw = normalize_crlf(
            b"From: a@example.com\nContent-Type: multipart/mixed; boundary=\"b\"\n\npre\n--b\nContent-Type: text/plain\n\nhello\n--b\nContent-Type: application/octet-stream; name=\"run.exe\"\nContent-Transfer-Encoding: base64\n\naGk=\n--b--\n",
        );
        let p = parse(&raw);
        assert_eq!(p.children.len(), 2);
        assert_eq!(&raw[p.children[0].body.clone()], b"hello");
        assert_eq!(p.children[1].decoded(&raw), b"hi");
        assert_eq!(risky_files(&raw), ["run.exe"]);
    }

    #[test]
    fn headers_and_addresses_decode() {
        assert_eq!(
            decode_header("=?utf-8?q?caf=C3=A9?= =?utf-8?b?IQ==?="),
            "café!"
        );
        let list = addresses("\"Sam, Doe\" <sam@example.com>, lee@example.org");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "Sam, Doe");
        assert_eq!(list[1].email, "lee@example.org");
    }
}
