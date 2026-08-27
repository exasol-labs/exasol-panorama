// No console window on Windows for a release build: this is a graphical
// application, and a second window behind it is somebody's bug report.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Opens a window onto the web build, and nothing else.
///
/// What belongs here eventually is the agent endpoint — the thing an installed
/// Panorama has no development server to get it from — reached from the page over
/// this shell's own IPC rather than over a socket the browser would have to be
/// allowed to open. That is the next step, and it is why this crate exists at all;
/// see `plans/panorama-agent-local-plan.md`.
///
/// What does *not* belong here is any part of the document, the renderer or the
/// tool catalogue. One copy of those, in TypeScript, is the whole reason an agent
/// and a person are looking at the same thing.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Panorama could not open a window");
}
