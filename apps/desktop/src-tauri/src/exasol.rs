//! The databases already on this machine.
//!
//! Exasol Personal keeps its deployments under `~/.exasol/personal/deployments`
//! and its `exasol` command knows all about them: what they are called, whether
//! they are running, which port each one ended up on, and — in the deployment's
//! own directory — the password it was installed with. Somebody who has one of
//! those running has already answered every question the connection dialog asks,
//! and typing the answers again is work the application can do instead.
//!
//! So this asks the CLI, and the dialog offers what it said. Two rules shape it:
//!
//! **The CLI is the interface, not the files.** `deployments list`, `status` and
//! `info` answer in JSON and are the documented way to ask; reading a deployment's
//! own state files would couple this to a layout that is theirs to change. The one
//! exception is the password, which the CLI does not print — `secrets.json` in the
//! deployment directory is where it says the password is, and where the
//! deployment's own instructions tell a person to look.
//!
//! **Do not ask the tool a question it answers badly.** Three measurements on a
//! machine with six deployments decided the shape of this, and are filed upstream
//! as exasol/exasol-personal#309, #310 and #311 (see
//! `reports/exasol-personal-cli-status.md`):
//!
//! 1. `deployments list` called all six `running` while only one had a database
//!    listening. Its `status` is unusable, so it is ignored.
//! 2. `exasol status` knows more — it reported `stopped` and
//!    `database_connection_failed` correctly — but it also reported *two*
//!    deployments as `database_ready` at the same `127.0.0.1:8563`, which cannot
//!    be true: one process holds a port. A stopped deployment's readiness check
//!    had found somebody else's database on the port it used to use.
//! 3. And it is not reliably quick. A status against a healthy database answers in
//!    about two seconds; against an unreachable one it was measured taking
//!    *minutes*, and a later run had every one of the six exceed an eight-second
//!    deadline. A list that waits on it is a list that sometimes never arrives.
//!
//! So readiness is not taken from the tool. **Panorama asks the socket**, which is
//! the question it actually needs answered — can a connection from here reach a
//! database — and gets it in milliseconds on loopback. The tool is still asked for
//! its status, with a short deadline, because its words and its messages are
//! better than anything invented here; if it does not answer in time, the row says
//! what the socket said instead. And two deployments claiming one address are both
//! refused, because opening the wrong database under the right name is the worst
//! outcome available.
//!
//! **A password is fetched when somebody clicks, not when a list is drawn.** The
//! list is a list of names and addresses, safe to show, log or hand to a screen
//! reader. The secret is read from disk at the moment it is needed and passed
//! straight into a connection.

use std::collections::{HashMap, HashSet};
use std::net::ToSocketAddrs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

use crate::locate;
use crate::trust;

/// One deployment, as the connection dialog needs it.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Deployment {
    pub name: String,
    /// What `exasol status` called it: `database_ready`, `stopped`,
    /// `operation_in_progress`, and others it may add. Passed through as it came —
    /// the list shows the tool's own word for it rather than a guess of ours.
    pub status: String,
    /// The sentence the CLI offers about that status, for a tooltip.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Where it is deployed: `local`, `aws`, `azure`, and the rest of the presets.
    ///
    /// Carried because these are deployments *managed from* this machine, which is
    /// not the same as deployments *on* it: Exasol Personal installs to a cloud
    /// just as happily, and a row that says `local` when it is in AWS is a lie
    /// about where the data is.
    pub infrastructure: String,
    /// Where the deployment lives, for matching against the process that holds its
    /// port. Not sent to the page, which has no use for a path.
    #[serde(skip)]
    pub path: String,
    /// `wss://host:port`, or absent for one that is not running and has no address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

/// What a connection needs, read at the moment somebody asks for it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub url: String,
    pub username: String,
    pub password: String,
}

fn find_exasol() -> Option<PathBuf> {
    locate::find("exasol", &locate::usual_places("exasol"))
}

/// What this machine has to offer, which is two separate questions.
///
/// A machine with no `exasol` command is shown nothing about local deployments —
/// there is nothing to say and nothing to act on. A machine that *has* the command
/// and no deployments is a different situation, and one worth a sentence rather
/// than silence, so the two are reported apart.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Local {
    pub installed: bool,
    pub deployments: Vec<Deployment>,
}

impl Local {
    /// What a machine with no Exasol Personal on it looks like, and so also what
    /// is said when the question could not be put at all: the dialog is built to
    /// show this, and showing it is better than showing nothing.
    pub fn nothing_found() -> Self {
        Self {
            installed: false,
            deployments: Vec::new(),
        }
    }
}

