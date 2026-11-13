//! IMAP's grammar: arguments, sequence sets, FETCH items with ENVELOPE and
//! BODYSTRUCTURE, and SEARCH keys.

use super::message::{self, Field, Part};
use super::store::{self, Info};

// ---- arguments ----

#[derive(Clone, Debug)]
pub enum Token {
    Atom(String),
    Str(String),
    List(Vec<Token>),
}

impl Token {
    pub fn text(&self) -> &str {
        match self {
            Token::Atom(s) | Token::Str(s) => s,
            Token::List(_) => "",
        }
    }

    pub fn list(&self) -> Option<&[Token]> {
        match self {
            Token::List(l) => Some(l),
            _ => None,
        }
    }
}

pub const SYNTAX: &str = "syntax error";

/// Everything after the command name, literals already read into it.
pub fn parse_args(b: &[u8]) -> Result<Vec<Token>, &'static str> {
    let mut i = 0;
    let toks = until(b, &mut i, false)?;
    Ok(toks)
}

fn until(b: &[u8], i: &mut usize, close: bool) -> Result<Vec<Token>, &'static str> {
    let mut toks = Vec::new();
    loop {
        while *i < b.len() && b[*i] == b' ' {
            *i += 1;
        }
        if *i >= b.len() {
            return if close { Err(SYNTAX) } else { Ok(toks) };
        }
        match b[*i] {
            b')' => {
                if !close {
                    return Err(SYNTAX);
                }
                *i += 1;
                return Ok(toks);
            }
            b'(' => {
                *i += 1;
                toks.push(Token::List(until(b, i, true)?));
            }
            b'"' => {
                *i += 1;
                let mut s = Vec::new();
                loop {
                    let c = *b.get(*i).ok_or(SYNTAX)?;
                    *i += 1;
                    match c {
                        b'"' => break,
                        b'\\' => {
                            s.push(*b.get(*i).ok_or(SYNTAX)?);
                            *i += 1;
                        }
                        b'\r' | b'\n' => return Err(SYNTAX),
                        c => s.push(c),
                    }
                }
                toks.push(Token::Str(String::from_utf8_lossy(&s).into_owned()));
            }
            b'{' | b'~' if b[*i] == b'{' || b.get(*i + 1) == Some(&b'{') => {
                if b[*i] == b'~' {
                    *i += 1;
                }
                let close_at = b[*i..].iter().position(|&c| c == b'}').ok_or(SYNTAX)? + *i;
                let spec = std::str::from_utf8(&b[*i + 1..close_at]).map_err(|_| SYNTAX)?;
                let n: usize = spec.trim_end_matches('+').parse().map_err(|_| SYNTAX)?;
                *i = close_at + 1;
                if b.get(*i..*i + 2) != Some(b"\r\n") {
                    return Err(SYNTAX);
                }
                *i += 2;
                let data = b.get(*i..*i + n).ok_or(SYNTAX)?;
                *i += n;
                toks.push(Token::Str(String::from_utf8_lossy(data).into_owned()));
            }
            _ => {
                // Brackets are kept whole with what is inside them, so
                // BODY.PEEK[HEADER.FIELDS (FROM TO)]<0.100> is one atom.
                let start = *i;
                let mut depth = 0;
                while *i < b.len() {
                    let c = b[*i];
                    if depth == 0 && matches!(c, b' ' | b'(' | b')' | b'"' | b'{') {
                        break;
                    }
                    if c == b'[' {
                        depth += 1;
                    } else if c == b']' && depth > 0 {
                        depth -= 1;
                    }
                    *i += 1;
                }
                toks.push(Token::Atom(
                    String::from_utf8_lossy(&b[start..*i]).into_owned(),
                ));
            }
        }
    }
}

/// A literal announced at the end of a line: its size, and whether it is
/// one the client sends without waiting.
pub fn literal_suffix(line: &[u8]) -> Option<(usize, bool)> {
    let body = line.strip_suffix(b"}")?;
    let open = body.iter().rposition(|&c| c == b'{')?;
    let spec = std::str::from_utf8(&body[open + 1..]).ok()?;
    let (spec, sync_free) = match spec.strip_suffix('+') {
        Some(s) => (s, true),
        None => (spec, false),
    };
    Some((spec.parse().ok()?, sync_free))
}

