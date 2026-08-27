//! The database socket, opened out here where TLS is ours to decide about.
//!
//! This is the one thing a desktop shell genuinely buys, and the reason it can be
//! this small. The page keeps the whole Exasol driver — login with real RSA
//! password encryption, result sets, positional fetches, every message; nothing
//! about the database protocol is in this file. What is here is a socket: the page
//! connects to a WebSocket on loopback, this connects onward to the database, and
//! bytes are handed across. The only decision in the middle is whether the
//! certificate on the far end is acceptable, and that is `trust.rs`.
//!
//! Two consequences worth being explicit about.
//!
//! **A frame is forwarded, not read.** Credentials pass through this process
//! encrypted by the page against the key the database offered — the proxy could
//! not read them if it wanted to, which is the same guarantee the browser gives.
//!
//! **The proxy is not a hole in the machine.** It is bound to loopback; a
//! handshake carrying an `Origin` that is not this application's own is refused
//! (the header a web page cannot forge); and it needs the token this application
//! generated at startup, which only its own window is given.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::Uri;
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::trust::{self, Trust};

/// Where the database proxy prefers to be: beside the agent endpoint, one above.
pub const PREFERRED_PORT: u16 = 7356;
const PORT_ATTEMPTS: u16 = 20;

/// What the page is told to connect to.
pub struct Proxy {
    pub port: u16,
    pub token: String,
}

impl Proxy {
    /// The URL the page opens, with the token in it. It appends `&target=`.
    pub fn url(&self) -> String {
        format!("ws://127.0.0.1:{}/database?token={}", self.port, self.token)
    }
}

/// Everything a handshake has to carry, taken off the request line.
#[derive(Debug, PartialEq, Eq)]
pub struct Asked {
    pub token: String,
    pub target: String,
}

/// Reads the query string. Both parameters are required; anything else is
/// ignored, because a URL is a thing other software adds to.
pub fn parse_asked(uri: &str) -> Option<Asked> {
    let query = uri.split_once('?')?.1;
    let mut token = None;
    let mut target = None;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=')?;
        match name {
            "token" => token = Some(decode(value)),
            "target" => target = Some(decode(value)),
            _ => {}
        }
    }
    Some(Asked {
        token: token?,
        target: target?,
    })
}

/// Percent-decoding, for the target URL. Written out because it is four lines and
/// the alternative is a dependency that also parses forms and multipart bodies.
fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Where a target says to connect, and whether to do it over TLS.
#[derive(Debug, PartialEq, Eq)]
pub struct Destination {
    pub tls: bool,
    pub host: String,
    pub port: u16,
    /// `host:port`, which is what a trust decision is remembered against.
    pub authority: String,
}

/// Reads the address out of a `wss://host:port` — and refuses anything that is
/// not one, because this opens a socket to wherever it is told.
pub fn parse_destination(target: &str) -> Result<Destination, String> {
    let uri: Uri = target
        .parse()
        .map_err(|_| format!("{target} is not a URL Panorama can connect to"))?;
    let tls = match uri.scheme_str() {
        Some("wss") => true,
        Some("ws") => false,
        _ => return Err("A database URL has to start with wss:// or ws://".to_string()),
    };
    let host = uri
        .host()
        .ok_or_else(|| "A database URL has to name a host".to_string())?
        .to_string();
    let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
    Ok(Destination {
        tls,
        authority: format!("{host}:{port}"),
        host,
        port,
    })
}

/// Whether a handshake may be answered at all — the same rule as the agent
/// endpoint, and the same reason.
fn origin_allowed(origin: Option<&str>) -> bool {
    crate::agent::origin_allowed(origin)
}

/// Connects to the database, deciding about its certificate on the way.
async fn open_upstream(
    app: &AppHandle,
    destination: &Destination,
    target: &str,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Option<Trust>,
    ),
    String,