/// How much to find out, because the three answers cost three different amounts.
///
/// - `Names` — the list, and nothing else. Instant, and nothing in it is offered as
///   connectable.
/// - `Probed` — plus each address and whether a socket accepts a connection there.
///   A few hundred milliseconds, and *this is the answer that matters*: a row is
///   connectable when something answers at its address.
/// - `Described` — plus what `exasol status` calls each one. Seconds, sometimes
///   many, and worth nothing except better words on a row that is not connectable.
///
/// Split because connectability used to wait behind the status calls, which made
/// the thing a person came to the panel for the slowest thing in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detail {
    Names,
    Probed,
    Described,
}

impl Detail {
    pub fn from_name(name: Option<&str>) -> Detail {
        match name {
            Some("probed") => Detail::Probed,
            Some("described") => Detail::Described,
            _ => Detail::Names,
        }
    }
}

pub fn local(detail: Detail) -> Local {
    Local {
        installed: find_exasol().is_some(),
        deployments: deployments(detail),
    }
}

/// How long any one `exasol` call may take before it is given up on.
///
/// Not a guess: a status against a healthy database answers in about two seconds,
/// and a status against one that is unreachable was measured taking *minutes* —
/// the CLI is waiting on a connection that will not happen. Six of those in
/// parallel is a list that never arrives, so each call gets a deadline and a
/// deployment nobody could ask about is shown as unknown rather than as pending
/// forever.
const CALL_LIMIT: Duration = Duration::from_secs(8);

/// How long to wait for a *status*, which is a nicety rather than the answer.
const STATUS_LIMIT: Duration = Duration::from_secs(3);

/// How long to wait for a database to accept a connection. Loopback answers
/// instantly; a cloud host is a round trip away, and one that has not answered in
/// this long is one a connection would not survive either.
const PROBE_LIMIT: Duration = Duration::from_millis(2500);

fn run(exasol: &Path, arguments: &[&str]) -> Result<String, String> {
    run_within(exasol, arguments, CALL_LIMIT)
}

fn run_within(exasol: &Path, arguments: &[&str], limit: Duration) -> Result<String, String> {
    // Through `locate::command`: on Windows the tool may be a `.cmd` shim, which
    // has to be run by the command interpreter.
    let child = locate::command(exasol)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|problem| format!("could not run {}: {problem}", exasol.to_string_lossy()))?;
    let pid = child.id();
    let (sender, receiver) = std::sync::mpsc::channel();
    // Waited on in a thread so the deadline is ours rather than the tool's. The
    // output is a small JSON value, so collecting it in one go cannot block on a
    // full pipe.
    std::thread::spawn(move || {
        let _ = sender.send(child.wait_with_output());
    });
    let result = match receiver.recv_timeout(limit) {
        Ok(Ok(result)) => result,
        Ok(Err(problem)) => return Err(format!("could not read what exasol said: {problem}")),
        Err(_) => {
            crate::session::terminate(pid);
            return Err(format!(
                "exasol {} did not answer within {}s",
                arguments.join(" "),
                limit.as_secs()
            ));
        }
    };
    if !result.status.success() {
        let said = String::from_utf8_lossy(&result.stderr).trim().to_string();
        return Err(if said.is_empty() {
            format!("exasol {} failed", arguments.join(" "))
        } else {
            said
        });
    }
    Ok(String::from_utf8_lossy(&result.stdout).to_string())
}

/// The JSON out of a CLI answer.
///
/// `info` writes a line about which deployment directory it chose before the
/// JSON — to stderr today, but this is a *tool's* output, so the value is found
/// rather than assumed to start at the first byte.
pub fn json_in(text: &str) -> Option<serde_json::Value> {
    let start = text.find(['{', '['])?;
    serde_json::from_str(text[start..].trim()).ok()
}

/// One deployment's address, out of `exasol info --json`.
pub fn address_in(info: &serde_json::Value) -> (Option<String>, Option<String>) {
    let connection = info.get("connection");
    let host = connection
        .and_then(|c| c.get("host"))
        .and_then(|value| value.as_str());
    let port = connection
        .and_then(|c| c.get("dbPort"))
        .and_then(|value| value.as_u64());
    let username = connection
        .and_then(|c| c.get("username"))
        .and_then(|value| value.as_str())
        .map(|name| name.to_string());
    match (host, port) {
        // A bracketed IPv6 literal would need brackets in a URL; hosts here are
        // names or IPv4, and anything else is better shown as nothing than as a
        // URL that will not parse.
        (Some(host), Some(port)) if !host.contains(':') => {
            (Some(format!("wss://{host}:{port}")), username)
        }
        _ => (None, username),
    }
}

/// A status, as `exasol status --json` gives it.
pub fn status_in(text: &str) -> (String, Option<String>) {
    let parsed = json_in(text);
    let read = |field: &str| -> Option<String> {
        parsed
            .as_ref()?
            .get(field)?
            .as_str()
            .map(|value| value.to_string())
    };
    (
        read("status").unwrap_or_else(|| "unknown".to_string()),
        read("message"),
    )
}

