//! What an account may do on the dashboard. The admin may do everything; any
//! other account signs in to the dashboard only with `dashboard`, and then sees
//! and changes only what its permissions, grouped by feature, allow. Every call
//! to the panel's API is checked here against them.

use axum::http::Method;
use serde::Serialize;

use crate::db::User;

#[derive(Serialize)]
pub struct Permission {
    pub key: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
}

#[derive(Serialize)]
pub struct Group {
    pub label: &'static str,
    pub permissions: &'static [Permission],
}

const fn p(key: &'static str, label: &'static str, hint: &'static str) -> Permission {
    Permission { key, label, hint }
}

/// Every permission, by feature, in the order the dashboard shows them.
pub const GROUPS: &[Group] = &[
    Group {
        label: "Dashboard",
        permissions: &[
            p(
                "dashboard",
                "Sign in to the dashboard",
                "Without it, the account signs in only at its tunnels",
            ),
            p(
                "metrics.view",
                "See the host's readings",
                "The Dashboard page: processors, memory, disks and sensors",
            ),
        ],
    },
    Group {
        label: "Containers",
        permissions: &[
            p(
                "containers.view",
                "View containers",
                "Their state, details and logs",
            ),
            p(
                "containers.manage",
                "Start, stop and restart",
                "Pause, resume and kill as well",
            ),
            p(
                "containers.remove",
                "Remove containers",
                "Stopped ones; their volumes stay",
            ),
        ],
    },
    Group {
        label: "Tunnels",
        permissions: &[
            p(
                "tunnels.view",
                "View tunnels",
                "Their addresses, access and activity",
            ),
            p("tunnels.create", "Publish tunnels", ""),
            p(
                "tunnels.edit",
                "Change tunnels",
                "Address, where it goes, access, on and off",
            ),
            p("tunnels.delete", "Remove tunnels", ""),
        ],
    },
    Group {
        label: "Devices",
        permissions: &[
            p(
                "devices.view",
                "View devices",
                "What each browser reported and its sign-ins",
            ),
            p(
                "devices.approve",
                "Approve and change devices",
                "Approve, deny, name them and pick their tunnels",
            ),
            p("devices.remove", "Remove devices", ""),
        ],
    },
    Group {
        label: "Users",
        permissions: &[
            p(
                "users.view",
                "View accounts",
                "Their details, access and sign-ins",
            ),
            p(
                "users.manage",
                "Add and change accounts",
                "Only with permissions they hold themselves, and never their own",
            ),
            p("users.delete", "Remove accounts", ""),
        ],
    },
    Group {
        label: "Git",
        permissions: &[
            p(
                "code.view",
                "View repositories",
                "Browse them, their issues and pull requests, and clone with a token of their own",
            ),
            p(
                "code.discuss",
                "Open issues and pull requests",
                "Comment on them, close and reopen them",
            ),
            p(
                "code.push",
                "Push and merge",
                "Push with git, merge pull requests, make and delete branches",
            ),
            p(
                "code.create",
                "Create repositories",
                "And change their settings",
            ),
            p("code.delete", "Delete repositories", ""),
            p(
                "code.tokens",
                "Manage everyone's tokens",
                "Their own they can always make and remove",
            ),
        ],
    },
    Group {
        label: "Media",
        permissions: &[
            p("media.view", "View photos and videos", "And download them"),
            p("media.upload", "Upload photos and videos", ""),
            p("media.delete", "Delete photos and videos", ""),
        ],
    },
    Group {
        label: "Drive",
        permissions: &[
            p("drive.view", "View documents", "And download them"),
            p(
                "drive.edit",
                "Upload and change documents",
                "Upload, make folders, rename and move",
            ),
            p("drive.delete", "Delete documents", ""),
        ],
    },
    Group {
        label: "Sign-in",
        permissions: &[
            p(
                "oauth.manage",
                "Set up third-party sign-in",
                "The Third-Party OAuth page",
            ),
            p(
                "twofactor.manage",
                "Set up two-factor sign-in",
                "SMTP and when codes are asked for",
            ),
        ],
    },
    Group {
        label: "Settings",
        permissions: &[p(
            "settings.manage",
            "Change settings",
            "Cloudflare, network and the connector",
        )],
    },
];

pub fn known(key: &str) -> bool {
    GROUPS
        .iter()
        .flat_map(|g| g.permissions)
        .any(|p| p.key == key)
}

/// Who is using the panel.
#[derive(Clone)]
pub enum Caller {
    Admin,
    Account(Box<User>),
}

impl Caller {
    pub fn can(&self, key: &str) -> bool {
        match self {
            Caller::Admin => true,
            Caller::Account(user) => user.permissions.iter().any(|p| p == key),
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Caller::Admin => "admin",
            Caller::Account(user) => &user.id,
        }
    }

    pub fn permissions(&self) -> Vec<&str> {
        match self {
            Caller::Admin => GROUPS
                .iter()
                .flat_map(|g| g.permissions)
                .map(|p| p.key)
                .collect(),
            Caller::Account(user) => user.permissions.iter().map(String::as_str).collect(),
        }
    }
}

/// What a call needs: being signed in, or any one of some permissions. An
/// empty list is the admin's alone.
pub enum Need {
    SignedIn,
    Any(&'static [&'static str]),
}