// ---- writing ----

pub fn quote(s: &str) -> String {
    if s.len() > 1024
        || s.bytes()
            .any(|c| c == b'\r' || c == b'\n' || c == 0 || c >= 0x80)
    {
        return format!("{{{}}}\r\n{s}", s.len());
    }
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn nstring(s: &str) -> String {
    if s.is_empty() {
        "NIL".into()
    } else {
        quote(s)
    }
}

/// UTF-8 as an RFC 2047 word, for clients that expect ASCII.
fn encoded_word(s: &str) -> String {
    if s.is_ascii() {
        return s.to_owned();
    }
    use base64::Engine;
    format!(
        "=?utf-8?b?{}?=",
        base64::engine::general_purpose::STANDARD.encode(s)
    )
}

// ---- sequence sets ----

/// Ranges, 0 standing for `*`.
pub struct SeqSet(Vec<(u32, u32)>);

fn seq_num(s: &str) -> Option<u32> {
    if s == "*" {
        return Some(0);
    }
    s.parse().ok().filter(|n| *n > 0)
}

pub fn seq_set(s: &str) -> Option<SeqSet> {
    if s.is_empty() {
        return None;
    }
    s.split(',')
        .map(|part| match part.split_once(':') {
            Some((a, b)) => Some((seq_num(a)?, seq_num(b)?)),
            None => {
                let n = seq_num(part)?;
                Some((n, n))
            }
        })
        .collect::<Option<Vec<_>>>()
        .map(SeqSet)
}

impl SeqSet {
    pub fn contains(&self, n: u32, max: u32) -> bool {
        self.0.iter().any(|&(lo, hi)| {
            let lo = if lo == 0 { max } else { lo };
            let hi = if hi == 0 { max } else { hi };
            let (lo, hi) = if lo > hi { (hi, lo) } else { (lo, hi) };
            n >= lo && n <= hi
        })
    }
}

pub fn is_seq_set(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_digit() || matches!(c, ':' | ',' | '*'))
}

