//! Finding a command-line program, from an application that was not started from
//! a shell.
//!
//! This exists because of one fact that is easy to miss and fails silently: a
//! process launched from the Dock, from Spotlight or by another application
//! inherits a `PATH` of roughly `/usr/bin:/bin:/usr/sbin:/sbin`. Everything a
//! person installs for themselves — a version manager, Homebrew on Apple silicon,
//! `~/.local/bin` — is put on the path by their *shell's* configuration, which
//! this process never read. So a search that only reads `PATH` reports "not
//! installed" to somebody who installed it, and works perfectly in every test and
//! every terminal.
//!
//! Three steps, cheapest first: the path we have, the places these things are
//! usually put, and then the login shell, which is the only one that is
//! authoritative and the only one that costs a process.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Whether a path is something this machine would run.
#[cfg(unix)]
pub fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
pub fn executable(path: &Path) -> bool {
    path.is_file()
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// The file name a program has on this platform.
fn file_name(program: &str) -> String {
    if cfg!(windows) {
        format!("{program}.cmd")
    } else {
        program.to_string()
    }
}

fn on_path(program: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|directory| directory.join(file_name(program)))
        .find(|candidate| executable(candidate))
}

/// Asks the login shell. `command -v` is the one question every shell answers the
/// same way, and `-l` is what makes it read the files that set the path up.
fn from_login_shell(program: &str) -> Option<PathBuf> {
    let shell = std::env::var("SHELL").ok()?;
    let asked = Command::new(shell)
        .args(["-l", "-c", &format!("command -v {program}")])
        .output()
        .ok()?;
    if !asked.status.success() {
        return None;
    }
    let printed = String::from_utf8_lossy(&asked.stdout).trim().to_string();
    if printed.is_empty() {
        return None;
    }
    let path = PathBuf::from(printed);
    executable(&path).then_some(path)
}

/// The program, wherever it is: `PATH`, then the places named, then the shell.
pub fn find(program: &str, likely: &[PathBuf]) -> Option<PathBuf> {
    if let Some(found) = on_path(program) {
        return Some(found);
    }
    for candidate in likely {
        if executable(candidate) {
            return Some(candidate.clone());
        }
    }
    from_login_shell(program)
}

/// The places a person's own tools end up, in the order they are likely to be the
/// one meant.
pub fn usual_places(program: &str) -> Vec<PathBuf> {
    let home = home();
    let name = file_name(program);
    let mut places = vec![
        home.join(".local/bin").join(&name),
        home.join(".bun/bin").join(&name),
        home.join(".volta/bin").join(&name),
        PathBuf::from("/opt/homebrew/bin").join(&name),
        PathBuf::from("/usr/local/bin").join(&name),
        PathBuf::from("/usr/bin").join(&name),
    ];
    if cfg!(windows) {
        places.push(home.join("AppData/Roaming/npm").join(&name));
    }
    places
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_where_people_actually_install_things() {
        let places = usual_places("exasol");
        let printed: Vec<String> = places
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect();
        assert!(printed
            .iter()
            .any(|path| path.ends_with(".local/bin/exasol")));
        assert!(printed
            .iter()
            .any(|path| path == "/opt/homebrew/bin/exasol"));
    }

    #[test]
    fn finds_something_that_is_definitely_on_the_path() {
        // `ls` is not interesting; that it is found through `PATH` is.
        assert!(find("ls", &[]).is_some());
    }

    #[test]
    fn finds_nothing_for_something_that_is_not_installed() {
        assert!(find("panorama-not-a-real-program", &[]).is_none());
    }

    #[test]
    fn a_directory_is_not_a_program() {
        assert!(!executable(&home()));
    }
}