/// The deployments this machine has, as the dialog lists them.
///
/// A deployment whose `info` cannot be read is still listed — with its status and
/// no address, so it shows as something that exists and cannot be clicked. Being
/// told a database is there and stopped is more use than being told nothing.
pub fn deployments(detail: Detail) -> Vec<Deployment> {
    let Some(exasol) = find_exasol() else {
        return Vec::new();
    };
    let Ok(listed) = run(&exasol, &["deployments", "list", "--json"]) else {
        return Vec::new();
    };
    let Some(serde_json::Value::Array(entries)) = json_in(&listed) else {
        return Vec::new();
    };

    if detail == Detail::Names {
        // The names, now. Nothing here is offered as connectable — `checking` is
        // not `database_ready` — so a row drawn from this cannot be clicked before
        // anybody knows whether it would work.
        return entries.iter().filter_map(unchecked_entry).collect();
    }

    // Each deployment is asked about at once: a probe is milliseconds on loopback,
    // and a status — where one is wanted — is seconds, so the slowest sets the pace
    // rather than the sum.
    let asked: Vec<Deployment> = std::thread::scope(|scope| {
        let asking: Vec<_> = entries
            .iter()
            .map(|entry| {
                let exasol = exasol.clone();
                scope.spawn(move || describe(&exasol, entry, detail))
            })
            .collect();
        asking
            .into_iter()
            .filter_map(|handle| handle.join().ok().flatten())
            .collect()
    });
    // Asked for only when something is actually contested, since it costs the best
    // part of a second the first time.
    let contested = {
        let mut seen: HashMap<&str, usize> = HashMap::new();
        for one in &asked {
            if let Some(url) = one.url.as_deref() {
                *seen.entry(url).or_default() += 1;
            }
        }
        seen.values().any(|count| *count > 1)
    };
    let live = if contested {
        live_dirs()
    } else {
        HashSet::new()
    };
    flag_conflicts(asked, &live)
}

/// Whether a *database* answers at an address.
///
/// Panorama's readiness test, and the only one that answers the question a person
/// is about to ask by clicking. It says nothing about *whose* database answered —
/// that is what `flag_conflicts` is for.
///
/// It completes a TLS handshake rather than only opening a socket, and the
/// difference is not theoretical. Exasol Personal's local deployments are a
/// database inside a VM and a forwarder on loopback in front of it, and the two
/// fail apart: a forwarder that has lost its route to the guest goes on accepting
/// connections on `127.0.0.1:8563` and then resets every one of them. A socket
/// test passes that, so the dialog offered a deployment that could not be opened,
/// which is the one outcome a readiness test exists to prevent. A handshake does
/// not pass it — nothing completes TLS but something serving TLS.
///
/// The certificate is deliberately not checked, and that is not a hole: nothing is
/// sent over this connection and nothing is read from it. It exists to find out
/// whether a database is there, and a local deployment's certificate is
/// self-signed, so verifying here would report every healthy one as unreachable.
/// Whether the certificate is *acceptable* is a different question, asked at the
/// moment of connecting, by `database`, of the person.
pub fn accepts(url: &str) -> bool {
    let Some((host, port)) = address_of(url) else {
        return false;
    };
    // Resolved first, because a name that does not resolve should fail here rather
    // than inside a connect with its own idea of a timeout.
    let Ok(mut candidates) = (host.as_str(), port).to_socket_addrs() else {
        return false;
    };
    let Some(stream) = candidates
        .find_map(|address| std::net::TcpStream::connect_timeout(&address, PROBE_LIMIT).ok())
    else {
        return false;
    };
    // A handshake with nobody on the other end would otherwise wait for as long as
    // the socket is willing to, which is minutes.
    if stream.set_read_timeout(Some(PROBE_LIMIT)).is_err()
        || stream.set_write_timeout(Some(PROBE_LIMIT)).is_err()
    {
        return false;
    }
    // `ws://` is not a shape any deployment reports — `address_in` only ever builds
    // `wss://` — but it is a shape this function can be handed, and an unencrypted
    // address is answered by the question it can actually answer.
    if url.starts_with("ws://") {
        return true;
    }
    let Ok(connector) = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
    else {
        return false;
    };
    connector.connect(&host, stream).is_ok()
}

/// `wss://host:port` back to the two things a socket needs.
pub fn address_of(url: &str) -> Option<(String, u16)> {
    let rest = url
        .strip_prefix("wss://")
        .or_else(|| url.strip_prefix("ws://"))?;
    let rest = rest.split('/').next()?;
    let (host, port) = rest.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port.parse().ok()?))
}