pub fn uid_list(uids: &[u32]) -> String {
    uids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

/// LIST wildcards: `*` matches anything, `%` anything but the delimiter.
pub fn pattern(p: &[u8], name: &[u8]) -> bool {
    match p.first() {
        None => name.is_empty(),
        Some(b'*') => (0..=name.len()).any(|i| pattern(&p[1..], &name[i..])),
        Some(b'%') => {
            for i in 0..=name.len() {
                if pattern(&p[1..], &name[i..]) {
                    return true;
                }
                if i < name.len() && name[i] == b'/' {
                    return false;
                }
            }
            false
        }
        Some(&c) => name.first() == Some(&c) && pattern(&p[1..], &name[1..]),
    }
}

// ---- FETCH ----

#[derive(Clone)]
pub enum Item {
    Uid,
    Flags,
    InternalDate,
    Size,
    Envelope,
    BodyStructure,
    Body,
    Section(Section),
}

#[derive(Clone)]
pub struct Section {
    /// How the reply names it, such as `BODY[HEADER.FIELDS (FROM)]<0>`.
    pub label: String,
    pub peek: bool,
    pub path: Vec<usize>,
    /// "", HEADER, HEADER.FIELDS, HEADER.FIELDS.NOT, TEXT or MIME.
    pub spec: String,
    pub fields: Vec<String>,
    pub partial: Option<(usize, usize)>,
}

impl Item {
    pub fn needs_message(&self) -> bool {
        matches!(
            self,
            Item::Envelope | Item::BodyStructure | Item::Body | Item::Section(_)
        )
    }
}

pub fn fetch_items(t: &Token) -> Result<Vec<Item>, String> {
    let atoms: Vec<&str> = match t {
        Token::List(l) => l.iter().map(Token::text).collect(),
        other => vec![other.text()],
    };
    let mut items = Vec::new();
    for a in atoms {
        match a.to_ascii_uppercase().as_str() {
            "ALL" => items.extend([Item::Flags, Item::InternalDate, Item::Size, Item::Envelope]),
            "FAST" => items.extend([Item::Flags, Item::InternalDate, Item::Size]),
            "FULL" => items.extend([
                Item::Flags,
                Item::InternalDate,
                Item::Size,
                Item::Envelope,
                Item::Body,
            ]),
            "UID" => items.push(Item::Uid),
            "FLAGS" => items.push(Item::Flags),
            "INTERNALDATE" => items.push(Item::InternalDate),
            "RFC822.SIZE" => items.push(Item::Size),
            "ENVELOPE" => items.push(Item::Envelope),
            "BODYSTRUCTURE" => items.push(Item::BodyStructure),
            "BODY" => items.push(Item::Body),
            "RFC822" => items.push(Item::Section(plain("RFC822", false, ""))),
            "RFC822.HEADER" => items.push(Item::Section(plain("RFC822.HEADER", true, "HEADER"))),
            "RFC822.TEXT" => items.push(Item::Section(plain("RFC822.TEXT", false, "TEXT"))),
            _ => items.push(Item::Section(section(a)?)),
        }
    }
    Ok(items)
}

fn plain(label: &str, peek: bool, spec: &str) -> Section {
    Section {
        label: label.into(),
        peek,
        path: Vec::new(),
        spec: spec.into(),
        fields: Vec::new(),
        partial: None,
    }
}

/// `BODY[...]<...>` and `BODY.PEEK[...]<...>`.
fn section(a: &str) -> Result<Section, String> {
    let upper = a.to_ascii_uppercase();
    let (peek, rest) = if upper.starts_with("BODY.PEEK[") {
        (true, &a[10..])
    } else if upper.starts_with("BODY[") {
        (false, &a[5..])
    } else {
        return Err(format!("unknown fetch attribute {a}"));
    };
    let end = rest.rfind(']').ok_or(SYNTAX)?;
    let (mut sec, after) = (&rest[..end], &rest[end + 1..]);
    let mut path = Vec::new();
    let mut spec_text = "";
    while !sec.is_empty() {
        let (num, tail) = sec.split_once('.').unwrap_or((sec, ""));
        match num.parse::<usize>() {
            Ok(0) => return Err(SYNTAX.into()),
            Ok(n) => {
                path.push(n);
                sec = tail;
            }
            Err(_) => {
                spec_text = sec;
                break;
            }
        }
    }
    let su = spec_text.trim().to_ascii_uppercase();
    let mut fields = Vec::new();
    let spec = if su.is_empty() || su == "HEADER" || su == "TEXT" {
        su
    } else if su == "MIME" {
        if path.is_empty() {
            return Err(SYNTAX.into());
        }
        su
    } else if su.starts_with("HEADER.FIELDS") {
        let not = su.starts_with("HEADER.FIELDS.NOT");
        let list = &spec_text[if not { 17 } else { 13 }..];
        let toks = parse_args(list.trim().as_bytes()).map_err(str::to_owned)?;
        let Some([Token::List(l)]) = Some(toks.as_slice()) else {
            return Err(SYNTAX.into());
        };
        fields = l.iter().map(|t| t.text().to_ascii_uppercase()).collect();
        if not {
            "HEADER.FIELDS.NOT"
        } else {
            "HEADER.FIELDS"
        }
        .to_owned()
    } else {
        return Err(format!("bad section {spec_text}"));
    };
    let partial = if after.is_empty() {
        None
    } else {
        let inner = after
            .strip_prefix('<')
            .and_then(|s| s.strip_suffix('>'))
            .ok_or(SYNTAX)?;
        let (o, c) = inner.split_once('.').ok_or(SYNTAX)?;
        let (o, c): (usize, usize) = (
            o.parse().map_err(|_| SYNTAX)?,
            c.parse().map_err(|_| SYNTAX)?,
        );
        if c == 0 {
            return Err(SYNTAX.into());
        }
        Some((o, c))
    };
    let mut label = String::from("BODY[");
    label.push_str(
        &path
            .iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join("."),
    );
    if !spec.is_empty() {
        if !path.is_empty() {
            label.push('.');
        }
        label.push_str(&spec);
        if spec.starts_with("HEADER.FIELDS") {
            label.push_str(" (");
            label.push_str(
                &fields
                    .iter()
                    .map(|f| quote(f))
                    .collect::<Vec<_>>()
                    .join(" "),
            );
            label.push(')');
        }
    }
    label.push(']');
    if let Some((o, _)) = partial {
        label.push_str(&format!("<{o}>"));
    }
    Ok(Section {
        label,
        peek,
        path,
        spec,
        fields,
        partial,
    })
}

fn child(p: &Part, n: usize) -> Option<&Part> {
    let p = p.embedded.as_deref().unwrap_or(p);
    if p.is_multipart() && !p.children.is_empty() {
        return p.children.get(n.checked_sub(1)?);
    }
    (n == 1).then_some(p)
}

/// The bytes a section asks for.
pub fn extract(root: &Part, raw: &[u8], s: &Section) -> Vec<u8> {
    let mut out = if s.path.is_empty() && s.spec.is_empty() {
        raw.to_vec()
    } else {
        let mut p = root;
        for &n in &s.path {
            match child(p, n) {
                Some(c) => p = c,
                None => return Vec::new(),
            }
        }
        let msg = if !s.path.is_empty()
            && matches!(
                s.spec.as_str(),
                "HEADER" | "TEXT" | "HEADER.FIELDS" | "HEADER.FIELDS.NOT"
            ) {
            match p.embedded.as_deref() {
                Some(e) => e,
                None => return Vec::new(),
            }
        } else {
            p
        };
        match s.spec.as_str() {
            "" => raw[p.body.clone()].to_vec(),
            "MIME" => raw[p.head.clone()].to_vec(),
            "HEADER" => raw[msg.head.clone()].to_vec(),
            "TEXT" => raw[msg.body.clone()].to_vec(),
            _ => {
                let want = s.spec == "HEADER.FIELDS";
                let mut b: Vec<u8> = msg
                    .header
                    .iter()
                    .filter(|f| s.fields.contains(&f.name.to_ascii_uppercase()) == want)
                    .flat_map(|f| f.raw.clone())
                    .collect();
                b.extend_from_slice(b"\r\n");
                b
            }
        }
    };
    if let Some((o, c)) = s.partial {
        if o >= out.len() {
            return Vec::new();
        }
        out.drain(..o);
        out.truncate(c);
    }
    out
}

pub fn envelope(h: &[Field]) -> String {
    let from = message::get(h, "From");
    let sender = Some(message::get(h, "Sender"))
        .filter(|s| !s.is_empty())
        .unwrap_or(from);
    let reply = Some(message::get(h, "Reply-To"))
        .filter(|s| !s.is_empty())
        .unwrap_or(from);
    let mut b = format!(
        "({} {}",
        nstring(message::get(h, "Date")),
        nstring(message::get(h, "Subject"))
    );
    for v in [
        from,
        sender,
        reply,
        message::get(h, "To"),
        message::get(h, "Cc"),
        message::get(h, "Bcc"),
    ] {
        b.push(' ');
        b.push_str(&address_list(v));
    }
    b.push_str(&format!(
        " {} {})",
        nstring(message::get(h, "In-Reply-To")),
        nstring(message::get(h, "Message-ID"))
    ));
    b
}

fn address_list(v: &str) -> String {
    let list = message::addresses(v);
    if list.is_empty() {
        return "NIL".into();
    }
    let mut b = String::from("(");
    for a in list {
        let (local, domain) = a.email.rsplit_once('@').unwrap_or((&a.email, ""));
        b.push_str(&format!(
            "({} NIL {} {})",
            nstring(&encoded_word(&a.name)),
            nstring(local),
            nstring(domain)
        ));
    }
    b.push(')');
    b
}

pub fn body_structure(p: &Part, raw: &[u8], ext: bool) -> String {
    if p.is_multipart() && !p.children.is_empty() {
        let mut b = String::from("(");
        for c in &p.children {
            b.push_str(&body_structure(c, raw, ext));
        }
        b.push(' ');
        b.push_str(&quote(&p.sub.to_ascii_uppercase()));
        if ext {
            b.push_str(&format!(
                " {} {} {} {}",
                params(&p.params),
                disposition(message::get(&p.header, "Content-Disposition")),
                nstring(message::get(&p.header, "Content-Language")),
                nstring(message::get(&p.header, "Content-Location"))
            ));
        }
        b.push(')');
        return b;
    }
    let ascii = [("charset".to_owned(), "us-ascii".to_owned())];
    let (kind, sub, ps): (&str, &str, &[(String, String)]) = if p.is_multipart() {
        ("text", "plain", &ascii)
    } else {
        (&p.kind, &p.sub, &p.params)
    };
    let mut enc = message::get(&p.header, "Content-Transfer-Encoding").to_ascii_uppercase();
    if enc.is_empty() {
        enc = "7BIT".into();
    }
    let body = &raw[p.body.clone()];
    let mut b = format!(
        "({} {} {} {} {} {} {}",
        quote(&kind.to_ascii_uppercase()),
        quote(&sub.to_ascii_uppercase()),
        params(ps),
        nstring(message::get(&p.header, "Content-ID")),
        nstring(message::get(&p.header, "Content-Description")),
        quote(&enc),
        body.len()
    );
    if kind == "text" {
        b.push_str(&format!(" {}", message::lines(body)));
    } else if kind == "message" && sub == "rfc822" {
        if let Some(e) = &p.embedded {
            b.push_str(&format!(
                " {} {} {}",
                envelope(&e.header),
                body_structure(e, raw, ext),
                message::lines(body)
            ));
        }
    }
    if ext {
        b.push_str(&format!(
            " {} {} {} {}",
            nstring(message::get(&p.header, "Content-MD5")),
            disposition(message::get(&p.header, "Content-Disposition")),
            nstring(message::get(&p.header, "Content-Language")),
            nstring(message::get(&p.header, "Content-Location"))
        ));
    }
    b.push(')');
    b
}

fn params(ps: &[(String, String)]) -> String {
    if ps.is_empty() {
        return "NIL".into();
    }
    let mut sorted: Vec<&(String, String)> = ps.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let inner: Vec<String> = sorted
        .iter()
        .map(|(k, v)| {
            format!(
                "{} {}",
                quote(&k.to_ascii_uppercase()),
                quote(&encoded_word(v))
            )
        })
        .collect();
    format!("({})", inner.join(" "))
}

fn disposition(v: &str) -> String {
    match message::parse_media_type(v) {
        Some((d, ps)) => format!("({} {})", quote(&d.to_ascii_uppercase()), params(&ps)),
        None => "NIL".into(),
    }
}

// ---- SEARCH ----

/// What a search key looks at.
pub struct Candidate<'a> {
    pub seq: u32,
    pub max_seq: u32,
    pub max_uid: u32,
    pub info: &'a Info,
    /// The message, when a key needs it.
    pub raw: &'a dyn Fn() -> Option<Vec<u8>>,
}

