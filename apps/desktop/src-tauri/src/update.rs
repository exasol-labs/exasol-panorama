//! Keeping the application current without ever being the reason somebody waits.
//!
//! The policy, in one line: **notice quietly, say so quietly, install on the way
//! out.** Three moments are ruled out by name, and each of them is where update
//! mechanisms usually put themselves —
//!
//! - **Not at startup.** Launch is where patience is thinnest and where the whole
//!   application is being judged. `first frame drawn 796ms after launch` is a
//!   number this project measures on purpose.
//! - **Not while running.** An application that stops to install something has
//!   taken the canvas away to do its own errand, at a moment nothing the user did
//!   caused.
//! - **Not by asking.** A dialog offering to update is still an interruption.
//!
//! What is left is the moment somebody has already decided to stop. They are
//! leaving anyway, they expect the window to go away, and a few seconds there
//! costs nothing because there is nothing left to interrupt.
//!
//! So the download happens while the application runs and the *install* happens
//! while it closes. That split is the whole design. Downloading at quit instead
//! would mean a quit that fetches forty megabytes over a hotel network — a quit
//! that hangs, which nobody can tell from a crash. By the time the window closes
//! the bytes are already here and the only work left is to unpack them.
//!
//! None of it runs on the main thread. A release check is a network round trip
//! and a download is many; both would be the spinning cursor this exists to
//! avoid. See `off_main` in `main`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// How long after launch before the first look. Late, deliberately.
///
/// Overridable only so that a probe need not sit through it: driving the whole
/// mechanism — stage, close, install, relaunch — is slow enough without waiting a
/// minute to start. Nothing but `scripts/update-check.mjs` sets it.
fn first_look() -> Duration {
    std::env::var("PANORAMA_UPDATE_FIRST_LOOK_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map_or(Duration::from_secs(60), Duration::from_millis)
}

/// And how often after that. Rare: this is a courtesy, not a heartbeat.
const LOOK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);

/// How long a quit may spend installing before it gives up and quits anyway.
///
/// Unpacking a downloaded bundle is a second or two. A quit that does not quit is
/// worse than an update that waits until tomorrow, so past this the staged bytes
/// are abandoned and the window closes. Nothing is lost that a later run cannot
/// fetch again.
const INSTALL_LIMIT: Duration = Duration::from_secs(20);

/// An update, downloaded and waiting for the application to close.
struct Staged {
    version: String,
    update: Update,
    bytes: Vec<u8>,
}

/// What the shell knows about a newer Panorama.
#[derive(Default)]
pub struct Updates {
    staged: Mutex<Option<Staged>>,
    /// Said once. A machine with no network is not a machine with a problem, and
    /// a check that fails every four hours must not fill the log with it.
    complained: AtomicBool,
}

impl Updates {
    /// The version waiting to be installed, for the page to put on screen.
    pub fn staged_version(&self) -> Option<String> {
        self.staged
            .lock()
            .ok()
            .and_then(|staged| staged.as_ref().map(|one| one.version.clone()))
    }

    fn hold(&self, staged: Staged) {
        if let Ok(mut held) = self.staged.lock() {
            *held = Some(staged);
        }
    }

    fn take(&self) -> Option<Staged> {
        self.staged.lock().ok().and_then(|mut held| held.take())
    }
}

/// Looks for a newer Panorama, on a schedule that starts well after launch.
///
/// Nothing is checked until a minute has passed, and nothing at all is checked
/// while something is already staged: the answer would not change what happens
/// next, and the download would be a second copy of a decision already made.
pub fn watch(app: &AppHandle, updates: Arc<Updates>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(first_look()).await;
        loop {
            if updates.staged_version().is_none() {
                look_once(&app, &updates).await;
            }
            tokio::time::sleep(LOOK_EVERY).await;
        }
    });
}

async fn look_once(app: &AppHandle, updates: &Updates) {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(problem) => return grumble(updates, &format!("no updater: {problem}")),
    };
    let found = match updater.check().await {
        Ok(Some(update)) => update,
        // Nothing newer, which is the ordinary answer and worth no words at all.
        Ok(None) => return,
        Err(problem) => return grumble(updates, &format!("could not ask: {problem}")),
    };

    let version = found.version.clone();
    // Downloaded now, while there is nobody waiting on it, so that closing the
    // window later costs an unpack rather than a download.
    match found.download(|_chunk, _total| {}, || {}).await {
        Ok(bytes) => {
            eprintln!(
                "[panorama] {version} downloaded and staged ({} MB); it installs when this window closes",
                bytes.len() / 1_048_576
            );
            updates.hold(Staged {
                version,
                update: found,
                bytes,
            });
        }
        Err(problem) => grumble(updates, &format!("could not fetch {version}: {problem}")),
    }
}

/// Says something the first time it goes wrong, and nothing afterwards.
fn grumble(updates: &Updates, what: &str) {
    if !updates.complained.swap(true, Ordering::Relaxed) {
        eprintln!("[panorama] update check: {what}");
    }
}

