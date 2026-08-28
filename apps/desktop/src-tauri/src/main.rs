// No console window on Windows for a release build: this is a graphical
// application, and a second window behind it is somebody's bug report.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod claude;
mod database;
mod exasol;
mod locate;
#[cfg(target_os = "macos")]
mod mac;
mod pipe;
mod session;
mod trust;

use std::sync::Arc;

// `manage` and `handle` live on this trait.
use tauri::Manager;

/// One binary, two roles.
///
/// Started by a person it opens a window; started by an agent's client with
/// `--mcp-stdio` it is the pipe to whichever window is open, and opens one if a
/// call needs it. That is what makes this a single application rather than an
/// application and a server: the file a user installs is the file they paste into
/// `claude mcp add`, and neither of them has a port in it.
fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.iter().any(|argument| argument == "--mcp-stdio") {
        pipe::run();
    }
    if arguments
        .iter()
        .any(|argument| argument == "--help" || argument == "-h")
    {
        println!("{USAGE}");
        return;
    }
    window();
}

const USAGE: &str = "Exasol Panorama — a spatial canvas for exploring data in Exasol.

  panorama-desktop                opens the application
  panorama-desktop --mcp-stdio    speaks Model Context Protocol on stdin/stdout,
                                  to a running window or to one it starts

An agent is pointed at the second form; nothing else has to be installed, and
there is no port to agree on — a running window writes where it is to
~/.panorama/sessions.";

/// Runs work that waits, somewhere that is not the main thread.
///
/// A synchronous `#[tauri::command]` runs on the main thread, and the main thread
/// is the one drawing the window: anything it waits for is an application that has
/// stopped responding and, after a moment, a spinning cursor. Every command below
/// waits for something — a process to start and answer, a login shell to read a
/// person's profile, a socket to accept or refuse a connection — so none of them
/// runs there.
///
/// `spawn_blocking` rather than `spawn`, because the async runtime's worker
/// threads also carry the database socket and the agent endpoint. An `exasol
/// status` against an unreachable database has been measured taking minutes; that
/// belongs on a thread whose only job is to wait, not on one somebody's query is
/// sharing.
///
/// `None` only if the work panicked, which is a bug rather than a condition — but
/// a bug that used to take the window with it, and now costs one answer. Each
/// caller says what it says when it could not find out.
///
/// The commands that stay synchronous do so because they wait for nothing:
/// `report_timing` and `database_proxy`, and the agent's four, take a lock or a
/// counter and return. Moving those to another thread would buy a scheduling hop
/// and nothing else.
async fn off_main<T: Send + 'static>(
    what: &str,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(answer) => Some(answer),
        Err(problem) => {
            eprintln!("[panorama] {what} did not finish: {problem}");
            None
        }
    }
}

/// What Claude there is on this machine, and whether it knows about us.
#[tauri::command]
async fn claude_status(app: tauri::AppHandle) -> claude::Status {
    // Read here, where it is a lock and a string, rather than sent to the thread:
    // `State` borrows from the handle, and nothing borrowed may cross an await.
    let url = {
        let state = app.state::<Arc<agent::AgentState>>();
        state.status().mcp_url()
    };
    let asked = url.clone();
    off_main("reading Claude's status", move || claude::status(asked))
        .await
        .unwrap_or_else(|| claude::Status::nothing_found(url))
}

/// Tells Claude about this application — the executable, not a port, so the
/// pairing does not go stale when the application moves or the port changes.
#[tauri::command]
async fn claude_pair() -> Vec<claude::PairOutcome> {
    off_main("pairing with Claude", claude::pair)
        .await
        .unwrap_or_default()
}

/// Opens Claude: the application where there is one, the command line otherwise.
#[tauri::command]
async fn claude_open(prefer: Option<String>) -> claude::OpenOutcome {
    off_main("opening Claude", move || claude::open(prefer.as_deref()))
        .await
        .unwrap_or_else(|| claude::OpenOutcome {
            opened: None,
            detail: "Panorama could not finish opening Claude.".to_string(),
        })
}

/// The databases Exasol Personal manages, from the `exasol` command.
///
/// Empty where Exasol Personal is not installed, which is how the dialog knows to
/// offer nothing rather than an empty list. `checked` asks each one how it is,
/// which is the slow and truthful form; without it this answers instantly with the
/// names and nothing offered as connectable.
#[tauri::command]
async fn exasol_deployments(detail: Option<String>) -> exasol::Local {
    off_main("listing deployments", move || deployments_now(detail))
        .await
        .unwrap_or_else(exasol::Local::nothing_found)
}

/// The body of the command above, on whichever thread it was given.
fn deployments_now(detail: Option<String>) -> exasol::Local {
    let asked = exasol::Detail::from_name(detail.as_deref());
    let here = exasol::local(asked);
    // Said out loud, because the alternative is a section that is silently absent:
    // a machine that has Exasol Personal but where this could not find it looks
    // exactly like a machine that has none.
    eprintln!(
        "[panorama] exasol command {}; {} deployment(s){}",
        if here.installed { "found" } else { "not found" },
        here.deployments.len(),
        if asked == exasol::Detail::Names {
            String::new()
        } else {
            format!(
                ", {} connectable",
                here.deployments
                    .iter()
                    .filter(|one| one.url.is_some())
                    .count()
            )
        }
    );
    here
}

/// What one of them needs to be connected to — including its password, which is
/// read now rather than when the list was drawn, and goes straight into a
/// connection.
#[tauri::command]
async fn exasol_deployment_credentials(name: String) -> Result<exasol::Credentials, String> {
    let asked = name.clone();
    off_main("reading a deployment's password", move || {
        exasol::credentials(&asked)
    })
    .await
    .unwrap_or_else(|| Err(format!("Panorama could not read the password for {name}.")))
}