pub enum Key {
    All,
    Never,
    Flag(String, bool),
    Header(String, String),
    Text(String, bool),
    Date(&'static str, bool, i64),
    Larger(i64),
    Smaller(i64),
    Uid(SeqSet),
    Seq(SeqSet),
    Not(Box<Key>),
    Or(Box<Key>, Box<Key>),
    And(Vec<Key>),
}

pub fn search_keys(toks: &[Token]) -> Result<Key, String> {
    let mut i = 0;
    if toks
        .first()
        .is_some_and(|t| t.text().eq_ignore_ascii_case("CHARSET"))
    {
        i = 2;
    }
    let mut keys = Vec::new();
    while i < toks.len() {
        keys.push(key(toks, &mut i)?);
    }
    Ok(Key::And(keys))
}

fn key(toks: &[Token], i: &mut usize) -> Result<Key, String> {
    let t = toks.get(*i).ok_or(SYNTAX)?;
    *i += 1;
    if let Token::List(l) = t {
        return search_keys(l);
    }
    let mut arg = || -> Result<String, String> {
        let a = toks.get(*i).filter(|t| t.list().is_none()).ok_or(SYNTAX)?;
        *i += 1;
        Ok(a.text().to_owned())
    };
    let k = t.text().to_ascii_uppercase();
    Ok(match k.as_str() {
        "ALL" | "OLD" => Key::All,
        "NEW" | "RECENT" => Key::Never,
        "ANSWERED" => Key::Flag(store::ANSWERED.into(), true),
        "UNANSWERED" => Key::Flag(store::ANSWERED.into(), false),
        "DELETED" => Key::Flag(store::DELETED.into(), true),
        "UNDELETED" => Key::Flag(store::DELETED.into(), false),
        "DRAFT" => Key::Flag(store::DRAFT.into(), true),
        "UNDRAFT" => Key::Flag(store::DRAFT.into(), false),
        "FLAGGED" => Key::Flag(store::FLAGGED.into(), true),
        "UNFLAGGED" => Key::Flag(store::FLAGGED.into(), false),
        "SEEN" => Key::Flag(store::SEEN.into(), true),
        "UNSEEN" => Key::Flag(store::SEEN.into(), false),
        "KEYWORD" => Key::Flag(arg()?, true),
        "UNKEYWORD" => Key::Flag(arg()?, false),
        "FROM" | "TO" | "CC" | "BCC" | "SUBJECT" => Key::Header(k.clone(), arg()?.to_lowercase()),
        "HEADER" => {
            let name = arg()?;
            Key::Header(name, arg()?.to_lowercase())
        }
        "BODY" => Key::Text(arg()?.to_lowercase(), false),
        "TEXT" => Key::Text(arg()?.to_lowercase(), true),
        "BEFORE" | "ON" | "SINCE" | "SENTBEFORE" | "SENTON" | "SENTSINCE" => {
            let v = arg()?;
            let day = message::parse_day(&v).ok_or(format!("bad date {v}"))?;
            let sent = k.starts_with("SENT");
            let cmp = match k.trim_start_matches("SENT") {
                "BEFORE" => "before",
                "ON" => "on",
                _ => "since",
            };
            Key::Date(cmp, sent, day)
        }
        "LARGER" => Key::Larger(arg()?.parse().map_err(|_| SYNTAX)?),
        "SMALLER" => Key::Smaller(arg()?.parse().map_err(|_| SYNTAX)?),
        "UID" => Key::Uid(seq_set(&arg()?).ok_or(SYNTAX)?),
        "NOT" => Key::Not(Box::new(key(toks, i)?)),
        "OR" => {
            let a = key(toks, i)?;
            Key::Or(Box::new(a), Box::new(key(toks, i)?))
        }
        _ if is_seq_set(t.text()) => Key::Seq(seq_set(t.text()).ok_or(SYNTAX)?),
        _ => return Err(format!("unknown search key {}", t.text())),
    })
}

fn load(c: &Candidate, raw: &mut Option<Option<Vec<u8>>>) -> Option<Vec<u8>> {
    raw.get_or_insert_with(|| (c.raw)()).clone()
}

impl Key {
    /// Whether the candidate matches; `part` caches the parsed message.
    pub fn test(&self, c: &Candidate, raw: &mut Option<Option<Vec<u8>>>) -> bool {
        let mut message = || load(c, raw);
        match self {
            Key::All => true,
            Key::Never => false,
            Key::Flag(f, want) => c.info.has(f) == *want,
            Key::Header(name, needle) => message().is_some_and(|m| {
                let (head, _) = message::split_header(&m);
                message::parse_header(head).iter().any(|f| {
                    f.name.eq_ignore_ascii_case(name)
                        && (needle.is_empty()
                            || message::decode_header(&f.value)
                                .to_lowercase()
                                .contains(needle.as_str()))
                })
            }),
            Key::Text(needle, with_header) => message().is_some_and(|m| {
                let p = message::parse(&m);
                if *with_header
                    && message::decode_header(&String::from_utf8_lossy(&m[p.head.clone()]))
                        .to_lowercase()
                        .contains(needle.as_str())
                {
                    return true;
                }
                let mut found = false;
                p.walk(&mut |q| {
                    if !found && q.kind == "text" {
                        found = String::from_utf8_lossy(&q.decoded(&m))
                            .to_lowercase()
                            .contains(needle.as_str());
                    }
                });
                found
            }),
            Key::Date(cmp, sent, day) => {
                let t = if *sent {
                    match message().and_then(|m| {
                        let (head, _) = message::split_header(&m);
                        message::parse_date(message::get(&message::parse_header(head), "Date"))
                    }) {
                        Some(t) => t,
                        None => return false,
                    }
                } else {
                    c.info.date
                };
                let d = t.div_euclid(86_400) * 86_400;
                match *cmp {
                    "before" => d < *day,
                    "on" => d == *day,
                    _ => d >= *day,
                }
            }
            Key::Larger(n) => c.info.size > *n,
            Key::Smaller(n) => c.info.size < *n,
            Key::Uid(s) => s.contains(c.info.uid, c.max_uid),
            Key::Seq(s) => s.contains(c.seq, c.max_seq),
            Key::Not(k) => !k.test(c, raw),
            Key::Or(a, b) => a.test(c, raw) || b.test(c, raw),
            Key::And(ks) => ks.iter().all(|k| k.test(c, raw)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_keep_sections_and_literals_whole() {
        let toks = parse_args(
            b"1:* (UID BODY.PEEK[HEADER.FIELDS (FROM TO)]<0.10>) {5}\r\nhello \"a \\\"b\\\"\"",
        )
        .unwrap();
        assert_eq!(toks[0].text(), "1:*");
        let items = toks[1].list().unwrap();
        assert_eq!(items[1].text(), "BODY.PEEK[HEADER.FIELDS (FROM TO)]<0.10>");
        assert_eq!(toks[2].text(), "hello");
        assert_eq!(toks[3].text(), "a \"b\"");
        assert_eq!(literal_suffix(b"A1 APPEND INBOX {42+}"), Some((42, true)));
    }

    #[test]
    fn sequence_sets_and_patterns() {
        let set = seq_set("1,3:5,9:*").unwrap();
        assert!(set.contains(4, 20) && set.contains(20, 20) && !set.contains(2, 20));
        assert!(pattern(b"*", b"Sent/2024"));
        assert!(pattern(b"%", b"Sent") && !pattern(b"%", b"Sent/2024"));
        assert!(pattern(b"Sent/%", b"Sent/2024"));
    }

    #[test]
    fn sections_name_and_cut_what_was_asked() {
        let items = fetch_items(&Token::Atom("BODY.PEEK[HEADER.FIELDS (From To)]".into())).unwrap();
        let Item::Section(s) = &items[0] else {
            panic!("not a section")
        };
        assert!(s.peek);
        assert_eq!(s.label, "BODY[HEADER.FIELDS (\"FROM\" \"TO\")]");
        let raw = b"From: sam@example.com\r\nTo: lee@example.com\r\nSubject: hi\r\n\r\nbody\r\n";
        let p = message::parse(raw);
        assert_eq!(
            extract(&p, raw, s),
            b"From: sam@example.com\r\nTo: lee@example.com\r\n\r\n"
        );
        let items = fetch_items(&Token::Atom("BODY[TEXT]<1.2>".into())).unwrap();
        let Item::Section(text) = &items[0] else {
            panic!("not a section")
        };
        assert_eq!(extract(&p, raw, text), b"od");
        assert_eq!(
            body_structure(&p, raw, false),
            "(\"TEXT\" \"PLAIN\" (\"CHARSET\" \"us-ascii\") NIL NIL \"7BIT\" 6 1)"
        );
    }

    #[test]
    fn search_keys_combine() {
        let toks = parse_args(b"OR SEEN FLAGGED NOT DELETED").unwrap();
        let key = search_keys(&toks).unwrap();
        let info = Info {
            uid: 1,
            flags: vec![store::SEEN.into()],
            date: 0,
            size: 10,
        };
        let none = || None;
        let c = Candidate {
            seq: 1,
            max_seq: 1,
            max_uid: 1,
            info: &info,
            raw: &none,
        };
        assert!(key.test(&c, &mut None));
    }
}