/// Installs a staged update as the application goes, and then exits.
///
/// Returns whether it took the closing over. `false` means there was nothing
/// staged and everything should shut the ordinary way.
///
/// Called from **both** ways out, which is not belt and braces: closing the last
/// window and quitting outright are different events, and on macOS — where Cmd-Q
/// is how most people leave an application — only the second one happens. Hooking
/// the window alone would have meant the update installed for people who click
/// the red button and never for anybody else. `take` hands the staged update over
/// exactly once, so whichever event arrives first does the work and the other
/// finds nothing to do.
///
/// Every window is hidden first, and that is the point rather than a detail: the
/// application *looks* closed the instant it was asked to be, and the unpacking
/// happens behind something nobody is looking at. What would otherwise be a hang
/// becomes invisible.
///
/// On Windows the installer terminates the application itself as part of running
/// — a documented limitation rather than a choice — so there the exit below may
/// never be reached. The sequence is the same either way.
pub fn install_while_closing(app: &AppHandle, updates: &Arc<Updates>) -> bool {
    let Some(staged) = updates.take() else {
        return false;
    };
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
    let app = app.clone();
    std::thread::spawn(move || {
        unpack(staged);
        app.exit(0);
    });
    true
}

/// The last chance to install, taken on the way out rather than instead of going.
///
/// `Exit` is not a request and cannot be refused — the loop has already ended —
/// so this blocks the thread that is leaving rather than returning and hoping.
/// It is bounded by the same deadline as everything else, because a quit that
/// hangs is worse than an update that waits.
///
/// It exists because the two events above do not fire for the way most people
/// leave a macOS application. Cmd-Q, the Dock's Quit and an Apple Event all reach
/// `applicationShouldTerminate`, which produces exactly one Tauri event, and it is
/// this one: no `CloseRequested`, no `ExitRequested`. Hooking only those two meant
/// the update installed for somebody who clicks the red button and for nobody
/// else — which `scripts/update-check.mjs` found by quitting the way a person
/// does, and which nothing smaller than that would have noticed.
pub fn install_before_exit(app: &AppHandle, updates: &Arc<Updates>) {
    let Some(staged) = updates.take() else {
        return;
    };
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
    unpack(staged);
}

/// Unpacks a staged update, says what happened, and gives up in time.
fn unpack(staged: Staged) {
    let version = staged.version.clone();
    let (done, finished) = std::sync::mpsc::channel();
    // On a thread of its own so the deadline is ours rather than the installer's:
    // an install that wedges must not wedge the quit.
    std::thread::spawn(move || {
        let _ = done.send(staged.update.install(&staged.bytes));
    });
    match finished.recv_timeout(INSTALL_LIMIT) {
        Ok(Ok(())) => eprintln!("[panorama] {version} installed; it starts next time"),
        Ok(Err(problem)) => eprintln!("[panorama] {version} did not install: {problem}"),
        Err(_) => eprintln!(
            "[panorama] {version} was still installing after {INSTALL_LIMIT:?}; closing anyway"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Nothing staged means nothing to say, and nothing to do on the way out.
    #[test]
    fn says_nothing_until_something_is_waiting() {
        let updates = Updates::default();
        assert_eq!(updates.staged_version(), None);
        assert!(updates.take().is_none());
    }

    /// Said once. A laptop that spends a week off the network would otherwise
    /// write the same sentence to the log forty times.
    #[test]
    fn complains_about_a_failing_check_only_the_first_time() {
        let updates = Updates::default();
        assert!(!updates.complained.load(Ordering::Relaxed));
        grumble(&updates, "no network");
        assert!(updates.complained.load(Ordering::Relaxed));
        // The second one is swallowed; all this asserts is that the flag latches,
        // which is what decides whether anything is printed.
        grumble(&updates, "still no network");
        assert!(updates.complained.load(Ordering::Relaxed));
    }

    /// The schedule is the policy: nothing at launch, and rarely after that.
    #[test]
    fn looks_late_and_seldom() {
        assert!(
            first_look() >= Duration::from_secs(30),
            "not during startup"
        );
        assert!(
            LOOK_EVERY >= Duration::from_secs(60 * 60),
            "a courtesy, not a poll"
        );
        // And a quit gives up long before anybody would call it broken.
        assert!(INSTALL_LIMIT <= Duration::from_secs(30));
    }

    /// The probe drives the whole mechanism — stage, quit, install, relaunch —
    /// and cannot spend a minute of that waiting to start.
    #[test]
    fn lets_a_probe_shorten_the_wait() {
        // Not run in parallel with the test above: both read the same variable,
        // and Rust's test harness threads share an environment. Hence one test.
        assert_eq!(first_look(), Duration::from_secs(60));
        // SAFETY: single-threaded within this test, and unset before it returns.
        unsafe { std::env::set_var("PANORAMA_UPDATE_FIRST_LOOK_MS", "250") };
        assert_eq!(first_look(), Duration::from_millis(250));
        unsafe { std::env::set_var("PANORAMA_UPDATE_FIRST_LOOK_MS", "not a number") };
        assert_eq!(first_look(), Duration::from_secs(60), "nonsense is ignored");
        unsafe { std::env::remove_var("PANORAMA_UPDATE_FIRST_LOOK_MS") };
    }
}