/// How long something in the page took, measured from when this process started.
///
/// Instantness is a requirement of this application, and a requirement nobody
/// measures is a wish. The page reports the two moments a person actually
/// experiences — the interface appearing, and the canvas beginning to draw — and
/// they end up in the same log as the endpoint and the socket, next to the launch
/// they belong to.
#[tauri::command]
fn report_timing(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<agent::AgentState>>,
    stage: String,
) {
    // The page has drawn, so WebKit has made the layers it draws into, so there is
    // something to anchor that did not exist when the window opened — see `mac`.
    #[cfg(target_os = "macos")]
    mac::hold_contents_still(&window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    // The stage is text from the page, on its way into a log line: one line, and a
    // length nobody has to scroll.
    let stage: String = stage
        .chars()
        .filter(|character| *character != '\n' && *character != '\r')
        .take(60)
        .collect();
    eprintln!(
        "[panorama] {stage} {}ms after launch",
        state.started.elapsed().as_millis()
    );
}

/// Where the page opens its database socket, token and all.
///
/// Answered over the shell's own IPC rather than put in the bundle, because it
/// carries a secret that is new every run — and because a page that was *not*
/// given one has no way to guess it.
#[tauri::command]
fn database_proxy(proxy: tauri::State<'_, database::Proxy>) -> String {
    proxy.url()
}

/// Opens the window, with the agent endpoint behind it.
fn window() {
    // A fresh secret per run, written to the session file where only this user can
    // read it. What it defends against is another program on this machine — the
    // endpoint can drive a live database session, and loopback alone does not say
    // *who* may.
    let state = Arc::new(agent::AgentState::new(uuid::Uuid::new_v4().to_string()));
    let owned = Arc::clone(&state);
    // A second secret for the database socket. Two rather than one because they
    // are two different powers: reading the canvas, and opening a connection to a
    // database with the credentials of whoever is at the keyboard.
    let socket_token = uuid::Uuid::new_v4().to_string();

    let application = tauri::Builder::default()
        // First, and deliberately: everything after this only runs in the process
        // that owns the application. A second launch — from the Dock, from Spotlight,
        // from an agent's pipe — hands its arguments to this one and exits, and what
        // the person gets is the window they already had rather than a second copy of
        // their canvas.
        .plugin(tauri_plugin_single_instance::init(|app, _arguments, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // Size and position, remembered. A window that opens where it was left is
        // most of what "it behaves like an application" means.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::clone(&state))
        .invoke_handler(tauri::generate_handler![
            agent::agent_attach,
            agent::agent_detach,
            agent::agent_reply,
            agent::agent_status,
            claude_status,
            claude_pair,
            claude_open,
            exasol_deployments,
            exasol_deployment_credentials,
            report_timing,
            database_proxy
        ])
        .setup(move |app| {
            // Not fatal, deliberately: a window with no agent is a worse Panorama,
            // and a Panorama that refuses to open because a port was busy is not
            // one at all. So this is reported and the application starts.
            match agent::start(&app.handle().clone(), Arc::clone(&owned)) {
                Ok(port) => eprintln!(
                    "[panorama] agent endpoint on http://127.0.0.1:{port}/agent/mcp (token in ~/.panorama/sessions)"
                ),
                Err(problem) => eprintln!("[panorama] no agent endpoint: {problem}"),
            }
            // The database socket. Also not fatal: without it the application can
            // still reach an instance whose certificate the system trusts, which
            // is what a browser can do, so the failure is a lost capability rather
            // than a broken application.
            // Worked out before the page asks, because the answer takes about a
            // second and the page asks a few hundred milliseconds from now. In a
            // thread of its own — see `exasol::warm`.
            exasol::warm();
            match database::start(&app.handle().clone(), socket_token) {
                Ok(proxy) => {
                    eprintln!(
                        "[panorama] database socket on ws://127.0.0.1:{}/database",
                        proxy.port
                    );
                    app.handle().manage(proxy);
                }
                Err(problem) => eprintln!("[panorama] no database socket: {problem}"),
            }
            // The window as it actually came up, which is not always the window
            // that was configured: the size is restored from the last run, and a
            // window restored four times too large is a slow first frame that
            // looks like a slow application.
            if let Some(window) = app.get_webview_window("main") {
                // The *webview's* own background, not only the window's. During a
                // live resize the window server resizes the layer before the page
                // can repaint it, and whatever the layer's background is is what
                // shows in the meantime. Both are set to the colour the canvas
                // clears to, so there is nothing for a resize to flash to.
                let canvas_grey = tauri::window::Color(0xf1, 0xf3, 0xf5, 0xff);
                let _ = window.set_background_color(Some(canvas_grey));
                let _ = window.as_ref().window().set_background_color(Some(canvas_grey));
                // And the layers themselves must not be scaled to fill a window
                // that has changed size — see `mac`.
                #[cfg(target_os = "macos")]
                mac::hold_contents_still(&window);
                let scale = window.scale_factor().unwrap_or(1.0);
                if let Ok(size) = window.inner_size() {
                    eprintln!(
                        "[panorama] window {}x{} physical at scale {scale} ({}x{} logical)",
                        size.width,
                        size.height,
                        (f64::from(size.width) / scale).round(),
                        (f64::from(size.height) / scale).round()
                    );
                }
            }
            eprintln!(
                "[panorama] shell ready {}ms after launch",
                owned.started.elapsed().as_millis()
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Panorama could not open a window");

    application.run(|_handle, event| {
        // The session file is how a pipe finds this window; leaving one behind
        // after the window has gone would send the next call somewhere that is not
        // listening. A crash still leaves one, which is why a reader checks the pid.
        if matches!(event, tauri::RunEvent::Exit) {
            session::remove(std::process::id());
        }
    });
}
