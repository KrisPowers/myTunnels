//! An IMAP4rev1 server (RFC 3501) with what Outlook, Apple Mail and the
//! Gmail app lean on: IDLE, UIDPLUS, MOVE, SPECIAL-USE, LITERAL+, SASL-IR,
//! NAMESPACE, UNSELECT, ID and ENABLE.

use std::collections::HashMap;
use std::io;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf};
use tokio::sync::watch;

use super::fetch::{self, quote, Candidate, Item, Token};
use super::message;
use super::net::{self, Conn};
use super::store::{self, FlagOp, Info, NO_MAILBOX};
use super::{Mail, MAX_MESSAGE};

/// What is offered. Outlook's cloud sync stalls when offered more.
const CAPS: &str = "IMAP4rev1 ID UIDPLUS NAMESPACE LITERAL+ AUTH=PLAIN";
const MAX_LINE: usize = 64 << 10;
/// The most a literal may be before signing in.
const PRE_AUTH_LITERAL: usize = 8 << 10;
const IDLE_WAIT: Duration = Duration::from_secs(30 * 60);

type Reader = BufReader<ReadHalf<Conn>>;

struct Session {
    mail: Arc<Mail>,
    ip: IpAddr,
    w: WriteHalf<Conn>,
    out: Vec<u8>,
    user: String,
    watch: Option<watch::Receiver<u64>>,
    /// The selected mailbox: its name, read-only, the UIDs by sequence
    /// number as this session knows them, and the flags last sent.
    selected: Option<String>,
    read_only: bool,
    uids: Vec<u32>,
    flags: HashMap<u32, String>,
}

enum Res {
    Ok(String),
    No(String),
    Bad(String),
}

fn ok(s: impl Into<String>) -> Res {
    Res::Ok(s.into())
}
fn no(s: impl Into<String>) -> Res {
    Res::No(s.into())
}
fn bad(s: impl Into<String>) -> Res {
    Res::Bad(s.into())
}

fn flag_text(flags: &[String]) -> String {
    flags.join(" ")
}

pub async fn serve(mail: Arc<Mail>, conn: Conn, ip: IpAddr) -> io::Result<()> {
    let (r, w) = tokio::io::split(conn);
    let mut r = BufReader::new(r);
    let mut s = Session {
        mail,
        ip,
        w,
        out: Vec::new(),
        user: String::new(),
        watch: None,
        selected: None,
        read_only: false,
        uids: Vec::new(),
        flags: HashMap::new(),
    };
    let host = s.mail.settings().hostname();
    s.put(&format!(
        "* OK [CAPABILITY {CAPS}] {host} IMAP4rev1 ready\r\n"
    ));
    s.flush().await?;
    loop {
        let cmd = match tokio::time::timeout(IDLE_WAIT, s.read_command(&mut r)).await {
            Err(_) => {
                s.put("* BYE autologout\r\n");
                return s.flush().await;
            }
            Ok(Err(e)) if e.kind() == io::ErrorKind::InvalidData => {
                s.put(&format!("* BYE {e}\r\n"));
                return s.flush().await;
            }
            Ok(Err(e)) => return Err(e),
            Ok(Ok(None)) => return Ok(()),
            Ok(Ok(Some(c))) => c,
        };
        let (tag, rest) = split_at_space(&cmd);
        if tag.is_empty() || tag.iter().any(|c| b"(){%*\"\\]+".contains(c)) {
            s.put("* BAD invalid tag\r\n");
            s.flush().await?;
            continue;
        }
        let tag = String::from_utf8_lossy(tag).into_owned();
        let (name, args) = split_at_space(rest);
        let name = String::from_utf8_lossy(name).to_ascii_uppercase();
        let done = s.dispatch(&mut r, &tag, &name, args).await?;
        s.flush().await?;
        if done {
            return Ok(());
        }
    }
}

fn split_at_space(b: &[u8]) -> (&[u8], &[u8]) {
    match b.iter().position(|&c| c == b' ') {
        Some(i) => (&b[..i], &b[i + 1..]),
        None => (b, &[]),
    }
}

impl Session {
    fn put(&mut self, s: &str) {
        self.out.extend_from_slice(s.as_bytes());
    }