/// Which deployments have a process working in them.
///
/// The tool cannot say which of two deployments holding one address is the live
/// one, but the operating system can — and not through the process's command line,
/// which is `launcher __daemon__ 2 18432` and names nothing. It is in what the
/// process has *open*: the local runner works inside its own deployment directory,
/// so its working directory is under `…/deployments/<name>/local/runtime`.
///
/// One question for the whole machine rather than one per contested address: the
/// answer is a set of directories, it costs a walk of the process table either way
/// (about eight hundred milliseconds here), and it resolves any number of conflicts
/// at once.
pub fn live_dirs_now() -> HashSet<String> {
    // `lsof` is a unix tool, and Windows has no one-line equivalent. Without it a
    // contested address stays contested: both rows are refused, which is the safe
    // answer and the one this had before the process table was consulted at all.
    if cfg!(windows) {
        return HashSet::new();
    }
    let listed = run_within(
        Path::new("lsof"),
        &["-a", "-d", "cwd", "-Fn"],
        Duration::from_secs(4),
    );
    listed
        .map(|paths| deployment_dirs_in(&paths))
        .unwrap_or_default()
}

/// The deployment directories named in a list of paths.
pub fn deployment_dirs_in(paths: &str) -> HashSet<String> {
    const MARKER: &str = "/deployments/";
    let mut found = HashSet::new();
    for line in paths.lines() {
        let path = line.strip_prefix('n').unwrap_or(line);
        let Some(at) = path.find(MARKER) else {
            continue;
        };
        let name = path[at + MARKER.len()..]
            .split('/')
            .next()
            .unwrap_or_default();
        if !name.is_empty() {
            found.insert(format!("{}{MARKER}{name}", &path[..at]));
        }
    }
    found
}

/// The same answer, remembered for long enough to be worth having.
///
/// Establishing it costs the best part of a second, and it changes only when a
/// deployment is started or stopped — so a panel that refreshes does not pay for it
/// twice. Remembered, not trusted: a stale answer can only affect what a row
/// *looks* like, because `credentials` establishes it again from scratch at the
/// moment somebody clicks.
const LIVE_MEMORY: Duration = Duration::from_secs(30);

type LiveMemory = Mutex<Option<(std::time::Instant, HashSet<String>)>>;

fn live_memory() -> &'static LiveMemory {
    static MEMORY: OnceLock<LiveMemory> = OnceLock::new();
    MEMORY.get_or_init(|| Mutex::new(None))
}

pub fn live_dirs() -> HashSet<String> {
    if let Some(remembered) = live_memory().lock().ok().and_then(|memory| {
        memory
            .as_ref()
            .filter(|(seen, _)| seen.elapsed() < LIVE_MEMORY)
            .map(|(_, dirs)| dirs.clone())
    }) {
        return remembered;
    }
    let found = live_dirs_now();
    if let Ok(mut memory) = live_memory().lock() {
        *memory = Some((std::time::Instant::now(), found.clone()));
    }
    found
}

/// Works out the answers before anybody asks for them.
///
/// Called as the application starts, in a thread of its own: the page asks about
/// deployments a few hundred milliseconds later, and an answer already in hand is
/// the difference between a list that fills in and a list that waits.
///
/// Where the `exasol` command is comes first, and matters most on the launch this
/// is written for. A window opened from the Dock has a `PATH` with nothing of the
/// person's own on it, so the search falls through to asking their login shell —
/// which reads their profile, which is the slowest thing this application does
/// before it is asked anything. Done here, once, it is done before it is wanted.
pub fn warm() {
    std::thread::spawn(|| {
        if let Some(exasol) = find_exasol() {
            eprintln!("[panorama] exasol command at {}", exasol.to_string_lossy());
        }
        let found = live_dirs();
        if !found.is_empty() {
            eprintln!(
                "[panorama] {} deployment(s) have a live process",
                found.len()
            );
        }
    });
}

