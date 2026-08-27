//! The agent endpoint, inside the application.
//!
//! On a development server this is a Vite plugin (`packages/mcp`). An installed
//! application has no development server, so it carries the endpoint itself — and
//! carries as little of it as possible: **this file knows nothing about the Model
//! Context Protocol.** It accepts a message, hands it to the window, and returns
//! whatever the window said. The catalogue, the handshake, the tools and what they
//! mean all live in the page, in TypeScript, in one copy, tested (see
//! `packages/mcp/src/answer.ts`).
//!
//! That is the whole design, and it is the same reason the development server owns
//! no state: every answer an agent gets has to come from the session a person is
//! looking at, or an agent and a person are looking at two different things.
//!
//! Three ways in, all on the loopback interface:
//!
//! - `POST /agent/mcp` — one protocol message, one answer. Needs the token.
//! - `GET  /agent/health` — is anybody home. No token, and nothing sensitive.
//! - the page's own IPC, which is how answers come back.
//!
//! `tiny_http` rather than a hand-written parser: the endpoint is talked to by
//! clients this repository did not write, and chunked bodies and keep-alive are
//! more to get right than they are to depend on.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};
use tiny_http::{Header, Response, Server};

use crate::session::{self, endpoint_url, now_seconds, Session};

/// Where the endpoint prefers to be. A number worth keeping stable: it ends up in
/// nothing the user has to know, but it makes `curl` and a bug report easy.
pub const PREFERRED_PORT: u16 = 7355;

/// How many ports to try before giving up. A second window is the ordinary reason
/// the first is taken.
const PORT_ATTEMPTS: u16 = 20;

/// How long a call may take before the agent is told it did not answer. Opening a
/// relation talks to a database, so this is generous — and it matches the
/// development server's `CallRouter`, because an agent should not be able to tell
/// the two apart.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a call may wait for a window that is on its way.
///
/// The endpoint binds its port in `setup`, before the page has loaded — so for a
/// second or so after launch there is an address that answers and nothing behind
/// it. A client that was started by an agent will call in exactly that second.
/// Refusing then would be technically true and useless, so a call waits, and only
/// says nobody is home if nobody arrives.
const ATTACH_GRACE: Duration = Duration::from_secs(15);

/// What the shell asks the window to answer.
#[derive(Clone, serde::Serialize)]
struct AgentRequest {
    id: u64,
    body: String,
}

/// What the settings panel shows. Named as the page names it; the tool list is
/// added there, because the page is what knows the tools.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    attached: usize,
    calls: u64,
    last_call_at: Option<u64>,
    mcp_url: String,
    port: u16,
}

impl AgentStatus {
    /// Where an agent speaks to this window, for whoever is telling a client about
    /// it.
    pub fn mcp_url(&self) -> String {
        self.mcp_url.clone()
    }
}

/// Calls in flight, and nothing else.
///
/// The one piece of state here is about the conversation rather than about the
/// document: which messages have gone to the window and not come back.
pub struct AgentState {
    /// When this process began, so the log can say how long the window took to
    /// come up and how long the page took to be ready. Instantness is a
    /// requirement, and a requirement nobody measures is a wish.
    pub started: std::time::Instant,
    pending: Mutex<HashMap<u64, Sender<Option<String>>>>,
    next_id: AtomicU64,
    calls: AtomicU64,
    last_call_at: AtomicU64,
    attached: AtomicUsize,
    port: Mutex<u16>,
    token: String,
}

impl AgentState {
    pub fn new(token: String) -> Self {
        Self {
            started: std::time::Instant::now(),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            calls: AtomicU64::new(0),
            last_call_at: AtomicU64::new(0),
            attached: AtomicUsize::new(0),
            port: Mutex::new(0),
            token,
        }
    }

    pub fn port(&self) -> u16 {
        *self.port.lock().expect("port")
    }

    pub fn status(&self) -> AgentStatus {
        let last = self.last_call_at.load(Ordering::Relaxed);
        AgentStatus {
            attached: self.attached.load(Ordering::Relaxed),
            calls: self.calls.load(Ordering::Relaxed),
            last_call_at: if last == 0 { None } else { Some(last) },
            mcp_url: endpoint_url(self.port()),
            port: self.port(),
        }
    }