    async fn flush(&mut self) -> io::Result<()> {
        if !self.out.is_empty() {
            let out = std::mem::take(&mut self.out);
            self.w.write_all(&out).await?;
        }
        self.w.flush().await
    }

    /// One whole command, the literals in it read too.
    async fn read_command(&mut self, r: &mut Reader) -> io::Result<Option<Vec<u8>>> {
        let limit = if self.user.is_empty() {
            PRE_AUTH_LITERAL
        } else {
            MAX_MESSAGE + (64 << 10)
        };
        let mut buf = Vec::new();
        let mut total = 0usize;
        loop {
            let Some(line) = net::read_line(r, MAX_LINE).await? else {
                return Ok(None);
            };
            buf.extend_from_slice(&line);
            let Some((n, sync_free)) = fetch::literal_suffix(&line) else {
                return Ok(Some(buf));
            };
            if n > limit.saturating_sub(total) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "literal too large",
                ));
            }
            total += n;
            if !sync_free {
                self.put("+ Ready for literal data\r\n");
                self.flush().await?;
            }
            buf.extend_from_slice(b"\r\n");
            let mut data = vec![0u8; n];
            r.read_exact(&mut data).await?;
            buf.extend_from_slice(&data);
        }
    }

    async fn dispatch(
        &mut self,
        r: &mut Reader,
        tag: &str,
        cmd: &str,
        args: &[u8],
    ) -> io::Result<bool> {
        if cmd == "IDLE" {
            if self.user.is_empty() {
                self.put(&format!("{tag} BAD not authenticated\r\n"));
                return Ok(false);
            }
            return self.idle(r, tag).await;
        }
        let mut args = match fetch::parse_args(args) {
            Ok(a) => a,
            Err(e) => {
                self.put(&format!("{tag} BAD {e}\r\n"));
                return Ok(false);
            }
        };
        let mut cmd = cmd.to_owned();
        let mut uid = false;
        if cmd == "UID" {
            let Some(Token::Atom(sub)) = args.first().cloned() else {
                self.put(&format!("{tag} BAD missing UID command\r\n"));
                return Ok(false);
            };
            cmd = sub.to_ascii_uppercase();
            args.remove(0);
            if !matches!(
                cmd.as_str(),
                "FETCH" | "STORE" | "COPY" | "MOVE" | "SEARCH" | "EXPUNGE"
            ) {
                self.put(&format!("{tag} BAD unknown UID command\r\n"));
                return Ok(false);
            }
            uid = true;
        }
        let res = match cmd.as_str() {
            "CAPABILITY" => {
                self.put(&format!("* CAPABILITY {CAPS}\r\n"));
                ok("CAPABILITY completed")
            }
            "NOOP" | "CHECK" => ok(format!("{cmd} completed")),
            "LOGOUT" => {
                self.put(&format!(
                    "* BYE logging out\r\n{tag} OK LOGOUT completed\r\n"
                ));
                return Ok(true);
            }
            "ID" => {
                self.put("* ID (\"name\" \"myTunnels\")\r\n");
                ok("ID completed")
            }
            "STARTTLS" => bad("TLS is already on"),
            "LOGIN" => match args.as_slice() {
                [u, p] => self.sign_in(u.text(), p.text()).await,
                _ => bad("LOGIN requires username and password"),
            },
            "AUTHENTICATE" => self.authenticate(r, &args).await?,
            _ if self.user.is_empty() => bad("not authenticated"),
            _ => self.authenticated(&cmd, &args, uid),
        };
        // EXPUNGE replies would shift the numbers a non-UID FETCH, STORE or
        // SEARCH is using.
        let expunges = uid || !matches!(cmd.as_str(), "FETCH" | "STORE" | "SEARCH");
        self.sync(expunges);
        let (status, text) = match res {
            Res::Ok(t) => ("OK", t),
            Res::No(t) => ("NO", t),
            Res::Bad(t) => ("BAD", t),
        };
        self.put(&format!("{tag} {status} {text}\r\n"));
        Ok(false)
    }

    async fn sign_in(&mut self, user: &str, pass: &str) -> Res {
        if !self.user.is_empty() {
            return bad("already authenticated");
        }
        match self.mail.sign_in(user, pass, self.ip).await {
            Ok(address) => {
                self.watch = Some(self.mail.store.watch(&address));
                self.user = address;
                ok(format!("[CAPABILITY {CAPS}] logged in"))
            }
            Err(Some(wait)) => no(format!("[UNAVAILABLE] {wait}")),
            Err(None) => no("[AUTHENTICATIONFAILED] invalid credentials"),
        }
    }

    async fn authenticate(&mut self, r: &mut Reader, args: &[Token]) -> io::Result<Res> {
        if !args
            .first()
            .is_some_and(|m| m.text().eq_ignore_ascii_case("PLAIN"))
        {
            return Ok(no("[CANNOT] only PLAIN is supported"));
        }
        let resp = match args.get(1) {
            Some(t) => t.text().to_owned(),
            None => {
                self.put("+ \r\n");
                self.flush().await?;
                match net::read_line(r, MAX_LINE).await? {
                    Some(l) => String::from_utf8_lossy(&l).into_owned(),
                    None => return Ok(bad("read error")),
                }
            }
        };
        if resp == "*" {
            return Ok(bad("authentication cancelled"));
        }
        let decoded = if resp == "=" {
            Vec::new()
        } else {
            match B64.decode(resp.trim()) {
                Ok(d) => d,
                Err(_) => return Ok(bad("invalid base64")),
            }
        };
        let text = String::from_utf8_lossy(&decoded).into_owned();
        let parts: Vec<&str> = text.split('\0').collect();
        if parts.len() != 3 || (!parts[0].is_empty() && !parts[0].eq_ignore_ascii_case(parts[1])) {
            return Ok(no("[AUTHENTICATIONFAILED] invalid credentials"));
        }
        Ok(self.sign_in(parts[1], parts[2]).await)
    }

    fn authenticated(&mut self, cmd: &str, args: &[Token], uid: bool) -> Res {
        let user = self.user.clone();
        let store = &self.mail.store;
        let arg = |i: usize| args.get(i).map_or("", Token::text);
        match cmd {
            "ENABLE" => {
                self.put("* ENABLED\r\n");
                return ok("ENABLE completed");
            }
            "NAMESPACE" => {
                self.put("* NAMESPACE ((\"\" \"/\")) NIL NIL\r\n");
                return ok("NAMESPACE completed");
            }
            "SELECT" | "EXAMINE" => {
                if args.is_empty() {
                    return bad("missing mailbox");
                }
                return self.select(arg(0).to_owned(), cmd == "EXAMINE");
            }
            "CREATE" => {
                return match store.create(&user, arg(0).trim_end_matches('/')) {
                    Ok(()) => ok("CREATE completed"),
                    Err(e) => no(e.to_string()),
                }
            }
            "DELETE" => {
                if self.selected.as_deref() == Some(arg(0)) {
                    self.deselect();
                }
                return match self.mail.store.delete(&user, arg(0)) {
                    Ok(()) => ok("DELETE completed"),
                    Err(e) => no(e.to_string()),
                };
            }
            "RENAME" => {
                return match store.rename(&user, arg(0), arg(1)) {
                    Ok(()) => ok("RENAME completed"),
                    Err(e) => no(e.to_string()),
                }
            }
            "SUBSCRIBE" | "UNSUBSCRIBE" => {
                return match store.subscribe(&user, arg(0), cmd == "SUBSCRIBE") {
                    Ok(()) => ok(format!("{cmd} completed")),
                    Err(e) => no(e.to_string()),
                }
            }
            "LIST" | "LSUB" => return self.list(args, cmd == "LSUB"),
            "STATUS" => return self.status(args),
            "APPEND" => return self.append(args),
            _ => {}
        }
        let Some(mailbox) = self.selected.clone() else {
            return match cmd {
                "CLOSE" | "UNSELECT" | "EXPUNGE" | "SEARCH" | "FETCH" | "STORE" | "COPY"
                | "MOVE" => bad("no mailbox selected"),
                _ => bad("unknown command"),
            };
        };
        match cmd {
            "CLOSE" => {
                if !self.read_only {
                    let _ = self.mail.store.expunge(&user, &mailbox, None);
                }
                self.deselect();
                ok("CLOSE completed")
            }
            "UNSELECT" => {
                self.deselect();
                ok("UNSELECT completed")
            }
            "EXPUNGE" => self.expunge(&mailbox, args, uid),
            "SEARCH" => self.search(&mailbox, args, uid),
            "FETCH" => self.fetch(&mailbox, args, uid),
            "STORE" => self.store(&mailbox, args, uid),
            "COPY" | "MOVE" => self.copy(&mailbox, args, uid, cmd == "MOVE"),
            _ => bad("unknown command"),
        }
    }

    fn deselect(&mut self) {
        self.selected = None;
        self.read_only = false;
        self.uids.clear();
        self.flags.clear();
    }

    fn select(&mut self, name: String, read_only: bool) -> Res {
        self.deselect();
        let snap = match self.mail.store.snapshot(&self.user, &name) {
            Ok(s) => s,
            Err(e) => return no(e.to_string()),
        };
        let mut first_unseen = 0;
        for (i, m) in snap.messages.iter().enumerate() {
            self.uids.push(m.uid);
            self.flags.insert(m.uid, flag_text(&m.flags));
            if first_unseen == 0 && !m.has(store::SEEN) {
                first_unseen = i + 1;
            }
        }
        self.put(&format!(
            "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft {} {})\r\n",
            store::RISKY,
            store::MARKETING
        ));
        self.put("* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] flags permitted\r\n");
        self.put(&format!("* {} EXISTS\r\n* 0 RECENT\r\n", self.uids.len()));
        if first_unseen > 0 {
            self.put(&format!("* OK [UNSEEN {first_unseen}] first unseen\r\n"));
        }
        self.put(&format!(
            "* OK [UIDVALIDITY {}] UIDs valid\r\n",
            snap.uid_validity
        ));
        self.put(&format!(
            "* OK [UIDNEXT {}] predicted next UID\r\n",
            snap.uid_next
        ));
        self.selected = Some(snap.name);
        self.read_only = read_only;
        if read_only {
            ok("[READ-ONLY] EXAMINE completed")
        } else {
            ok("[READ-WRITE] SELECT completed")
        }
    }

    /// Tells the client what changed in the selected mailbox since it last
    /// looked: messages gone, new ones and new flags.
    fn sync(&mut self, expunges: bool) {
        let Some(name) = self.selected.clone() else {
            return;
        };
        let Ok(snap) = self.mail.store.snapshot(&self.user, &name) else {
            return;
        };
        let current: HashMap<u32, &Info> = snap.messages.iter().map(|m| (m.uid, m)).collect();
        if expunges {
            for i in (0..self.uids.len()).rev() {
                if !current.contains_key(&self.uids[i]) {
                    self.out
                        .extend_from_slice(format!("* {} EXPUNGE\r\n", i + 1).as_bytes());
                    self.flags.remove(&self.uids[i]);
                    self.uids.remove(i);
                }
            }
        }
        let last = self.uids.last().copied().unwrap_or(0);
        let mut added = false;
        for m in snap.messages.iter().filter(|m| m.uid > last) {
            self.uids.push(m.uid);
            self.flags.insert(m.uid, flag_text(&m.flags));
            added = true;
        }
        if added {
            self.out
                .extend_from_slice(format!("* {} EXISTS\r\n", self.uids.len()).as_bytes());
        }
        for (i, u) in self.uids.iter().enumerate() {
            let Some(m) = current.get(u) else { continue };
            let f = flag_text(&m.flags);
            if self.flags.get(u) != Some(&f) {
                self.out.extend_from_slice(
                    format!("* {} FETCH (UID {u} FLAGS ({f}))\r\n", i + 1).as_bytes(),
                );
                self.flags.insert(*u, f);
            }
        }
    }

    /// The positions in `uids` a set picks.
    fn pick(&self, set: &fetch::SeqSet, uid: bool) -> Vec<usize> {
        let max_uid = self.uids.last().copied().unwrap_or(0);
        let max_seq = self.uids.len() as u32;
        (0..self.uids.len())
            .filter(|&i| {
                if uid {
                    set.contains(self.uids[i], max_uid)
                } else {
                    set.contains(i as u32 + 1, max_seq)
                }
            })
            .collect()
    }

    fn picked_uids(&self, t: Option<&Token>, uid: bool) -> Option<Vec<u32>> {
        let set = fetch::seq_set(t?.text())?;
        Some(
            self.pick(&set, uid)
                .into_iter()
                .map(|i| self.uids[i])
                .collect(),
        )
    }

    fn list(&mut self, args: &[Token], lsub: bool) -> Res {
        let mut args = args;
        let (mut only_subscribed, mut only_special, mut say_subscribed) = (lsub, false, false);
        if let Some(Token::List(opts)) = args.first() {
            for o in opts {
                match o.text().to_ascii_uppercase().as_str() {
                    "SUBSCRIBED" => {
                        only_subscribed = true;
                        say_subscribed = true;
                    }
                    "SPECIAL-USE" => only_special = true,
                    _ => {}
                }
            }
            args = &args[1..];
        }
        if args.len() < 2 {
            return bad("LIST requires reference and pattern");
        }
        let reference = args[0].text();
        let patterns: Vec<String> = match &args[1] {
            Token::List(l) => l.iter().map(|t| t.text().to_owned()).collect(),
            t => vec![t.text().to_owned()],
        };
        if let (Some(r), Some(Token::List(opts))) = (args.get(2), args.get(3)) {
            if r.text().eq_ignore_ascii_case("RETURN")
                && opts
                    .iter()
                    .any(|o| o.text().eq_ignore_ascii_case("SUBSCRIBED"))
            {
                say_subscribed = true;
            }
        }
        let resp = if lsub { "LSUB" } else { "LIST" };
        if patterns.len() == 1 && patterns[0].is_empty() {
            self.put(&format!("* {resp} (\\Noselect) \"/\" \"\"\r\n"));
            return ok(format!("{resp} completed"));
        }
        let boxes = match self.mail.store.list(&self.user) {
            Ok(b) => b,
            Err(e) => return no(e.to_string()),
        };
        for b in &boxes {
            let matched = patterns.iter().any(|p| {
                let mut full = format!("{reference}{p}");
                if b.name == "INBOX" && full.len() >= 5 && full[..5].eq_ignore_ascii_case("INBOX") {
                    full = format!("INBOX{}", &full[5..]);
                }
                fetch::pattern(full.as_bytes(), b.name.as_bytes())
            });
            if !matched
                || (only_subscribed && !b.subscribed)
                || (only_special && b.special.is_empty())
            {
                continue;
            }
            let children = boxes
                .iter()
                .any(|o| o.name.starts_with(&format!("{}/", b.name)));
            let mut attrs = vec![if children {
                "\\HasChildren"
            } else {
                "\\HasNoChildren"
            }
            .to_owned()];
            if !b.special.is_empty() {
                attrs.push(b.special.clone());
            }
            if say_subscribed && b.subscribed {
                attrs.push("\\Subscribed".into());
            }
            self.put(&format!(
                "* {resp} ({}) \"/\" {}\r\n",
                attrs.join(" "),
                quote(&b.name)
            ));
        }
        ok(format!("{resp} completed"))
    }

    fn status(&mut self, args: &[Token]) -> Res {
        let (Some(name), Some(Token::List(items))) = (args.first(), args.get(1)) else {
            return bad("STATUS requires mailbox and item list");
        };
        let st = match self.mail.store.status(&self.user, name.text()) {
            Ok(s) => s,
            Err(e) => return no(e.to_string()),
        };
        let mut out = Vec::new();
        for it in items {
            out.push(match it.text().to_ascii_uppercase().as_str() {
                "MESSAGES" => format!("MESSAGES {}", st.messages),
                "RECENT" => "RECENT 0".into(),
                "UIDNEXT" => format!("UIDNEXT {}", st.uid_next),
                "UIDVALIDITY" => format!("UIDVALIDITY {}", st.uid_validity),
                "UNSEEN" => format!("UNSEEN {}", st.unseen),
                "SIZE" => format!("SIZE {}", st.size),
                other => return bad(format!("unknown status item {other}")),
            });
        }
        self.put(&format!(
            "* STATUS {} ({})\r\n",
            quote(name.text()),
            out.join(" ")
        ));
        ok("STATUS completed")
    }

    fn append(&mut self, args: &[Token]) -> Res {
        if args.len() < 2 {
            return bad("APPEND requires mailbox and message");
        }
        let Some(Token::Str(msg)) = args.last() else {
            return bad("message must be a literal");
        };
        let mut flags = Vec::new();
        let mut date = 0;
        for a in &args[1..args.len() - 1] {
            match a {
                Token::List(l) => flags.extend(l.iter().map(|f| f.text().to_owned())),
                Token::Str(s) => match message::parse_date(s) {
                    Some(d) => date = d,
                    None => return bad("invalid date-time"),
                },
                Token::Atom(_) => {}
            }
        }
        if msg.len() > MAX_MESSAGE {
            return no("[TOOBIG] message too large");
        }
        let raw = message::normalize_crlf(msg.as_bytes());
        match self
            .mail
            .store
            .append(&self.user, args[0].text(), &raw, &flags, date)
        {
            Ok((uid, uv)) => ok(format!("[APPENDUID {uv} {uid}] APPEND completed")),
            Err(e) if e.to_string() == NO_MAILBOX => no("[TRYCREATE] no such mailbox"),
            Err(e) => no(e.to_string()),
        }
    }

    fn expunge(&mut self, mailbox: &str, args: &[Token], uid: bool) -> Res {
        if self.read_only {
            return no("[READ-ONLY] mailbox is read-only");
        }
        let only = if uid {
            match self.picked_uids(args.first(), true) {
                Some(u) if u.is_empty() => return ok("EXPUNGE completed"),
                Some(u) => Some(u),
                None => return bad("UID EXPUNGE requires a UID set"),
            }
        } else {
            None
        };
        match self
            .mail
            .store
            .expunge(&self.user, mailbox, only.as_deref())
        {
            Ok(_) => ok("EXPUNGE completed"),
            Err(e) => no(e.to_string()),
        }
    }

    fn search(&mut self, mailbox: &str, args: &[Token], uid: bool) -> Res {
        if args
            .first()
            .is_some_and(|a| a.text().eq_ignore_ascii_case("RETURN"))
        {
            return bad("ESEARCH not supported");
        }
        let key = match fetch::search_keys(args) {
            Ok(k) => k,
            Err(e) => return bad(e),
        };
        let snap = match self.mail.store.snapshot(&self.user, mailbox) {
            Ok(s) => s,
            Err(e) => return no(e.to_string()),
        };
        let infos: HashMap<u32, &Info> = snap.messages.iter().map(|m| (m.uid, m)).collect();
        let max_uid = self.uids.last().copied().unwrap_or(0);
        let mut hits = Vec::new();
        for (i, u) in self.uids.iter().enumerate() {
            let Some(info) = infos.get(u) else { continue };
            let load = || self.mail.store.read(&self.user, mailbox, *u).ok();
            let c = Candidate {
                seq: i as u32 + 1,
                max_seq: self.uids.len() as u32,
                max_uid,
                info,
                raw: &load,
            };
            if key.test(&c, &mut None) {
                hits.push(if uid {
                    u.to_string()
                } else {
                    (i + 1).to_string()
                });
            }
        }
        if hits.is_empty() {
            self.put("* SEARCH\r\n");
        } else {
            self.put(&format!("* SEARCH {}\r\n", hits.join(" ")));
        }
        ok("SEARCH completed")
    }

    fn fetch(&mut self, mailbox: &str, args: &[Token], uid: bool) -> Res {
        if args.len() < 2 {
            return bad("FETCH requires sequence set and items");
        }
        let Some(set) = fetch::seq_set(args[0].text()) else {
            return bad("invalid sequence set");
        };
        let mut items = match fetch::fetch_items(&args[1]) {
            Ok(i) => i,
            Err(e) => return bad(e),
        };
        let has_uid = items.iter().any(|i| matches!(i, Item::Uid));
        let has_flags = items.iter().any(|i| matches!(i, Item::Flags));
        let need_msg = items.iter().any(Item::needs_message);
        let marks_seen = items
            .iter()
            .any(|i| matches!(i, Item::Section(s) if !s.peek));
        if uid && !has_uid {
            items.insert(0, Item::Uid);
        }
        let picked = self.pick(&set, uid);
        let mut seen_now = Vec::new();
        if marks_seen && !self.read_only {
            if let Ok(snap) = self.mail.store.snapshot(&self.user, mailbox) {
                let unseen: Vec<u32> = snap
                    .messages
                    .iter()
                    .filter(|m| !m.has(store::SEEN))
                    .map(|m| m.uid)
                    .collect();
                seen_now = picked
                    .iter()
                    .map(|&i| self.uids[i])
                    .filter(|u| unseen.contains(u))
                    .collect();
                if !seen_now.is_empty() {
                    let _ = self.mail.store.set_flags(
                        &self.user,
                        mailbox,
                        &seen_now,
                        FlagOp::Add,
                        &[store::SEEN.to_owned()],
                    );
                }
            }
        }
        let snap = match self.mail.store.snapshot(&self.user, mailbox) {
            Ok(s) => s,
            Err(e) => return no(e.to_string()),
        };
        let infos: HashMap<u32, &Info> = snap.messages.iter().map(|m| (m.uid, m)).collect();
        for i in picked {
            let u = self.uids[i];
            let Some(info) = infos.get(&u) else { continue };
            let raw = if need_msg {
                match self.mail.store.read(&self.user, mailbox, u) {
                    Ok(r) => r,
                    Err(_) => continue,
                }
            } else {
                Vec::new()
            };
            let part = need_msg.then(|| message::parse(&raw));
            let mut b: Vec<u8> = format!("* {} FETCH (", i + 1).into_bytes();
            let mut first = true;
            let mut sep = |b: &mut Vec<u8>| {
                if !first {
                    b.push(b' ');
                }
                first = false;
            };
            let flags = flag_text(&info.flags);
            for it in &items {
                sep(&mut b);
                match it {
                    Item::Uid => b.extend_from_slice(format!("UID {u}").as_bytes()),
                    Item::Flags => b.extend_from_slice(format!("FLAGS ({flags})").as_bytes()),
                    Item::InternalDate => b.extend_from_slice(
                        format!("INTERNALDATE \"{}\"", message::imap_date(info.date)).as_bytes(),
                    ),
                    Item::Size => {
                        b.extend_from_slice(format!("RFC822.SIZE {}", info.size).as_bytes())
                    }
                    Item::Envelope => {
                        if let Some(p) = &part {
                            b.extend_from_slice(
                                format!("ENVELOPE {}", fetch::envelope(&p.header)).as_bytes(),
                            );
                        }
                    }
                    Item::BodyStructure => {
                        if let Some(p) = &part {
                            b.extend_from_slice(
                                format!("BODYSTRUCTURE {}", fetch::body_structure(p, &raw, true))
                                    .as_bytes(),
                            );
                        }
                    }
                    Item::Body => {
                        if let Some(p) = &part {
                            b.extend_from_slice(
                                format!("BODY {}", fetch::body_structure(p, &raw, false))
                                    .as_bytes(),
                            );
                        }
                    }
                    Item::Section(s) => {
                        if let Some(p) = &part {
                            let data = fetch::extract(p, &raw, s);
                            b.extend_from_slice(
                                format!("{} {{{}}}\r\n", s.label, data.len()).as_bytes(),
                            );
                            b.extend_from_slice(&data);
                        }
                    }
                }
            }
            if has_flags || seen_now.contains(&u) {
                self.flags.insert(u, flags.clone());
            }
            if seen_now.contains(&u) && !has_flags {
                sep(&mut b);
                b.extend_from_slice(format!("FLAGS ({flags})").as_bytes());
            }
            b.extend_from_slice(b")\r\n");
            self.out.extend_from_slice(&b);
        }
        ok("FETCH completed")
    }

    fn store(&mut self, mailbox: &str, args: &[Token], uid: bool) -> Res {
        if self.read_only {
            return no("[READ-ONLY] mailbox is read-only");
        }
        if args.len() < 3 {
            return bad("STORE requires sequence set, item and flags");
        }
        let Some(uids) = self.picked_uids(args.first(), uid) else {
            return bad("invalid sequence set");
        };
        let item = args[1].text().to_ascii_uppercase();
        let silent = item.ends_with(".SILENT");
        let op = match item.trim_end_matches(".SILENT") {
            "FLAGS" => FlagOp::Replace,
            "+FLAGS" => FlagOp::Add,
            "-FLAGS" => FlagOp::Remove,
            _ => return bad("invalid STORE item"),
        };
        let mut flags = Vec::new();
        for a in &args[2..] {
            match a {
                Token::List(l) => flags.extend(l.iter().map(|f| f.text().to_owned())),
                other => flags.push(other.text().to_owned()),
            }
        }
        let infos = match self
            .mail
            .store
            .set_flags(&self.user, mailbox, &uids, op, &flags)
        {
            Ok(i) => i,
            Err(e) => return no(e.to_string()),
        };
        let seq: HashMap<u32, usize> = self
            .uids
            .iter()
            .enumerate()
            .map(|(i, u)| (*u, i + 1))
            .collect();
        for info in infos {
            let f = flag_text(&info.flags);
            self.flags.insert(info.uid, f.clone());
            if silent {
                continue;
            }
            let n = seq.get(&info.uid).copied().unwrap_or(0);
            if uid {
                self.put(&format!("* {n} FETCH (UID {} FLAGS ({f}))\r\n", info.uid));
            } else {
                self.put(&format!("* {n} FETCH (FLAGS ({f}))\r\n"));
            }
        }
        ok("STORE completed")
    }

    fn copy(&mut self, mailbox: &str, args: &[Token], uid: bool, moving: bool) -> Res {
        if args.len() < 2 {
            return bad("missing arguments");
        }
        if moving && self.read_only {
            return no("[READ-ONLY] mailbox is read-only");
        }
        let Some(uids) = self.picked_uids(args.first(), uid) else {
            return bad("invalid sequence set");
        };
        let dest = args[1].text();
        if self.mail.store.status(&self.user, dest).is_err() {
            return no("[TRYCREATE] no such mailbox");
        }
        let done = if moving {
            self.mail.store.move_to(&self.user, mailbox, dest, &uids)
        } else {
            self.mail.store.copy(&self.user, mailbox, dest, &uids)
        };
        let (src, dst, uv) = match done {
            Ok(d) => d,
            Err(e) => return no(e.to_string()),
        };
        let code = if src.is_empty() {
            String::new()
        } else {
            format!(
                "[COPYUID {uv} {} {}] ",
                fetch::uid_list(&src),
                fetch::uid_list(&dst)
            )
        };
        if moving {
            if !code.is_empty() {
                self.put(&format!("* OK {code}moved\r\n"));
            }
            return ok("MOVE completed");
        }
        ok(format!("{code}COPY completed"))
    }

    /// Waits for DONE, telling the client about changes as they come.
    async fn idle(&mut self, r: &mut Reader, tag: &str) -> io::Result<bool> {
        self.put("+ idling\r\n");
        self.sync(true);
        self.flush().await?;
        let mut watch = self.watch.clone();
        let line = net::read_line(r, MAX_LINE);
        tokio::pin!(line);
        loop {
            tokio::select! {
                got = tokio::time::timeout(IDLE_WAIT, &mut line) => {
                    return match got {
                        Err(_) => {
                            self.put("* BYE autologout\r\n");
                            Ok(true)
                        }
                        Ok(Err(e)) => Err(e),
                        Ok(Ok(None)) => Ok(true),
                        Ok(Ok(Some(l))) if String::from_utf8_lossy(&l).trim().eq_ignore_ascii_case("DONE") => {
                            self.put(&format!("{tag} OK IDLE terminated\r\n"));
                            Ok(false)
                        }
                        Ok(Ok(Some(_))) => {
                            self.put(&format!("{tag} BAD expected DONE\r\n"));
                            Ok(false)
                        }
                    };
                }
                changed = async {
                    match watch.as_mut() {
                        Some(w) => w.changed().await.is_ok(),
                        None => std::future::pending().await,
                    }
                } => {
                    if !changed {
                        watch = None;
                        continue;
                    }
                    self.sync(true);
                    self.flush().await?;
                }
            }
        }
    }
}