/// Two deployments cannot share an address, so neither is offered — unless the
/// machine can say which one is listening.
///
/// This is the second thing the tool is wrong about, and the more dangerous one:
/// asked about six deployments it reported two as `database_ready` at
/// *the same* `127.0.0.1:8563`, which cannot be true — one process holds a port.
/// What it means in practice is that a stopped deployment's readiness check found
/// somebody else's database answering on the port it used to use, and said yes.
///
/// Connecting to whichever answers would open a database that is not the one that
/// was clicked, under its name. Silently browsing the wrong data is worse than
/// any refusal, so both rows say what happened and neither can be opened. Which
/// of them is real is not knowable from here — the answer is to stop one.
fn flag_conflicts(deployments: Vec<Deployment>, live: &HashSet<String>) -> Vec<Deployment> {
    let mut claims: HashMap<String, Vec<String>> = HashMap::new();
    for deployment in &deployments {
        if let Some(url) = deployment.url.as_deref() {
            claims
                .entry(url.to_string())
                .or_default()
                .push(deployment.name.clone());
        }
    }

    // Which contender, if exactly one, has a process working in its directory.
    // Exactly one: two live processes claiming one address is not something to
    // guess about either.
    let owner_of: HashMap<&String, Option<&String>> = claims
        .iter()
        .filter(|(_, sharing)| sharing.len() > 1)
        .map(|(url, sharing)| {
            let mut living = sharing.iter().filter(|name| {
                deployments
                    .iter()
                    .any(|one| &one.name == *name && live.contains(&one.path))
            });
            let first = living.next();
            (url, if living.next().is_none() { first } else { None })
        })
        .collect();

    deployments
        .into_iter()
        .map(|deployment| {
            let Some(url) = deployment.url.clone() else {
                return deployment;
            };
            let Some(sharing) = claims.get(&url) else {
                return deployment;
            };
            if sharing.len() < 2 {
                return deployment;
            }
            let others: Vec<&str> = sharing
                .iter()
                .filter(|name| *name != &deployment.name)
                .map(String::as_str)
                .collect();

            match owner_of.get(&url).copied().flatten() {
                // The machine named the deployment with a process working in it.
                // It keeps its address; the others are told whose it is, which is
                // more use than "conflict".
                Some(owner) if *owner == deployment.name => deployment,
                Some(owner) => {
                    Deployment {
                        status: "port_taken".to_string(),
                        message: Some(format!(
                            "{url} belongs to {owner}, which is the one running. This deployment reports the same address but is not."
                        )),
                        url: None,
                        username: None,
                        ..deployment
                    }
                }
                // Nobody could be identified: refuse every claimant. Opening the
                // wrong database under the right name is worse than any refusal.
                None => Deployment {
                    status: "address_conflict".to_string(),
                    message: Some(format!(
                        "{also} also reports {url}, and one address cannot be two databases — so which of them is listening cannot be told from here. Stop the one you do not want (exasol stop -d {first}) and look again.",
                        also = others.join(" and "),
                        first = others.first().copied().unwrap_or("<name>")
                    )),
                    url: None,
                    username: None,
                    ..deployment
                },
            }
        })
        .collect()
}

/// One deployment, from the list alone: what it is called and where it lives.
fn unchecked_entry(entry: &serde_json::Value) -> Option<Deployment> {
    Some(Deployment {
        name: entry.get("name")?.as_str()?.to_string(),
        status: "checking".to_string(),
        message: None,
        path: entry
            .get("path")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        infrastructure: entry
            .get("infrastructure")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown")
            .to_string(),
        url: None,
        username: None,
    })
}

/// One deployment, asked about properly.
fn describe(exasol: &Path, entry: &serde_json::Value, detail: Detail) -> Option<Deployment> {
    let name = entry.get("name")?.as_str()?.to_string();
    let infrastructure = entry
        .get("infrastructure")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_string();

    // The address it would be at, which a stopped deployment also answers — with a
    // port that may belong to something else entirely. So it is a candidate, not a
    // fact, until the socket says otherwise.
    let (candidate, username) = run(exasol, &["info", "-d", &name, "--json"])
        .ok()
        .as_deref()
        .and_then(json_in)
        .map(|info| address_in(&info))
        .unwrap_or((None, None));

    let reachable = candidate.as_deref().map(accepts).unwrap_or(false);

    // What the socket found is the answer. The tool's own word is a nicety, and is
    // only asked for when the caller said it would wait for one — it costs seconds.
    // Deliberately not `entry["status"]` either: see the note at the top of this
    // file.
    let found = if reachable {
        "reachable"
    } else {
        "unreachable"
    }
    .to_string();
    let (status, message) = if detail == Detail::Described {
        match run_within(exasol, &["status", "-d", &name, "--json"], STATUS_LIMIT) {
            Ok(said) => status_in(&said),
            Err(problem) => (found, Some(problem)),
        }
    } else {
        (found, None)
    };

    Some(Deployment {
        name,
        status,
        message,
        infrastructure,
        path: entry
            .get("path")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        // Only an address something answered at. A row without one cannot be
        // clicked, whatever the status says.
        url: if reachable { candidate } else { None },
        username: if reachable { username } else { None },
    })
}

/// The password, out of the deployment's own secrets file.
pub fn password_in(secrets: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(secrets)
        .ok()?
        .get("dbPassword")?
        .as_str()
        .map(|password| password.to_string())
}