    /// Waits for a window to be listening, for as long as one might be starting.
    fn await_window(&self) -> Result<(), String> {
        let deadline = std::time::Instant::now() + ATTACH_GRACE;
        while self.attached.load(Ordering::Relaxed) == 0 {
            if std::time::Instant::now() >= deadline {
                return Err(format!(
                    "No Panorama window attached within {}s. The application may have failed to start.",
                    ATTACH_GRACE.as_secs()
                ));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(())
    }

    /// Sends a message to the window and waits for the answer.
    ///
    /// `Err` is a sentence for the agent to read, never a panic: the caller turns
    /// it into a protocol error, and an agent that asked too early should be told
    /// what to do about it.
    fn ask_window(&self, app: &AppHandle, body: String) -> Result<Option<String>, String> {
        self.await_window()?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = channel();
        self.pending.lock().expect("pending").insert(id, sender);
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.last_call_at.store(now_seconds(), Ordering::Relaxed);

        let sent = app.emit("panorama://agent-request", AgentRequest { id, body });
        if let Err(problem) = sent {
            self.pending.lock().expect("pending").remove(&id);
            return Err(format!("The window could not be reached: {problem}"));
        }

        let answer = receiver.recv_timeout(CALL_TIMEOUT);
        // Dropped whatever happened: a timed-out call that answers later has
        // nobody waiting, and its entry would otherwise be held for the life of
        // the process.
        self.pending.lock().expect("pending").remove(&id);
        answer.map_err(|_| {
            format!(
                "Panorama did not answer within {}s.",
                CALL_TIMEOUT.as_secs()
            )
        })
    }
}

/// The page, announcing that it is listening.
#[tauri::command]
pub fn agent_attach(state: State<'_, Arc<AgentState>>) {
    let before = state.attached.fetch_add(1, Ordering::Relaxed);
    if before == 0 {
        eprintln!(
            "[panorama] page ready {}ms after launch",
            state.started.elapsed().as_millis()
        );
    }
}

/// And going away — a reload, or a window closing.
#[tauri::command]
pub fn agent_detach(state: State<'_, Arc<AgentState>>) {
    let _ = state
        .attached
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |attached| {
            Some(attached.saturating_sub(1))
        });
}

/// An answer on its way back out.
///
/// `body: None` is a notification the page had nothing to say about, which is a
/// 202 on the way out rather than an empty answer.
#[tauri::command]
pub fn agent_reply(state: State<'_, Arc<AgentState>>, id: u64, body: Option<String>) {
    let waiting = state.pending.lock().expect("pending").remove(&id);
    if let Some(sender) = waiting {
        // A closed channel means the call timed out and stopped listening. The
        // page was doing as it was told, just slowly, and there is nobody to tell.
        let _ = sender.send(body);
    }
}

/// What the settings panel reads.
#[tauri::command]
pub fn agent_status(state: State<'_, Arc<AgentState>>) -> AgentStatus {
    state.status()
}

fn json(status: u16, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("a literal header");
    Response::from_string(body)
        .with_status_code(status)
        .with_header(header)
}

/// A JSON-RPC error, for the cases the protocol never reaches the page to answer.
fn protocol_error(message: &str) -> String {
    let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{{\"code\":-32603,\"message\":\"{escaped}\"}}}}"
    )
}

/// Whether a request may be answered at all.
///
/// Two guards, and the second is the one that matters. A browser cannot omit
/// `Origin`, and a page on some other origin cannot forge it — so refusing every
/// origin that is not this application's own keeps a web page from driving
/// somebody's database session, whatever a browser decides to permit next. The
/// token then keeps out other programs on this machine, which have no such
/// restriction.
pub fn origin_allowed(origin: Option<&str>) -> bool {
    match origin {
        None => true,
        Some(origin) => {
            origin == "tauri://localhost"
                || origin == "http://tauri.localhost"
                || origin.starts_with("http://localhost:")
                || origin.starts_with("http://127.0.0.1:")
        }
    }
}

/// The token as sent: a bearer header, or a query string for a client that can
/// only be given a URL.
pub fn token_from(authorization: Option<&str>, url: &str) -> Option<String> {
    if let Some(header) = authorization {
        if let Some(bearer) = header.strip_prefix("Bearer ") {
            return Some(bearer.trim().to_string());
        }
    }
    let query = url.split_once('?')?.1;
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix("token="))
        .map(|token| token.to_string())
}

pub fn path_of(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

/// Binds the endpoint, writes the session down, and serves until the process ends.
///
/// Called from `setup`, so a failure here must not stop the application from
/// opening: a window with no agent is a worse Panorama, and a Panorama that
/// refuses to start because a port was busy is not one at all.
pub fn start(app: &AppHandle, state: Arc<AgentState>) -> Result<u16, String> {
    let mut bound = None;
    for offset in 0..PORT_ATTEMPTS {
        let port = PREFERRED_PORT + offset;
        if let Ok(server) = Server::http(("127.0.0.1", port)) {
            bound = Some((server, port));
            break;
        }
    }
    let (server, port) = bound.ok_or_else(|| {
        format!(
            "no free port in {PREFERRED_PORT}..{}",
            PREFERRED_PORT + PORT_ATTEMPTS
        )
    })?;
    *state.port.lock().expect("port") = port;

    let session = Session {
        pid: std::process::id(),
        port,
        token: state.token.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        started: now_seconds(),
    };
    session::write(&session)
        .map_err(|problem| format!("could not write the session file: {problem}"))?;

    let handle = app.clone();
    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let handle = handle.clone();
            let state = Arc::clone(&state);
            // A thread each, because a call may take as long as a database does
            // and a health check should not wait behind one.
            std::thread::spawn(move || {
                let url = request.url().to_string();
                let method = request.method().as_str().to_string();
                let origin = header(&request, "origin");
                let authorization = header(&request, "authorization");

                if !origin_allowed(origin.as_deref()) {
                    let _ = request.respond(json(
                        403,
                        &protocol_error("This endpoint does not answer other origins."),
                    ));
                    return;
                }

                match (method.as_str(), path_of(&url)) {
                    ("GET", "/agent/health") => {
                        let status = state.status();
                        let body = format!(
                            "{{\"server\":\"panorama-desktop\",\"attached\":{},\"calls\":{},\"mcpUrl\":\"{}\"}}",
                            status.attached, status.calls, status.mcp_url
                        );
                        let _ = request.respond(json(200, &body));
                    }
                    ("POST", "/agent/mcp") => {
                        if token_from(authorization.as_deref(), &url).as_deref()
                            != Some(state.token.as_str())
                        {
                            let _ = request.respond(json(401, &protocol_error(
                                "This endpoint needs the token from the session file in ~/.panorama/sessions.",
                            )));
                            return;
                        }
                        let mut body = String::new();
                        if request.as_reader().read_to_string(&mut body).is_err() {
                            let _ = request
                                .respond(json(400, &protocol_error("That message was not text.")));
                            return;
                        }
                        match state.ask_window(&handle, body) {
                            // A notification: accepted, nothing to say.
                            Ok(None) => {
                                let _ = request.respond(Response::empty(202));
                            }
                            Ok(Some(answer)) => {
                                let _ = request.respond(json(200, &answer));
                            }
                            Err(problem) => {
                                let _ = request.respond(json(503, &protocol_error(&problem)));
                            }
                        }
                    }
                    ("POST", _) | ("GET", _) => {
                        let _ = request.respond(json(404, &protocol_error("No such route.")));
                    }
                    _ => {
                        let _ = request.respond(json(
                            405,
                            &protocol_error("POST a JSON-RPC message to /agent/mcp."),
                        ));
                    }
                }
            });
        }
    });

    Ok(port)
}

