//! Finding Claude on this machine, telling it about this application, and opening
//! it — from inside the application, so that none of it needs a terminal.
//!
//! The development server does this too (`packages/mcp/src/claude.ts`), and the
//! reason it is here again rather than shared is that it is not the same job. That
//! one hands out an HTTP URL with a port in it; this one hands out **this
//! executable**, which is also the pipe (`--mcp-stdio`), and therefore never goes
//! stale: no port, no Node, nothing to reinstall when the application moves.
//!
//! One thing is harder here than there and worth knowing about. A development
//! server inherits a developer's shell, so `claude` is on its `PATH`. An
//! application launched from the Dock inherits almost nothing — `/usr/bin:/bin`
//! and little else — and Claude Code is usually installed somewhere that only a
//! login shell knows about. So the search asks the login shell as well, which is
//! what `find_claude` is mostly about.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::locate;

/// What the pairing is called in a client's configuration.
pub const SERVER_NAME: &str = "panorama";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub paired: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatus {
    pub found: bool,
    pub config_path: String,
    pub paired: bool,
}

/// The shape the settings panel already reads, so the panel needs no idea that it
/// is talking to a shell rather than to a development server.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub platform: String,
    pub cli: CliStatus,
    pub desktop: DesktopStatus,
    pub can_open_terminal: bool,
    pub mcp_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairOutcome {
    pub target: String,
    pub done: bool,
    pub detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOutcome {
    pub opened: Option<String>,
    pub detail: String,
}

/// Where Claude Code might be, beyond the usual places: its own installer puts it
/// here.
fn likely_paths() -> Vec<PathBuf> {
    let mut places = vec![locate::home().join(".claude/local/claude")];
    places.extend(locate::usual_places("claude"));
    places
}

/// `claude`, wherever it is. See `locate.rs` for why this is not one line.
pub fn find_claude() -> Option<PathBuf> {
    locate::find("claude", &likely_paths())
}

/// Where the desktop application keeps its configuration. Empty where there is no
/// such application, which is every platform but two.
pub fn desktop_config_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        locate::home().join("Library/Application Support/Claude/claude_desktop_config.json")
    } else if cfg!(windows) {
        locate::home().join("AppData/Roaming/Claude/claude_desktop_config.json")
    } else {
        PathBuf::new()
    }
}

/// Whether a configuration file already names this application.
///
/// Reads `mcpServers` out of whatever JSON is there; a file that cannot be parsed
/// is not one this has any business having an opinion about.
pub fn names_us(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| value.get("mcpServers")?.get(SERVER_NAME).cloned())
        .is_some()
}

fn read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// This application, as a client would have to start it.
fn pipe_command() -> (String, Vec<String>) {
    let exe = std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| "panorama-desktop".to_string());
    (exe, vec!["--mcp-stdio".to_string()])
}

pub fn status(mcp_url: String) -> Status {
    let cli = find_claude();
    let config = desktop_config_path();
    let desktop_config = if config.as_os_str().is_empty() {
        None
    } else {
        read(&config)
    };
    Status {
        platform: std::env::consts::OS.to_string(),
        cli: CliStatus {
            found: cli.is_some(),
            path: cli.as_ref().map(|path| path.to_string_lossy().to_string()),
            paired: read(&locate::home().join(".claude.json"))
                .map(|text| names_us(&text))
                .unwrap_or(false),
        },
        desktop: DesktopStatus {
            // The application on macOS, or a configuration file it left behind on
            // either platform — which is the only evidence there is on Windows.
            found: Path::new("/Applications/Claude.app").exists() || desktop_config.is_some(),
            config_path: config.to_string_lossy().to_string(),
            paired: desktop_config.as_deref().map(names_us).unwrap_or(false),
        },
        can_open_terminal: cfg!(target_os = "macos"),
        mcp_url,
    }
}