/// Everything one connection needs, fetched at the moment it is wanted.
pub fn credentials(name: &str) -> Result<Credentials, String> {
    let exasol =
        find_exasol().ok_or_else(|| "The exasol command is not on this machine.".to_string())?;
    let listed = run(&exasol, &["deployments", "list", "--json"])?;
    let entries = match json_in(&listed) {
        Some(serde_json::Value::Array(entries)) => entries,
        _ => return Err("The exasol command did not list any deployments.".to_string()),
    };
    let entry = entries
        .iter()
        .find(|entry| entry.get("name").and_then(|value| value.as_str()) == Some(name))
        .ok_or_else(|| format!("There is no deployment called {name}."))?;
    let path = entry
        .get("path")
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("{name} does not say where it lives."))?;

    let info = run(&exasol, &["info", "-d", name, "--json"])?;
    let (url, username) = json_in(&info)
        .map(|info| address_in(&info))
        .unwrap_or((None, None));
    let url = url.ok_or_else(|| {
        format!("{name} did not report an address. Start it with \"exasol start -d {name}\".")
    })?;
    // Checked again rather than trusted from the list: between a row being drawn
    // and being clicked, a database can have stopped.
    if !accepts(&url) {
        return Err(format!(
            "Nothing answers at {url} any more. Start {name} with \"exasol start -d {name}\" and try again."
        ));
    }
    // And whose database it is, established now rather than remembered: the list
    // may be seconds old, and in those seconds a deployment can have been stopped
    // and another started on the same port. This is the check that makes a stale
    // list unable to open the wrong database.
    if let Some((host, _)) = address_of(&url) {
        if trust::is_loopback(&host) {
            let live = live_dirs_now();
            if !live.is_empty() && !live.contains(path) {
                return Err(format!(
                    "{name} has no process running in {path} any more, so {url} is somebody else's. Nothing was sent to it."
                ));
            }
        }
    }

    let secrets = Path::new(path).join("secrets.json");
    let password = std::fs::read_to_string(&secrets)
        .map_err(|problem| format!("could not read {}: {problem}", secrets.display()))
        .and_then(|text| {
            password_in(&text).ok_or_else(|| format!("{} holds no password.", secrets.display()))
        })?;

    Ok(Credentials {
        url,
        username: username.unwrap_or_else(|| "sys".to_string()),
        password,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const INFO: &str = r#"Using named deployment directory "default": /x/y
{
  "deploymentState": "running",
  "connection": { "host": "127.0.0.1", "dbPort": 58325, "username": "sys" }
}"#;

    #[test]
    fn finds_the_json_after_whatever_the_tool_said_first() {
        let parsed = json_in(INFO).expect("there is JSON in there");
        assert_eq!(parsed["connection"]["dbPort"], 58325);
    }

    #[test]
    fn reads_an_address_a_browser_could_open() {
        let (url, username) = address_in(&json_in(INFO).unwrap());
        assert_eq!(url.as_deref(), Some("wss://127.0.0.1:58325"));
        assert_eq!(username.as_deref(), Some("sys"));
    }

    #[test]
    fn has_no_address_for_a_deployment_that_did_not_report_one() {
        let (url, _) = address_in(&serde_json::json!({ "connection": { "host": "127.0.0.1" } }));
        assert_eq!(url, None);
        let (url, _) = address_in(&serde_json::json!({}));
        assert_eq!(url, None);
    }

    #[test]
    fn a_row_that_has_not_been_asked_about_is_not_connectable() {
        let entry = serde_json::json!({ "name": "default", "infrastructure": "local", "status": "running" });
        let row = unchecked_entry(&entry).expect("a name is all it takes");
        assert_eq!(row.name, "default");
        assert_eq!(row.infrastructure, "local");
        // Not `running`, whatever the list said, and no address: this row exists to
        // be looked at while the real answer is being fetched.
        assert_eq!(row.status, "checking");
        assert_eq!(row.url, None);
    }

    #[test]
    fn reads_a_status_and_the_sentence_that_goes_with_it() {
        let (status, message) = status_in(
            "{\"deploymentDir\":\"/x\",\"status\":\"stopped\",\"message\":\"Deployment stopped.\"}",
        );
        assert_eq!(status, "stopped");
        assert_eq!(message.as_deref(), Some("Deployment stopped."));
    }

    #[test]
    fn a_status_that_cannot_be_read_is_not_a_status() {
        let (status, message) = status_in("the launcher said something else entirely");
        assert_eq!(status, "unknown");
        assert_eq!(message, None);
    }

    fn ready_at(name: &str, url: &str) -> Deployment {
        Deployment {
            name: name.to_string(),
            status: "database_ready".to_string(),
            message: None,
            infrastructure: "local".to_string(),
            path: format!("/deployments/{name}"),
            url: Some(url.to_string()),
            username: Some("sys".to_string()),
        }
    }

    /// Nothing is running, which is where this started.
    fn nothing_live() -> HashSet<String> {
        HashSet::new()
    }

    fn live(paths: &[&str]) -> HashSet<String> {
        paths.iter().map(|path| (*path).to_string()).collect()
    }

    #[test]
    fn reads_a_socket_address_back_out_of_a_url() {
        assert_eq!(
            address_of("wss://127.0.0.1:8563"),
            Some(("127.0.0.1".to_string(), 8563))
        );
        assert_eq!(
            address_of("ws://db.internal:1234/path"),
            Some(("db.internal".to_string(), 1234))
        );
        assert_eq!(address_of("wss://nowhere"), None);
        assert_eq!(address_of("https://x:1"), None);
        assert_eq!(address_of("wss://:8563"), None);
        assert_eq!(address_of("wss://x:not-a-port"), None);
    }

    #[test]
    fn nothing_accepts_at_an_address_that_is_not_one() {
        assert!(!accepts("not a url"));
        // Port 1 on loopback, which nothing is allowed to bind without privileges
        // and nothing here does.
        assert!(!accepts("wss://127.0.0.1:1"));
    }

    /// The failure this test exists for was a real morning: a deployment's
    /// forwarder lost its route to the VM it forwards to, went on accepting every
    /// connection on `127.0.0.1:8563`, and reset each one the moment TLS started.
    /// The database behind it was healthy the whole time. A socket test called
    /// that ready, so the dialog offered a deployment that could not be opened.
    #[test]
    fn a_socket_that_accepts_and_says_nothing_is_not_a_database() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let port = listener.local_addr().expect("an address").port();
        // Exactly what a forwarder with nowhere to forward to does: take the
        // connection, then drop it without a word.
        let accepting = std::thread::spawn(move || {
            for connection in listener.incoming().take(1) {
                drop(connection);
            }
        });
        assert!(!accepts(&format!("wss://127.0.0.1:{port}")));
        let _ = accepting.join();
    }

    #[test]
    fn finds_the_deployments_a_process_is_working_in() {
        // The shape `lsof -Fn` prints, and the shape the local runner's paths take.
        let printed = "p91957\nn/Users/x/.exasol/personal/deployments/default/local/runtime\np4\nn/Users/x/.exasol/personal/deployments/ailab/local/runtime\nn/usr/lib/something\n";
        let found = deployment_dirs_in(printed);
        assert!(found.contains("/Users/x/.exasol/personal/deployments/default"));
        assert!(found.contains("/Users/x/.exasol/personal/deployments/ailab"));
        assert_eq!(found.len(), 2);
        // Nothing to go on.
        assert!(deployment_dirs_in("n/usr/lib/something\n").is_empty());
        assert!(deployment_dirs_in("").is_empty());
        // A path that ends at the marker names no deployment.
        assert!(deployment_dirs_in("n/x/deployments/").is_empty());
    }

    #[test]
    fn offers_the_one_that_holds_the_port_and_explains_the_others() {
        let flagged = flag_conflicts(
            vec![
                ready_at("ailab", "wss://127.0.0.1:8563"),
                ready_at("default", "wss://127.0.0.1:8563"),
            ],
            // The machine says a process is working in default's directory.
            &live(&["/deployments/default"]),
        );
        let live = flagged.iter().find(|d| d.name == "default").unwrap();
        assert_eq!(live.status, "database_ready");
        assert_eq!(live.url.as_deref(), Some("wss://127.0.0.1:8563"));

        let other = flagged.iter().find(|d| d.name == "ailab").unwrap();
        assert_eq!(other.status, "port_taken");
        assert_eq!(other.url, None);
        let said = other.message.as_deref().unwrap();
        assert!(said.contains("belongs to default"), "{said}");
    }

    #[test]
    fn refuses_two_deployments_that_claim_one_address() {
        let flagged = flag_conflicts(
            vec![
                ready_at("ailab", "wss://127.0.0.1:8563"),
                ready_at("default", "wss://127.0.0.1:8563"),
                ready_at("fusion", "wss://127.0.0.1:55021"),
            ],
            &nothing_live(),
        );
        // Neither of the two is offered: which one is real cannot be known from
        // here, and opening the wrong database under the right name is the worst
        // outcome available.
        for name in ["ailab", "default"] {
            let one = flagged
                .iter()
                .find(|d| d.name == name)
                .expect("still listed");
            assert_eq!(one.status, "address_conflict");
            // No address is what makes it unclickable; the status is the reason.
            assert_eq!(one.url, None);
            let said = one.message.as_deref().expect("a reason");
            assert!(said.contains("8563"), "{said}");
        }
        // And the one with an address of its own is left alone.
        let alone = flagged
            .iter()
            .find(|d| d.name == "fusion")
            .expect("still listed");
        assert_eq!(alone.status, "database_ready");
        assert_eq!(alone.url.as_deref(), Some("wss://127.0.0.1:55021"));
    }

    #[test]
    fn refuses_both_when_two_live_processes_claim_one_address() {
        // Two processes working in two directories, one address: still not
        // something to guess about.
        let flagged = flag_conflicts(
            vec![
                ready_at("ailab", "wss://127.0.0.1:8563"),
                ready_at("default", "wss://127.0.0.1:8563"),
            ],
            &live(&["/deployments/ailab", "/deployments/default"]),
        );
        assert!(flagged.iter().all(|one| one.status == "address_conflict"));
        assert!(flagged.iter().all(|one| one.url.is_none()));
    }

    #[test]
    fn names_the_other_claimant_so_it_can_be_stopped() {
        let flagged = flag_conflicts(
            vec![
                ready_at("ailab", "wss://127.0.0.1:8563"),
                ready_at("default", "wss://127.0.0.1:8563"),
            ],
            &nothing_live(),
        );
        let said = flagged[0].message.as_deref().unwrap();
        assert!(said.contains("default"), "{said}");
        assert!(said.contains("exasol stop -d default"), "{said}");
    }

    #[test]
    fn leaves_alone_a_list_where_nothing_collides() {
        let one = vec![ready_at("default", "wss://127.0.0.1:8563")];
        assert_eq!(
            flag_conflicts(one, &nothing_live()),
            vec![ready_at("default", "wss://127.0.0.1:8563")]
        );
        // Two that are not running share "no address", which is not a collision.
        let none = flag_conflicts(
            vec![
                Deployment {
                    url: None,
                    ..ready_at("a", "x")
                },
                Deployment {
                    url: None,
                    ..ready_at("b", "y")
                },
            ],
            &nothing_live(),
        );
        assert!(none.iter().all(|d| d.status == "database_ready"));
    }

    #[test]
    fn reads_the_password_out_of_a_secrets_file() {
        assert_eq!(
            password_in("{\"dbPassword\":\"hunter2\"}").as_deref(),
            Some("hunter2")
        );
        assert_eq!(password_in("{\"other\":1}"), None);
        assert_eq!(password_in("not json"), None);
    }

    #[test]
    fn a_list_with_no_cli_is_empty_rather_than_an_error() {
        // The dialog asks unconditionally; a machine without Exasol Personal
        // should simply not be offered anything.
        assert!(json_in("not json at all").is_none());
    }

    /// Not part of the suite: it runs the real CLI against the real deployments on
    /// this machine.
    ///
    /// `cargo test -- --ignored` on a machine with Exasol Personal installed. What
    /// it proves is the part no unit test can: that the commands are the right
    /// ones, that their output parses, and that a deployment's password is where
    /// this thinks it is.
    #[test]
    #[ignore]
    fn lists_and_reads_the_deployments_on_this_machine() {
        let quick = local(Detail::Names);
        assert!(quick.installed, "the exasol command was not found");
        assert!(
            quick.deployments.iter().all(|one| one.url.is_none()),
            "the unchecked list offered an address it had not verified"
        );
        let found = local(Detail::Described).deployments;
        assert!(!found.is_empty(), "no deployments were listed");
        for deployment in &found {
            println!(
                "  {:14} {:24} {}",
                deployment.name,
                deployment.status,
                deployment.url.as_deref().unwrap_or("(no address)")
            );
        }
        // The invariant is about the *socket*, not about what the tool called it:
        // readiness is decided by whether a connection is accepted, so a row with
        // an address must be one that answers, and `database_ready` is neither
        // necessary (the status call may have timed out) nor sufficient (it says
        // that about deployments whose port belongs to somebody else).
        let addresses: Vec<&str> = found.iter().filter_map(|one| one.url.as_deref()).collect();
        let mut unique = addresses.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(
            addresses.len(),
            unique.len(),
            "two deployments were offered at the same address"
        );
        // Whether *any* deployment is connectable depends on what is running on
        // this machine right now, so it is not asserted. What is asserted are the
        // two invariants: an offered row is one something answered at, and no two
        // rows are offered at one address (checked above).
        for deployment in &found {
            if let Some(url) = deployment.url.as_deref() {
                assert!(url.starts_with("wss://"), "{url} is not a database URL");
                assert!(
                    accepts(url),
                    "{} was offered at {url} and nothing answers",
                    deployment.name
                );
                assert!(
                    !matches!(deployment.status.as_str(), "checking" | "unreachable"),
                    "{} is offered and called {}",
                    deployment.name,
                    deployment.status
                );
            }
        }

        match found.iter().find(|deployment| deployment.url.is_some()) {
            None => println!("  (nothing connectable on this machine right now)"),
            Some(open) => {
                let credentials = credentials(&open.name).expect("credentials for a live one");
                assert_eq!(credentials.url, open.url.as_deref().unwrap());
                assert!(!credentials.username.is_empty());
                assert!(
                    !credentials.password.is_empty(),
                    "no password was read for {}",
                    open.name
                );
                println!(
                    "  {} ({}) at {} as {}",
                    open.name, open.infrastructure, credentials.url, credentials.username
                );
            }
        }

        println!("{} deployment(s) listed", found.len());
        assert!(
            found.iter().all(|one| !one.infrastructure.is_empty()),
            "a deployment should say where it is deployed"
        );
    }
}