impl Need {
    pub fn met(&self, caller: &Caller) -> bool {
        match self {
            Need::SignedIn => true,
            Need::Any(keys) => {
                matches!(caller, Caller::Admin) || keys.iter().any(|k| caller.can(k))
            }
        }
    }
}

/// The permission a call to `path` (under `/api`) with `method` needs.
pub fn needed(method: &Method, path: &str) -> Need {
    let read = *method == Method::GET || *method == Method::HEAD;
    let seg: Vec<&str> = path.trim_matches('/').split('/').collect();
    let at = |i: usize| seg.get(i).copied().unwrap_or("");
    let any = Need::Any;
    match at(0) {
        "account" | "status" | "device" => Need::SignedIn,
        "oauth" if read => Need::SignedIn,
        "oauth" => any(&["oauth.manage"]),
        "twofactor" => any(&["twofactor.manage"]),
        "settings" | "cloudflare" => any(&["settings.manage"]),
        "zones" => any(&["tunnels.create", "tunnels.edit"]),
        "metrics" => any(&["metrics.view", "containers.view"]),
        "containers" if read => any(&["containers.view"]),
        "containers" if *method == Method::DELETE => any(&["containers.remove"]),
        "containers" => any(&["containers.manage"]),
        "routes" if read && seg.len() == 1 => any(&["tunnels.view", "users.view", "devices.view"]),
        "routes" if read => any(&["tunnels.view"]),
        "routes" if *method == Method::POST => any(&["tunnels.create"]),
        "routes" if *method == Method::DELETE => any(&["tunnels.delete"]),
        "routes" => any(&["tunnels.edit"]),
        "devices" if read => any(&["devices.view", "users.view"]),
        "devices" if *method == Method::DELETE => any(&["devices.remove"]),
        "devices" => any(&["devices.approve"]),
        "users" if read => any(&["users.view", "tunnels.view", "devices.view"]),
        "users" if *method == Method::DELETE => any(&["users.delete"]),
        "users" => any(&["users.manage"]),
        "code" if at(1) == "tokens" => any(&["code.view", "code.tokens"]),
        "code" if at(3) == "pin" => any(&["code.view"]),
        "code" if at(3) == "branch" || at(5) == "merge" => any(&["code.push"]),
        "code" if read => any(&["code.view"]),
        "code" if at(3) == "threads" || at(3) == "thread" => any(&["code.discuss"]),
        "code" if *method == Method::DELETE => any(&["code.delete"]),
        "code" => any(&["code.create"]),
        "media" => files("media", read, at(2)),
        "drive" => files("drive", read, at(2)),
        // Each job is held to the collection it reads and writes, in `convert`.
        "convert" if read => any(&["media.view", "drive.view"]),
        "convert" => any(&["media.upload", "drive.edit"]),
        _ => any(&[]),
    }
}

/// Media's and Drive's file calls: reading, deleting, or anything else.
fn files(space: &str, read: bool, op: &str) -> Need {
    let keys: &'static [&'static str] = match (space, read, op) {
        ("media", true, _) => &["media.view"],
        ("media", false, "delete") => &["media.delete"],
        ("media", false, _) => &["media.upload"],
        (_, true, _) => &["drive.view"],
        (_, false, "delete") => &["drive.delete"],
        _ => &["drive.edit"],
    };
    Need::Any(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(perms: &[&str]) -> Caller {
        Caller::Account(Box::new(User {
            id: "u1".into(),
            username: "kim".into(),
            email: String::new(),
            name: String::new(),
            password_hash: String::new(),
            enabled: true,
            all_routes: false,
            route_ids: Vec::new(),
            device_ids: Vec::new(),
            permissions: perms.iter().map(|p| (*p).to_owned()).collect(),
            created_at: 0,
            last_login: None,
            note: None,
        }))
    }

    #[test]
    fn calls_need_their_feature() {
        let viewer = account(&["dashboard", "code.view", "media.view"]);
        assert!(needed(&Method::GET, "/code/repos").met(&viewer));
        assert!(!needed(&Method::POST, "/code/repos").met(&viewer));
        assert!(needed(&Method::GET, "/media/fs/list").met(&viewer));
        assert!(!needed(&Method::PUT, "/media/fs/upload").met(&viewer));
        assert!(!needed(&Method::POST, "/media/fs/delete").met(&viewer));
        assert!(!needed(&Method::PATCH, "/routes/r1").met(&viewer));
        assert!(!needed(&Method::GET, "/settings").met(&viewer));
        assert!(needed(&Method::GET, "/status").met(&viewer));
        assert!(needed(&Method::DELETE, "/routes/r1").met(&Caller::Admin));
        assert!(needed(&Method::PUT, "/code/repos/app/pin").met(&viewer));
        assert!(!needed(&Method::POST, "/code/repos/app/threads").met(&viewer));
        assert!(!needed(&Method::POST, "/code/repos/app/thread/3/merge").met(&viewer));
        assert!(needed(&Method::GET, "/code/repos/app/threads/issues").met(&viewer));
        assert!(needed(&Method::GET, "/convert").met(&viewer));
        assert!(!needed(&Method::POST, "/convert").met(&viewer));
    }

    #[test]
    fn every_key_is_known() {
        assert!(known("code.push"));
        assert!(known("dashboard"));
        assert!(!known("everything"));
    }
}
