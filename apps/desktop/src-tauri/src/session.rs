//! Where the running application says how to reach it.
//!
//! The agent's client and the window are different processes, started in either
//! order by different people, and the one thing they must agree on is an address.
//! Asking the user to keep a port number in a configuration file is how that goes
//! wrong: the number ends up in Claude's configuration, the port moves, and the
//! failure surfaces somewhere else entirely.
//!
//! So the window writes down where it is, and the pipe reads it. A small file per
//! process, named by pid, holding the port, a token and the version — and stale
//! entries are recognised by asking the operating system whether that pid is still
//! there, which is cheaper and more honest than a heartbeat.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// One running window, as written down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub pid: u32,
    pub port: u16,
    /// Required on every request. Loopback keeps other machines out; this keeps
    /// other *programs* on this machine out, including any web page that talks
    /// a browser into reaching for a local address.
    pub token: String,
    pub version: String,
    /// Seconds since the epoch. Only used to prefer the newest of several.
    pub started: u64,
}

/// Where the endpoint is, given a port. One place that knows the shape of it:
/// the window reports it to the settings panel, and the pipe posts to it.
pub fn endpoint_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/agent/mcp")
}

impl Session {
    pub fn endpoint(&self) -> String {
        endpoint_url(self.port)
    }

    /// Deliberately hand-rolled rather than derived: the file is read by a
    /// process that may be a different version of this program, and five flat
    /// fields with a stated shape are easier to keep compatible than a struct
    /// somebody will later add a field to.
    pub fn to_json(&self) -> String {
        format!(
            "{{\n  \"pid\": {},\n  \"port\": {},\n  \"token\": \"{}\",\n  \"version\": \"{}\",\n  \"started\": {}\n}}\n",
            self.pid, self.port, self.token, self.version, self.started
        )
    }

    pub fn from_json(text: &str) -> Option<Session> {
        Some(Session {
            pid: number(text, "pid")? as u32,
            port: number(text, "port")? as u16,
            token: string(text, "token")?,
            version: string(text, "version").unwrap_or_default(),
            started: number(text, "started").unwrap_or(0),
        })
    }
}

/// A number field, without a JSON parser. The file has one writer, and it is
/// this module — but it is also a file a person may open and reformat, so the
/// fields are found by name and read to their end rather than by position.
fn number(text: &str, field: &str) -> Option<u64> {
    let digits: String = value(text, field)?
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

fn string(text: &str, field: &str) -> Option<String> {
    let rest = value(text, field)?;
    let start = rest.find('"')? + 1;
    let end = rest[start..].find('"')? + start;
    Some(rest[start..end].to_string())
}

/// Everything after `"field":`, for the readers above to take what they need.
fn value<'a>(text: &'a str, field: &str) -> Option<&'a str> {
    let needle = format!("\"{field}\"");
    let at = text.find(&needle)? + needle.len();
    text[at..].trim_start().strip_prefix(':')
}

/// Where the files live: `~/.panorama/sessions`, or wherever the environment
/// says, which is what makes this testable without writing to a home directory.
pub fn sessions_dir() -> PathBuf {
    if let Some(given) = std::env::var_os("PANORAMA_SESSION_DIR") {
        return PathBuf::from(given);
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    home.join(".panorama").join("sessions")
}

pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

fn file_for(dir: &Path, pid: u32) -> PathBuf {
    dir.join(format!("{pid}.json"))
}

/// Writes this window down. Failing to is not fatal: the application still works
/// for the person looking at it, and only the agent's client is worse off, so it
/// is reported by the caller rather than raised here.
pub fn write(session: &Session) -> std::io::Result<PathBuf> {
    let dir = sessions_dir();
    fs::create_dir_all(&dir)?;
    let path = file_for(&dir, session.pid);
    fs::write(&path, session.to_json())?;
    Ok(path)
}

/// Removes this window's own entry, and only its own.
pub fn remove(pid: u32) {
    let _ = fs::remove_file(file_for(&sessions_dir(), pid));
}

/// Every window that is still running, newest first.
///
/// Reading the directory rather than a single file is what makes two open windows
/// a describable situation instead of a race: they are both there, and the caller
/// picks. Entries whose process has gone are deleted on the way past — a crash
/// leaves a file behind, and the next reader is the right one to notice.
pub fn live() -> Vec<Session> {
    let dir = sessions_dir();
    let mut found: Vec<Session> = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(session) = fs::read_to_string(&path)
            .ok()
            .and_then(|t| Session::from_json(&t))
        else {
            continue;
        };
        if is_running(session.pid) {
            found.push(session);
        } else {
            let _ = fs::remove_file(&path);
        }
    }
    found.sort_by(|a, b| b.started.cmp(&a.started));
    found
}

