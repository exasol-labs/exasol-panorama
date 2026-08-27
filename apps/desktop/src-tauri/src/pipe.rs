//! The same binary, as a pipe.
//!
//! Every agent client speaks stdio, so `--mcp-stdio` makes this executable one:
//! a line of JSON-RPC in, a line out, and in between a POST to whichever window
//! is running. Which means the thing a user installs and the thing they paste into
//! `claude mcp add` are the same file, and there is no port, no Node and no second
//! install anywhere in it.
//!
//!     claude mcp add panorama -- "/Applications/Exasol Panorama.app/Contents/MacOS/panorama-desktop" --mcp-stdio
//!
//! Two behaviours are worth knowing about, because both were failures first.
//!
//! **A client asks what the tools are the moment it starts.** Launching a window
//! because somebody opened a terminal is not acceptable, so the handshake and the
//! tool list are answered from what this pipe saw last time — a *menu*, not a
//! document: it says what may be called, never what is on the canvas. A call for
//! anything else opens the application and waits for it.
//!
//! **A client fetches the tool list once and then shows what it fetched.** So when
//! the catalogue moves, the client is told to list again.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::session::{self, Session};

/// How long to wait for a window this pipe started to say where it is.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Anything that is not the protocol goes here: stdout is the conversation, and a
/// stray line on it would break it.
fn note(message: &str) {
    eprintln!("[panorama] {message}");
}

fn failure(id: &serde_json::Value, message: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32603, "message": message },
    })
    .to_string()
}

/// The remembered catalogue: the handshake and the tool list, as last answered.
fn memory_path() -> PathBuf {
    session::sessions_dir()
        .parent()
        .map(|dir| dir.join("catalogue.json"))
        .unwrap_or_else(|| PathBuf::from("catalogue.json"))
}

fn remembered(method: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(memory_path()).ok()?;
    let stored: serde_json::Value = serde_json::from_str(&text).ok()?;
    stored.get(method).cloned()
}

/// Remembers a `result`, keyed by the method that produced it. Only ever the two
/// that describe the interface itself.
fn remember(method: &str, result: &serde_json::Value) {
    let path = memory_path();
    let mut stored = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(object) = stored.as_object_mut() {
        object.insert(method.to_string(), result.clone());
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, stored.to_string());
}

/// One POST to the window, with the body as given.
fn post(session: &Session, body: &str) -> Result<(u16, String), String> {
    // Written by hand rather than with an HTTP client: both ends of this are in
    // this repository, the body is one JSON value, and `Connection: close` makes
    // the answer end at end of stream. `session.endpoint()` is the same address in
    // words, for a note or a bug report.
    let mut stream = TcpStream::connect(("127.0.0.1", session.port)).map_err(|problem| {
        format!(
            "could not reach the window on port {}: {problem}",
            session.port
        )
    })?;
    // `Connection: close` so the answer ends at end of stream, which is the whole
    // of the response parsing on this side.
    let request = format!(
        "POST /agent/mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        session.port,
        session.token,
        body.len(),
        body
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|problem| format!("could not send the message: {problem}"))?;
    let mut answer = String::new();
    stream
        .read_to_string(&mut answer)
        .map_err(|problem| format!("could not read the answer: {problem}"))?;
    let (head, payload) = answer
        .split_once("\r\n\r\n")
        .ok_or_else(|| "the window answered something that was not a response".to_string())?;
    let status =
        status_of(head).ok_or_else(|| "the window answered without a status".to_string())?;
    Ok((status, payload.to_string()))
}

/// `HTTP/1.1 200 OK` -> 200.
pub fn status_of(head: &str) -> Option<u16> {
    head.lines().next()?.split_whitespace().nth(1)?.parse().ok()
}