> {
    if !destination.tls {
        let stream = TcpStream::connect((destination.host.as_str(), destination.port))
            .await
            .map_err(|problem| format!("could not reach {}: {problem}", destination.authority))?;
        let (socket, _) = tokio_tungstenite::client_async(
            target,
            tokio_tungstenite::MaybeTlsStream::Plain(stream),
        )
        .await
        .map_err(|problem| {
            format!(
                "{} refused a WebSocket connection: {problem}",
                destination.authority
            )
        })?;
        return Ok((socket, None));
    }

    // The ordinary case first, with the system's own trust store and nothing
    // relaxed. A managed instance or Exasol SaaS ends here and is never asked
    // about.
    let strict = native_tls::TlsConnector::new()
        .map_err(|problem| format!("no TLS on this machine: {problem}"))?;
    let plain = TcpStream::connect((destination.host.as_str(), destination.port))
        .await
        .map_err(|problem| format!("could not reach {}: {problem}", destination.authority))?;
    let attempt = tokio_native_tls::TlsConnector::from(strict)
        .connect(&destination.host, plain)
        .await;
    let tls = match attempt {
        Ok(stream) => {
            let (socket, _) = tokio_tungstenite::client_async(
                target,
                tokio_tungstenite::MaybeTlsStream::NativeTls(stream),
            )
            .await
            .map_err(|problem| {
                format!(
                    "{} refused a WebSocket connection: {problem}",
                    destination.authority
                )
            })?;
            return Ok((socket, Some(Trust::Verified)));
        }
        Err(refused) => refused,
    };

    // It did not verify. Find out *what* is on the far end before deciding
    // anything: a second handshake, this time without verification, purely to
    // read the certificate. Nothing of the page's is sent over it unless the
    // answer below is yes.
    let lenient = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|problem| format!("no TLS on this machine: {problem}"))?;
    let plain = TcpStream::connect((destination.host.as_str(), destination.port))
        .await
        .map_err(|problem| format!("could not reach {}: {problem}", destination.authority))?;
    let stream = tokio_native_tls::TlsConnector::from(lenient)
        .connect(&destination.host, plain)
        .await
        .map_err(|_| {
            // Both handshakes failed, so this is not a question about trust.
            format!("TLS to {} failed: {tls}", destination.authority)
        })?;

    let certificate = stream
        .get_ref()
        .peer_certificate()
        .ok()
        .flatten()
        .ok_or_else(|| format!("{} presented no certificate", destination.authority))?;
    let der = certificate
        .to_der()
        .map_err(|problem| format!("could not read the certificate: {problem}"))?;
    let printed = trust::fingerprint(&der);

    let decision = if trust::is_loopback(&destination.host) {
        Trust::Loopback
    } else if trust::remembered(&destination.authority, &printed) {
        Trust::Remembered
    } else if ask(app, &destination.authority, &printed).await {
        trust::remember(&destination.authority, &printed);
        Trust::Remembered
    } else {
        return Err(format!(
            "The certificate for {} was not trusted, so nothing was sent to it. Its SHA-256 is {}.",
            destination.authority, printed
        ));
    };

    let (socket, _) = tokio_tungstenite::client_async(
        target,
        tokio_tungstenite::MaybeTlsStream::NativeTls(stream),
    )
    .await
    .map_err(|problem| {
        format!(
            "{} refused a WebSocket connection: {problem}",
            destination.authority
        )
    })?;
    Ok((socket, Some(decision)))
}

/// Asks the person, in the application's own window rather than in the page: the
/// question is about something the page cannot see and must not be able to answer
/// for itself.
async fn ask(app: &AppHandle, authority: &str, fingerprint: &str) -> bool {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(trust::question(authority, fingerprint, "—", "—"))
        .title("Unverified database certificate")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Trust and connect".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |trusted| {
            let _ = sender.send(trusted);
        });
    receiver.await.unwrap_or(false)
}

/// One page-side connection, from its handshake to its last frame.
async fn serve(app: AppHandle, stream: TcpStream, token: String, connections: Arc<AtomicU64>) {
    let asked: Arc<std::sync::Mutex<Option<Asked>>> = Arc::new(std::sync::Mutex::new(None));
    let seen = Arc::clone(&asked);
    let allowed = Arc::new(std::sync::Mutex::new(true));
    let origin_ok = Arc::clone(&allowed);

    let accepted = tokio_tungstenite::accept_hdr_async(
        stream,
        move |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
            let origin = request
                .headers()
                .get("origin")
                .and_then(|value| value.to_str().ok())
                .map(|value| value.to_string());
            if !origin_allowed(origin.as_deref()) {
                *origin_ok.lock().expect("origin") = false;
                let mut refusal = ErrorResponse::new(Some(
                    "This endpoint does not answer other origins.".to_string(),
                ));
                *refusal.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
                return Err(refusal);
            }
            *seen.lock().expect("asked") = parse_asked(&request.uri().to_string());
            Ok(response)
        },
    )
    .await;

    let Ok(page) = accepted else {
        if !*allowed.lock().expect("origin") {
            eprintln!("[panorama] a database connection was refused: wrong origin");
        }
        return;
    };

    let Some(asked) = asked.lock().expect("asked").take() else {
        close_with(page, "Ask for /database?token=…&target=wss://host:port.").await;
        return;
    };
    if asked.token != token {
        close_with(page, "That is not this application's token.").await;
        return;
    }
    let destination = match parse_destination(&asked.target) {
        Ok(destination) => destination,
        Err(problem) => {
            close_with(page, &problem).await;
            return;
        }
    };

    let upstream = match open_upstream(&app, &destination, &asked.target).await {
        Ok((socket, decision)) => {
            match decision {
                Some(Trust::Verified) => eprintln!(
                    "[panorama] connected to {} (certificate verified)",
                    destination.authority
                ),
                Some(Trust::Loopback) => eprintln!(
                    "[panorama] connected to {} (self-signed certificate, accepted because it is this machine)",
                    destination.authority
                ),
                Some(Trust::Remembered) => eprintln!(
                    "[panorama] connected to {} (certificate trusted by you earlier)",
                    destination.authority
                ),
                None => eprintln!("[panorama] connected to {} (no TLS)", destination.authority),
            }
            socket
        }
        Err(problem) => {
            eprintln!("[panorama] {problem}");
            // The reason travels in the close frame, so the page can show it
            // instead of "the connection failed".
            close_with(page, &problem).await;
            return;
        }
    };

    let open = connections.fetch_add(1, Ordering::Relaxed) + 1;
    eprintln!("[panorama] database socket carrying {open} connection(s)");
    let (mut to_page, mut from_page) = page.split();
    let (mut to_database, mut from_database) = upstream.split();

    // Two directions, and whichever ends first ends the connection: a database
    // that hangs up and a window that closes are the same event to the other side.
    let outward = async {
        while let Some(message) = from_page.next().await {
            let Ok(message) = message else { break };
            if to_database.send(message).await.is_err() {
                break;
            }
        }
    };
    let inward = async {
        while let Some(message) = from_database.next().await {
            let Ok(message) = message else { break };
            if to_page.send(message).await.is_err() {
                break;
            }
        }
    };
    tokio::select! {
        _ = outward => {},
        _ = inward => {},
    }
    let left = connections
        .fetch_sub(1, Ordering::Relaxed)
        .saturating_sub(1);
    eprintln!("[panorama] a database connection closed ({left} left)");
}