/// Tells Claude Code about this application, through its own command rather than
/// by writing its file: the CLI owns that schema, and an entry that is subtly
/// wrong fails where somebody is trying to use it rather than here.
fn pair_cli() -> PairOutcome {
    let Some(claude) = find_claude() else {
        return PairOutcome {
            target: "cli".to_string(),
            done: false,
            detail: "Claude Code was not found on this machine.".to_string(),
        };
    };
    let (command, args) = pipe_command();
    // Through `locate::command`, because on Windows the CLI is often a `.cmd`
    // shim and those cannot be executed directly.
    let mut invocation = locate::command(&claude);
    invocation.args(["mcp", "add", "--scope", "user", SERVER_NAME, "--"]);
    invocation.arg(&command);
    invocation.args(&args);
    match invocation.output() {
        Ok(result) if result.status.success() => PairOutcome {
            target: "cli".to_string(),
            done: true,
            detail: format!(
                "Added \"{SERVER_NAME}\" to Claude Code, for every project on this machine."
            ),
        },
        Ok(result) => {
            let said = String::from_utf8_lossy(&result.stderr);
            let said = if said.trim().is_empty() {
                String::from_utf8_lossy(&result.stdout).trim().to_string()
            } else {
                said.trim().to_string()
            };
            PairOutcome {
                target: "cli".to_string(),
                done: false,
                detail: format!("Claude Code refused: {said}"),
            }
        }
        Err(problem) => PairOutcome {
            target: "cli".to_string(),
            done: false,
            detail: format!("Could not run {}: {problem}", claude.to_string_lossy()),
        },
    }
}

/// The configuration a desktop client needs, merged into whatever is already in
/// the file. It is the user's file; everything else in it is theirs.
pub fn merge_into(
    existing: Option<&str>,
    command: &str,
    args: &[String],
) -> Result<String, String> {
    let mut root = match existing {
        None => serde_json::json!({}),
        Some(text) if text.trim().is_empty() => serde_json::json!({}),
        Some(text) => serde_json::from_str::<serde_json::Value>(text)
            .map_err(|_| "is not valid JSON, so it has been left alone".to_string())?,
    };
    if !root.is_object() {
        return Err("does not hold a JSON object, so it has been left alone".to_string());
    }
    let entry = serde_json::json!({ "command": command, "args": args });
    let object = root.as_object_mut().expect("checked above");
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    servers
        .as_object_mut()
        .expect("just made one")
        .insert(SERVER_NAME.to_string(), entry);
    Ok(format!(
        "{}\n",
        serde_json::to_string_pretty(&root).map_err(|problem| problem.to_string())?
    ))
}

fn pair_desktop() -> PairOutcome {
    let path = desktop_config_path();
    if path.as_os_str().is_empty() {
        return PairOutcome {
            target: "desktop".to_string(),
            done: false,
            detail: format!(
                "There is no Claude desktop application on {}.",
                std::env::consts::OS
            ),
        };
    }
    let (command, args) = pipe_command();
    match merge_into(read(&path).as_deref(), &command, &args) {
        Err(problem) => PairOutcome {
            target: "desktop".to_string(),
            done: false,
            detail: format!(
                "{} {problem}. Fix or move it and try again.",
                path.display()
            ),
        },
        Ok(contents) => {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match std::fs::write(&path, contents) {
                Ok(()) => PairOutcome {
                    target: "desktop".to_string(),
                    done: true,
                    detail: format!(
                        "Wrote \"{SERVER_NAME}\" into {}. Restart Claude for it to be picked up.",
                        path.display()
                    ),
                },
                Err(problem) => PairOutcome {
                    target: "desktop".to_string(),
                    done: false,
                    detail: format!("Could not write {}: {problem}", path.display()),
                },
            }
        }
    }
}

pub fn pair() -> Vec<PairOutcome> {
    vec![pair_cli(), pair_desktop()]
}