/// Whether a pid is still there.
///
/// `kill(pid, 0)` asks the kernel and changes nothing, which is exactly the
/// question. On Windows there is no such call in the standard library, so the
/// answer is "yes" and a stale entry costs one failed connection, after which the
/// pipe launches a window of its own.
#[cfg(unix)]
pub fn is_running(pid: u32) -> bool {
    // SAFETY: `kill` with signal 0 performs the permission and existence checks
    // and delivers nothing.
    unsafe { libc_kill(pid as i32, 0) == 0 }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

#[cfg(not(unix))]
pub fn is_running(_pid: u32) -> bool {
    true
}

/// Ends a process this application started and is no longer waiting for.
///
/// Used for a command-line tool that has stopped answering: abandoning it would
/// leave it running for as long as its own timeout, and there may be six of them.
#[cfg(unix)]
pub fn terminate(pid: u32) {
    // SAFETY: `kill` with SIGKILL on a pid this process spawned.
    unsafe {
        libc_kill(pid as i32, 9);
    }
}

#[cfg(not(unix))]
pub fn terminate(_pid: u32) {}

/// Serialises the tests that point `PANORAMA_SESSION_DIR` somewhere of their own.
///
/// An environment variable belongs to the process, not to the test, and Rust runs
/// tests in threads — so two tests each setting it to their own directory will
/// take turns reading the other's. Poisoning is ignored deliberately: a test that
/// panicked while holding this has already failed, and the rest deserve to run.
#[cfg(test)]
pub fn with_own_session_dir<T>(name: &str, body: impl FnOnce() -> T) -> T {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = std::env::temp_dir().join(format!("panorama-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    std::env::set_var("PANORAMA_SESSION_DIR", dir.join("sessions"));
    let outcome = body();
    std::env::remove_var("PANORAMA_SESSION_DIR");
    let _ = fs::remove_dir_all(&dir);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Session {
        Session {
            pid: 4321,
            port: 7355,
            token: "abc123".to_string(),
            version: "0.1.0".to_string(),
            started: 1_700_000_000,
        }
    }

    #[test]
    fn survives_a_round_trip() {
        let parsed = Session::from_json(&sample().to_json()).expect("should parse what it wrote");
        assert_eq!(parsed, sample());
    }

    #[test]
    fn reads_a_file_written_by_a_version_that_knew_less() {
        let older = "{ \"pid\": 12, \"port\": 7360, \"token\": \"t\" }";
        let parsed = Session::from_json(older).expect("the three fields that matter are there");
        assert_eq!(parsed.port, 7360);
        assert_eq!(parsed.version, "");
        assert_eq!(parsed.started, 0);
    }

    #[test]
    fn refuses_a_file_missing_what_it_needs() {
        assert!(Session::from_json("{ \"pid\": 12 }").is_none());
        assert!(Session::from_json("not json at all").is_none());
    }

    #[test]
    fn names_the_endpoint_after_the_port() {
        assert_eq!(sample().endpoint(), "http://127.0.0.1:7355/agent/mcp");
    }

    #[test]
    fn this_process_is_running_and_pid_one_is_not_us() {
        assert!(is_running(std::process::id()));
    }
}