/// A refusal the page can read: the reason, in the close frame.
async fn close_with<S>(mut socket: tokio_tungstenite::WebSocketStream<S>, reason: &str)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;
    // A close reason is at most 123 bytes on the wire; longer than that and the
    // frame is invalid, which would turn an explanation into a mystery.
    let mut trimmed = reason.to_string();
    trimmed.truncate(120);
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code: CloseCode::Policy,
            reason: trimmed.into(),
        })))
        .await;
    let _ = socket.close(None).await;
}

/// Binds the proxy and serves it for the life of the process.
pub fn start(app: &AppHandle, token: String) -> Result<Proxy, String> {
    let mut bound = None;
    for offset in 0..PORT_ATTEMPTS {
        let port = PREFERRED_PORT + offset;
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            listener
                .set_nonblocking(true)
                .map_err(|problem| problem.to_string())?;
            bound = Some((listener, port));
            break;
        }
    }
    let (listener, port) = bound.ok_or_else(|| {
        format!(
            "no free port in {PREFERRED_PORT}..{}",
            PREFERRED_PORT + PORT_ATTEMPTS
        )
    })?;

    let connections = Arc::new(AtomicU64::new(0));
    let proxy = Proxy {
        port,
        token: token.clone(),
    };

    let handle = app.clone();
    // Tauri's own runtime, rather than one of this crate's: the application
    // already has a reactor, and a second one would be a second thing to shut
    // down.
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(problem) => {
                eprintln!("[panorama] the database proxy could not start: {problem}");
                return;
            }
        };
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let app = handle.clone();
                    let token = token.clone();
                    let connections = Arc::clone(&connections);
                    tauri::async_runtime::spawn(serve(app, stream, token, connections));
                }
                Err(problem) => {
                    eprintln!("[panorama] the database proxy stopped listening: {problem}");
                    return;
                }
            }
        }
    });

    Ok(proxy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_a_handshake_asked_for() {
        let asked = parse_asked("/database?token=abc&target=wss%3A%2F%2Flocalhost%3A8563")
            .expect("both parameters are there");
        assert_eq!(asked.token, "abc");
        assert_eq!(asked.target, "wss://localhost:8563");
    }

    #[test]
    fn refuses_a_handshake_that_is_missing_either_half() {
        assert!(parse_asked("/database").is_none());
        assert!(parse_asked("/database?token=abc").is_none());
        assert!(parse_asked("/database?target=wss://localhost:8563").is_none());
    }

    #[test]
    fn reads_the_address_out_of_a_target() {
        let destination = parse_destination("wss://localhost:8563").expect("a database URL");
        assert_eq!(
            destination,
            Destination {
                tls: true,
                host: "localhost".to_string(),
                port: 8563,
                authority: "localhost:8563".to_string(),
            }
        );
    }

    #[test]
    fn refuses_a_target_that_is_not_a_database_url() {
        // This opens a socket to wherever it is told, so the scheme is checked
        // rather than assumed: a file or an http URL is not a database.
        assert!(parse_destination("http://example.com").is_err());
        assert!(parse_destination("file:///etc/passwd").is_err());
        assert!(parse_destination("not a url at all").is_err());
        assert!(parse_destination("wss://").is_err());
    }

    #[test]
    fn a_url_with_no_port_takes_the_scheme_s_own() {
        assert_eq!(parse_destination("wss://db.internal").unwrap().port, 443);
        assert_eq!(parse_destination("ws://db.internal").unwrap().port, 80);
    }

    #[test]
    fn the_page_is_given_the_token_in_the_url_it_is_told_to_open() {
        let proxy = Proxy {
            port: 7356,
            token: "t0ken".to_string(),
        };
        assert_eq!(proxy.url(), "ws://127.0.0.1:7356/database?token=t0ken");
    }

    #[test]
    fn decodes_a_target_that_was_escaped_for_a_query_string() {
        assert_eq!(decode("wss%3A%2F%2Fa.b%3A1"), "wss://a.b:1");
        assert_eq!(decode("a+b"), "a b");
        // A stray percent is data, not a crash.
        assert_eq!(decode("100%"), "100%");
    }
}
