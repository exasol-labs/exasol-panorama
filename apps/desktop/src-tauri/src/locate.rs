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

/// The file names a program can have on this platform.
///
/// On Windows a command-line tool is `foo.exe` if it is a program and `foo.cmd` if
/// it is one of the shims a package manager writes, and which of those it is is not
/// something a caller knows. So all of them are tried, most likely first. Elsewhere
/// a program is its own name.
fn candidates(program: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![
            format!("{program}.exe"),
            format!("{program}.cmd"),
            format!("{program}.bat"),
            program.to_string(),
        ]
    } else {
        vec![program.to_string()]
    }
}

/// Whether a path is a batch shim rather than a program.
///
/// It matters because Windows cannot *execute* one: `CreateProcess` refuses a
/// `.cmd` or a `.bat`, and those are exactly what a package manager installs a
/// command-line tool as. See `command`.
pub fn is_batch(program: &Path) -> bool {
    program
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
}

/// How to run a program that was found by `find`.
///
/// A batch shim on Windows is run through the command interpreter, because it
/// cannot be run any other way. Everything else is run as itself — including on
/// Windows, where `.exe` is a program like any other.
pub fn command(program: &Path) -> Command {
    if cfg!(windows) && is_batch(program) {
        let mut through_shell = Command::new("cmd");
        through_shell.arg("/c").arg(program);
        through_shell
    } else {
        Command::new(program)
    }
}

fn on_path(program: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let names = candidates(program);
    std::env::split_paths(&paths)
        .flat_map(|directory| {
            names
                .iter()
                .map(move |name| directory.join(name))
                .collect::<Vec<_>>()
        })
        .find(|candidate| executable(candidate))
}

/// Asks the login shell. `command -v` is the one question every shell answers the
/// same way, and `-l` is what makes it read the files that set the path up. There
/// is no equivalent on Windows, and no need for one: nothing there puts a tool on
/// the path only for interactive shells.
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
    let directories = if cfg!(windows) {
        vec![
            home.join("AppData/Roaming/npm"),
            home.join(".local/bin"),
            home.join("scoop/shims"),
            PathBuf::from("C:/ProgramData/chocolatey/bin"),
        ]
    } else {
        vec![
            home.join(".local/bin"),
            home.join(".bun/bin"),
            home.join(".volta/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
        ]
    };
    directories
        .into_iter()
        .flat_map(|directory| {
            candidates(program)
                .into_iter()
                .map(move |name| directory.join(name))
        })
        .collect()
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