/// Opens Claude — the application where there is one, because that is what
/// somebody who installed it means by "open Claude"; the command line otherwise,
/// in a terminal, because what makes Claude Code usable is having somewhere to
/// type.
pub fn open(prefer: Option<&str>) -> OpenOutcome {
    let status = status(String::new());
    let can_app = status.desktop.found && (cfg!(target_os = "macos") || cfg!(windows));
    let can_cli = status.cli.found && status.can_open_terminal;
    let wanted = prefer.unwrap_or(if can_app { "desktop" } else { "cli" });
    let target = match wanted {
        "desktop" if !can_app => "cli",
        "cli" if !can_cli => "desktop",
        other => other,
    };

    if target == "desktop" && can_app {
        let started = if cfg!(windows) {
            Command::new("cmd")
                .args(["/c", "start", "", "claude"])
                .spawn()
        } else {
            Command::new("open").args(["-a", "Claude"]).spawn()
        };
        return match started {
            Ok(_) => OpenOutcome {
                opened: Some("desktop".to_string()),
                detail: "Opened the Claude desktop application.".to_string(),
            },
            Err(problem) => OpenOutcome {
                opened: None,
                detail: format!("Could not open the Claude application: {problem}"),
            },
        };
    }
    if target == "cli" && can_cli {
        // AppleScript, because a terminal is the one thing that cannot be started
        // headless. The directory is the user's own: this application is not in a
        // project, and inventing one would put Claude somewhere arbitrary.
        let where_to = locate::home().to_string_lossy().to_string();
        let script = format!(
            "tell application \"Terminal\" to do script \"cd {where_to} && claude\"\ntell application \"Terminal\" to activate"
        );
        return match Command::new("osascript").args(["-e", &script]).spawn() {
            Ok(_) => OpenOutcome {
                opened: Some("cli".to_string()),
                detail: format!("Opened Claude Code in a new Terminal window, in {where_to}."),
            },
            Err(problem) => OpenOutcome {
                opened: None,
                detail: format!("Could not open a terminal: {problem}"),
            },
        };
    }
    OpenOutcome {
        opened: None,
        detail: if status.cli.found && !status.can_open_terminal {
            "Claude Code is installed, but opening a terminal is only implemented on macOS."
                .to_string()
        } else {
            "Claude was not found on this machine.".to_string()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_a_configuration_that_already_names_us() {
        assert!(names_us(
            "{\"mcpServers\":{\"panorama\":{\"command\":\"x\"}}}"
        ));
        assert!(!names_us("{\"mcpServers\":{\"other\":{}}}"));
        assert!(!names_us("{}"));
        // A file that is not JSON is not one to have an opinion about.
        assert!(!names_us("nonsense"));
    }

    #[test]
    fn merges_into_a_file_that_is_somebody_elses() {
        let existing = "{\n  \"theme\": \"dark\",\n  \"mcpServers\": {\n    \"other\": { \"command\": \"o\" }\n  }\n}";
        let merged = merge_into(
            Some(existing),
            "/Applications/P.app/x",
            &["--mcp-stdio".to_string()],
        )
        .expect("valid JSON");
        let parsed: serde_json::Value = serde_json::from_str(&merged).expect("wrote JSON");
        // Everything that was there is still there.
        assert_eq!(parsed["theme"], "dark");
        assert_eq!(parsed["mcpServers"]["other"]["command"], "o");
        // And this application is now in it, as the pipe.
        assert_eq!(
            parsed["mcpServers"]["panorama"]["command"],
            "/Applications/P.app/x"
        );
        assert_eq!(parsed["mcpServers"]["panorama"]["args"][0], "--mcp-stdio");
    }

    #[test]
    fn writes_a_whole_file_where_there_was_none() {
        let merged = merge_into(None, "x", &[]).expect("no file is not an error");
        assert!(merged.contains("\"panorama\""));
        assert!(merged.ends_with('\n'));
        assert_eq!(merge_into(Some("   "), "x", &[]).unwrap(), merged);
    }

    #[test]
    fn refuses_to_touch_a_file_it_cannot_read() {
        // Better than replacing it: the file is the user's, and a configuration
        // that was hand-edited into invalidity is something they will want back.
        let refused = merge_into(Some("{ not json"), "x", &[]).expect_err("should refuse");
        assert!(refused.contains("not valid JSON"));
        assert!(merge_into(Some("[1,2]"), "x", &[]).is_err());
    }

    #[test]
    fn replaces_an_mcpservers_that_is_not_an_object() {
        // Seen in the wild as `"mcpServers": null` from a half-written edit.
        let merged = merge_into(Some("{\"mcpServers\": null}"), "x", &[]).expect("recoverable");
        assert!(names_us(&merged));
    }

    /// Not part of the suite: it needs Claude Code installed on the machine
    /// running it, which CI does not have.
    ///
    /// Worth running by hand after touching the search — `cargo test -- --ignored`
    /// — because it is the one thing here that fails *silently* in a real
    /// application: launched from the Dock, this process inherits almost no `PATH`,
    /// and a search that only reads `PATH` finds nothing while working perfectly
    /// in every test and every terminal.
    #[test]
    #[ignore]
    fn finds_claude_with_the_path_an_application_actually_has() {
        let restore = std::env::var("PATH").ok();
        std::env::set_var("PATH", "/usr/bin:/bin");
        let found = find_claude();
        match restore {
            Some(path) => std::env::set_var("PATH", path),
            None => std::env::remove_var("PATH"),
        }
        assert!(
            found.is_some(),
            "neither the likely places nor the login shell found claude"
        );
    }

    #[test]
    fn pairs_with_this_executable_rather_than_a_port() {
        let (command, args) = pipe_command();
        assert!(!command.is_empty());
        assert_eq!(args, vec!["--mcp-stdio".to_string()]);
    }
}
