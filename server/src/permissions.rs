//! What an account may do on the dashboard. The host, the account made at setup,
//! may do everything. Admin is a role any account can be given: it may do
//! everything too, including making others admins. Any other account signs in to
//! the dashboard only with `dashboard`, and then sees and changes only what its
//! permissions, grouped by feature, allow. Every call to the panel's API is
//! checked here against them.

use axum::http::Method;
use serde::Serialize;

use crate::db::{User, ADMIN};

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
        label: "Admin",
        permissions: &[p(
            ADMIN,
            "Admin",
            "Every permission below, including making others admins",
        )],
    },
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
            p(
                "containers.deploy",
                "Add and update containers",
                "Link a repository, build it, update and go back to an earlier build",
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
            p("devices.approve", "Name devices", ""),
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
        label: "Device Controller",
        permissions: &[p(
            "hardware.control",
            "Control the host's hardware",
            "Set its fan speeds by hand or hand them back to the firmware",
        )],
    },
    Group {
        label: "Photos and videos",
        permissions: &[
            p("media.view", "View photos and videos", "And download them"),
            p("media.upload", "Upload photos and videos", ""),
            p("media.delete", "Delete photos and videos", ""),
        ],
    },
    Group {
        label: "Files",
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
        label: "Apps",
        permissions: &[p(
            "apps.install",
            "Install apps on the host",
            "From Apps, through the host's package manager",
        )],
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
    /// The host account, made at setup.
    Host,
    Account(Box<User>),
}

impl Caller {
    pub fn can(&self, key: &str) -> bool {
        match self {
            Caller::Host => true,
            Caller::Account(user) => user.holds(key),
        }
    }

    pub fn id(&self) -> &str {
        match self {
            // Stored under this name since before roles.
            Caller::Host => "admin",
            Caller::Account(user) => &user.id,
        }
    }

    pub fn permissions(&self) -> Vec<&str> {
        match self {
            caller if caller.is_admin() => GROUPS
                .iter()
                .flat_map(|g| g.permissions)
                .map(|p| p.key)
                .collect(),
            Caller::Host => Vec::new(),
            Caller::Account(user) => user.permissions.iter().map(String::as_str).collect(),
        }
    }

    /// The host, or an account with the Admin role.
    pub fn is_admin(&self) -> bool {
        match self {
            Caller::Host => true,
            Caller::Account(user) => user.holds(ADMIN),
        }
    }
}

/// What a call needs: being signed in, or any one of some permissions. An
/// empty list is for the host and admins alone.
pub enum Need {
    SignedIn,
    Any(&'static [&'static str]),
}

impl Need {
    pub fn met(&self, caller: &Caller) -> bool {
        match self {
            Need::SignedIn => true,
            Need::Any(keys) => caller.is_admin() || keys.iter().any(|k| caller.can(k)),
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
        // Share links and the duplicate finder check each space's own
        // permission, and share links whose link it is.
        "account" | "status" | "device" | "shares" | "duplicates" | "needs" => Need::SignedIn,
        "apps" if read => Need::SignedIn,
        "apps" => any(&["apps.install"]),
        "oauth" if read => Need::SignedIn,
        "oauth" => any(&["oauth.manage"]),
        "twofactor" => any(&["twofactor.manage"]),
        "settings" | "cloudflare" => any(&["settings.manage"]),
        "zones" => any(&["tunnels.create", "tunnels.edit"]),
        "metrics" => any(&["metrics.view", "containers.view"]),
        "hardware" => any(&["hardware.control"]),
        "containers" | "images" | "deploys" if read => any(&["containers.view"]),
        "deploys" if *method == Method::DELETE => any(&["containers.remove"]),
        "deploys" => any(&["containers.deploy"]),
        "images" => any(&["containers.remove"]),
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
        "flags" if read => any(&["users.view"]),
        "flags" => any(&["users.manage"]),
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
            device_lock: false,
            permissions: perms.iter().map(|p| (*p).to_owned()).collect(),
            created_at: 0,
            last_login: None,
            note: None,
            storage_limit: 0,
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
        assert!(needed(&Method::DELETE, "/routes/r1").met(&Caller::Host));
        assert!(needed(&Method::PUT, "/code/repos/app/pin").met(&viewer));
        assert!(!needed(&Method::POST, "/code/repos/app/threads").met(&viewer));
        assert!(!needed(&Method::POST, "/code/repos/app/thread/3/merge").met(&viewer));
        assert!(needed(&Method::GET, "/code/repos/app/threads/issues").met(&viewer));
        assert!(needed(&Method::GET, "/convert").met(&viewer));
        assert!(!needed(&Method::POST, "/convert").met(&viewer));
        let deployer = account(&["dashboard", "containers.view", "containers.deploy"]);
        assert!(needed(&Method::GET, "/deploys").met(&deployer));
        assert!(needed(&Method::POST, "/deploys/d1/build").met(&deployer));
        assert!(!needed(&Method::DELETE, "/deploys/d1").met(&deployer));
        assert!(!needed(&Method::POST, "/deploys").met(&viewer));
    }

    #[test]
    fn every_key_is_known() {
        assert!(known("code.push"));
        assert!(known("dashboard"));
        assert!(!known("everything"));
    }

    #[test]
    fn the_admin_role_holds_everything_and_can_grant_it() {
        let admin = account(&["admin"]);
        assert!(admin.is_admin());
        assert!(admin.can("users.manage") && admin.can("admin") && admin.can("settings.manage"));
        assert!(needed(&Method::GET, "/unknown").met(&admin));
        let manager = account(&["users.manage"]);
        assert!(!manager.is_admin() && !manager.can("admin"));
        assert!(!needed(&Method::GET, "/unknown").met(&manager));
        assert!(Caller::Host.can("admin"));
    }
}