fn header(request: &tiny_http::Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        // Compared rather than `equiv`, which wants a name that outlives the
        // program; header names are case-insensitive.
        .find(|header| header.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_its_own_window_and_nothing_else() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("tauri://localhost")));
        assert!(origin_allowed(Some("http://tauri.localhost")));
        assert!(origin_allowed(Some("http://localhost:5173")));
        assert!(!origin_allowed(Some("https://example.com")));
        // The case worth naming: a page that has been allowed to reach a local
        // address still arrives with its own origin, and is still refused.
        assert!(!origin_allowed(Some("https://panorama.pages.dev")));
    }

    #[test]
    fn takes_the_token_from_a_header_or_a_url() {
        assert_eq!(
            token_from(Some("Bearer abc"), "/agent/mcp").as_deref(),
            Some("abc")
        );
        assert_eq!(
            token_from(None, "/agent/mcp?token=xyz").as_deref(),
            Some("xyz")
        );
        // A header wins, because a URL is the one that ends up in a log.
        assert_eq!(
            token_from(Some("Bearer abc"), "/agent/mcp?token=xyz").as_deref(),
            Some("abc")
        );
        assert_eq!(token_from(None, "/agent/mcp"), None);
        assert_eq!(token_from(Some("Basic abc"), "/agent/mcp"), None);
    }

    #[test]
    fn reads_the_path_without_the_query() {
        assert_eq!(path_of("/agent/mcp?token=1"), "/agent/mcp");
        assert_eq!(path_of("/agent/health"), "/agent/health");
    }

    #[test]
    fn refuses_a_call_with_no_window_attached() {
        let state = AgentState::new("t".to_string());
        assert_eq!(state.status().attached, 0);
    }

    #[test]
    fn escapes_a_message_that_would_break_the_json() {
        let body = protocol_error("she said \"no\" and \\ left");
        assert!(body.contains("\\\"no\\\""));
        assert!(body.contains("\\\\ left"));
    }
}
