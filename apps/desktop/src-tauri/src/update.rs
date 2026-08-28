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
const FIRST_LOOK: Duration = Duration::from_secs(60);

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
        tokio::time::sleep(FIRST_LOOK).await;
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

/// Installs a staged update while the window closes, and then exits.
///
/// Returns whether it took the close over. `false` means there was nothing to
/// install and the window should shut the ordinary way.
///
/// The window is hidden first, and that is the point rather than a detail: the
/// application *looks* closed the instant it was asked to be, and the unpacking
/// happens behind something nobody is looking at. What would otherwise be a hang
/// becomes invisible.
///
/// On Windows the installer terminates the application itself as part of running
/// — a documented limitation rather than a choice — so there the exit below may
/// never be reached. The sequence is the same either way.
pub fn install_on_close(window: &tauri::Window, updates: &Arc<Updates>) -> bool {
    let Some(staged) = updates.take() else {
        return false;
    };
    let _ = window.hide();
    let app = window.app_handle().clone();

    std::thread::spawn(move || {
        let version = staged.version.clone();
        let (done, finished) = std::sync::mpsc::channel();
        // On a thread of its own so the deadline below is ours rather than the
        // installer's: an install that wedges must not wedge the quit.
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
        app.exit(0);
    });
    true
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
        assert!(FIRST_LOOK >= Duration::from_secs(30), "not during startup");
        assert!(
            LOOK_EVERY >= Duration::from_secs(60 * 60),
            "a courtesy, not a poll"
        );
        // And a quit gives up long before anybody would call it broken.
        assert!(INSTALL_LIMIT <= Duration::from_secs(30));
    }
}
