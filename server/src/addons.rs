//! Add-ons: apps beside myTunnels' own pages, installed and removed by the
//! host or an admin. Git comes installed; Device Controller does not. A
//! removed add-on leaves the sidebar and its dashboard calls are refused; what
//! it kept stays, for when it is installed again.

use anyhow::Result;

use crate::db::Db;

/// Each add-on: its id, its name, and the first segment of its calls under `/api`.
pub const ALL: &[(&str, &str, &str)] = &[
    ("git", "Git", "code"),
    ("controller", "Device Controller", "hardware"),
];

const KEY: &str = "addons";
const DEFAULT: &str = "git";

pub fn installed(db: &Db) -> Result<Vec<String>> {
    let value = db.setting(KEY)?.unwrap_or_else(|| DEFAULT.to_owned());
    Ok(parse(&value))
}

/// Installs or removes `id`, and returns what is installed after.
pub fn set(db: &Db, id: &str, on: bool) -> Result<Vec<String>> {
    let mut list = installed(db)?;
    list.retain(|a| a != id);
    if on {
        list.push(id.to_owned());
    }
    let list: Vec<String> = ALL
        .iter()
        .map(|(a, _, _)| (*a).to_owned())
        .filter(|a| list.contains(a))
        .collect();
    db.set_setting(KEY, &list.join(","))?;
    Ok(list)
}

pub fn known(id: &str) -> bool {
    ALL.iter().any(|(a, _, _)| *a == id)
}

/// The name of the add-on whose calls start with `segment`, when it is not installed.
pub fn missing(installed: &[String], segment: &str) -> Option<&'static str> {
    ALL.iter()
        .find(|(_, _, s)| *s == segment)
        .filter(|(a, _, _)| !installed.iter().any(|i| i == a))
        .map(|(_, name, _)| *name)
}

fn parse(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|a| known(a))
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calls_of_a_removed_add_on_are_named() {
        let git = parse("git");
        assert_eq!(missing(&git, "hardware"), Some("Device Controller"));
        assert_eq!(missing(&git, "code"), None);
        assert_eq!(missing(&git, "routes"), None);
        assert_eq!(missing(&parse(""), "code"), Some("Git"));
        assert_eq!(parse("git, controller,other"), ["git", "controller"]);
    }
}