/// The application, as something that can be started.
///
/// The executable directly, rather than `open -a` on the bundle. `open` hands the
/// launch to the window server, which starts the application with a *login*
/// environment rather than this one — so anything this process was told, including
/// where to keep its session file, would not reach the window it started. A
/// bundled executable run directly still gets its icon and its menu, because the
/// bundle is around it either way.
fn launch() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|problem| problem.to_string())?;
    std::process::Command::new(&exe)
        // The window is not part of this conversation. Left inherited, it would
        // hold this pipe's stdout open after the pipe had exited — and a client
        // waiting for the stream to end would wait for as long as somebody left
        // the application open.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|problem| format!("could not start Panorama: {problem}"))
}

/// A window to talk to: the newest running one, or a new one.
fn window(launching: bool) -> Result<Session, String> {
    if let Some(session) = session::live().into_iter().next() {
        return Ok(session);
    }
    if !launching {
        return Err("Panorama is not running.".to_string());
    }
    note("no window running; starting Panorama");
    launch()?;
    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(session) = session::live().into_iter().next() {
            return Ok(session);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("Panorama was started but did not report a session in time.".to_string())
}

/// Whether this message can be answered without opening a window.
fn describes_the_interface(method: &str) -> bool {
    method == "initialize" || method == "tools/list"
}

/// One message in, at most one line out.
fn answer(line: &str, stamp: &mut Option<String>) -> Option<String> {
    let parsed: serde_json::Value = match serde_json::from_str(line) {
        Ok(value) => value,
        // Malformed input is the page's to complain about in its own words, but it
        // cannot be reached without a window, so this is the one thing answered
        // here.
        Err(problem) => {
            return Some(failure(
                &serde_json::Value::Null,
                &format!("that was not JSON-RPC: {problem}"),
            ))
        }
    };
    let id = parsed.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let method = parsed
        .get("method")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let notification = parsed.get("id").is_none();

    // The newest window that says it is running — and then *proved* by talking to
    // it. A pid is not proof: a window killed by whatever started it can be left
    // as a zombie, which still answers "yes, that process exists", and a pid is
    // eventually reused by something else entirely. So a session that cannot be
    // reached is forgotten here, and this message goes on as if none had been
    // found. Which is how a crash, a kill and a stale file all become the same
    // ordinary case.
    if let Some(session) = session::live().into_iter().next() {
        match post(&session, line) {
            Ok(answer) => return finish(&method, &id, answer, stamp),
            Err(problem) => {
                note(&format!("{problem}; forgetting that window"));
                session::remove(session.pid);
            }
        }
    }

    // Nothing running, and a question about the interface rather than about the
    // canvas: answer from memory rather than opening a window nobody asked for.
    if describes_the_interface(&method) {
        if let Some(result) = remembered(&method) {
            note(&format!(
                "{method} answered from the last catalogue seen; no window opened"
            ));
            return Some(
                serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string(),
            );
        }
    }

    match window(true).and_then(|session| post(&session, line)) {
        Ok(answer) => finish(&method, &id, answer, stamp),
        Err(problem) => {
            if notification {
                note(&problem);
                None
            } else {
                Some(failure(&id, &problem))
            }
        }
    }
}

/// What to do with an answer the window gave: remember it if it describes the
/// interface, watch the stamp, and pass it on. A 202 is a notification the window
/// accepted and had nothing to say about.
fn finish(
    method: &str,
    id: &serde_json::Value,
    answer: (u16, String),
    stamp: &mut Option<String>,
) -> Option<String> {
    let (status, payload) = answer;
    if status == 202 {
        return None;
    }
    if status == 200 {
        remember_if_useful(method, &payload);
        watch_stamp(&payload, stamp);
        return Some(payload.trim().to_string());
    }
    // A failure carries the shell's own wording, which is already a JSON-RPC
    // error — but the shell does not read the messages it carries, so it could not
    // say which one this answers. This pipe can, and a client that matches ids
    // would otherwise drop the explanation on the floor.
    Some(with_id(payload.trim(), id))
}

fn with_id(payload: &str, id: &serde_json::Value) -> String {
    match serde_json::from_str::<serde_json::Value>(payload) {
        Ok(mut value) if value.get("id") == Some(&serde_json::Value::Null) => {
            if let Some(object) = value.as_object_mut() {
                object.insert("id".to_string(), id.clone());
            }
            value.to_string()
        }
        _ => payload.to_string(),
    }
}

fn remember_if_useful(method: &str, payload: &str) {
    if !describes_the_interface(method) {
        return;
    }
    if let Some(result) = serde_json::from_str::<serde_json::Value>(payload)
        .ok()
        .and_then(|value| value.get("result").cloned())
    {
        remember(method, &result);
    }
}

/// The catalogue stamp, watched for movement.
///
/// A client that connected to an older catalogue — or to nothing at all, which
/// looks the same to it — keeps showing the list it fetched. When the stamp moves,
/// say so, and a client that honours the notification lists again.
fn watch_stamp(payload: &str, stamp: &mut Option<String>) -> Option<()> {
    let current = serde_json::from_str::<serde_json::Value>(payload)
        .ok()?
        .get("result")?
        .get("serverInfo")?
        .get("version")?
        .as_str()?
        .to_string();
    let previous = stamp.replace(current.clone());
    if previous.as_deref() == Some(current.as_str()) || previous.is_none() {
        return None;
    }
    note(&format!(
        "catalogue changed: {} -> {current}; telling the client to list again",
        previous.unwrap_or_else(|| "nothing".to_string())
    ));
    let mut out = std::io::stdout();
    let _ = writeln!(
        out,
        "{}",
        serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" })
    );
    let _ = out.flush();
    Some(())
}

/// Reads the conversation until it ends.
pub fn run() -> ! {
    match session::live().into_iter().next() {
        Some(session) => note(&format!(
            "ready; a window is open at {}",
            session.endpoint()
        )),
        None => note("ready; no window open yet, and a call will start one"),
    }
    let mut stamp: Option<String> = None;
    let input = BufReader::new(std::io::stdin());
    for line in input.lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(reply) = answer(trimmed, &mut stamp) {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{reply}");
            let _ = out.flush();
        }
    }
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn puts_the_clients_id_back_on_an_error_the_shell_could_not_attribute() {
        let repaired = with_id(
            "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"no\"}}",
            &serde_json::json!(7),
        );
        assert!(repaired.contains("\"id\":7"));
        // An answer that already knows which message it belongs to is left alone.
        let already = with_id(
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{}}",
            &serde_json::json!(7),
        );
        assert!(already.contains("\"id\":3"));
        // And something that is not JSON is passed on as it came.
        assert_eq!(with_id("not json", &serde_json::json!(7)), "not json");
    }

    #[test]
    fn reads_a_status_line() {
        assert_eq!(status_of("HTTP/1.1 200 OK\r\nContent-Length: 2"), Some(200));
        assert_eq!(status_of("HTTP/1.1 503 Service Unavailable"), Some(503));
        assert_eq!(status_of("nonsense"), None);
    }

    #[test]
    fn knows_which_questions_are_about_the_interface() {
        assert!(describes_the_interface("initialize"));
        assert!(describes_the_interface("tools/list"));
        // A call is about the canvas, and the canvas only exists in a window.
        assert!(!describes_the_interface("tools/call"));
    }

    #[test]
    fn answers_malformed_input_itself() {
        let mut stamp = None;
        let reply = answer("{not json", &mut stamp).expect("a client is waiting for something");
        assert!(reply.contains("not JSON-RPC"));
    }

    #[test]
    fn remembers_a_catalogue_and_reads_it_back() {
        session::with_own_session_dir("pipe", || {
            remember(
                "tools/list",
                &serde_json::json!({ "tools": [{ "name": "skill" }] }),
            );
            let read = remembered("tools/list").expect("just written");
            assert_eq!(read["tools"][0]["name"], "skill");
            assert!(remembered("initialize").is_none());
        });
    }
}
