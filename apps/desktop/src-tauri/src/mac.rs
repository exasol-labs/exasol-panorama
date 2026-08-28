//! What macOS does to a window while it is being dragged, and how to stop it.
//!
//! A window being resized by its corner is resized by the window server, at the
//! frame rate of the drag. The web content cannot be re-laid-out and re-rendered
//! in that same instant — it is drawn in another process — so AppKit shows what it
//! has: the frame it already had, *scaled* to fill the frame it now needs. That is
//! why a resized window's contents warp, and it happens whatever the page does,
//! because the page is not involved.
//!
//! Two documented properties turn it off, and nothing else here is worth the risk
//! of guessing at:
//!
//!  - `preservesContentDuringLiveResize` is AppKit asking to reuse what it drew
//!    last time rather than ask for it again. That reuse is what the scaling
//!    serves; turning it off says the contents are cheap enough to draw again and
//!    must not be approximated. They are — the page keeps one drawing buffer for
//!    the life of the window and a resize only changes how much of it is on
//!    screen, see `PanoramaCanvas`.
//!  - `layerContentsPlacement` decides what happens to layer contents that *are*
//!    reused. The default, `scaleAxesIndependently`, is the stretching; `topLeft`
//!    anchors them at their natural size in the corner the layout grows from.
//!
//! Applied to the WKWebView and to every view above it up to the window, once,
//! because views are not remade. Earlier versions of this file also walked every
//! view and layer *below* the webview and repeated the walk throughout every drag.
//! That was guesswork: those layers are WebKit's, rebuilt from the web process on
//! its own schedule, so the walk was both overwritten and running at the one
//! moment the web process most needed the main thread. It is gone.

use objc2::rc::Retained;
use objc2_app_kit::{NSView, NSViewLayerContentsPlacement};
use tauri::WebviewWindow;

/// Stops the window's contents being approximated during a live resize.
///
/// Asynchronous, like everything that has to run on the main thread with the
/// webview in hand; a failure is logged rather than returned, because a window
/// that resizes badly is still a window.
pub fn hold_contents_still(window: &WebviewWindow) {
    let asked = window.with_webview(|platform| {
        // SAFETY: `inner()` is the window's WKWebView, which is an NSView, and
        // Tauri runs this closure on the main thread with the webview alive.
        let webview: Option<Retained<NSView>> =
            unsafe { Retained::retain(platform.inner().cast::<NSView>()) };
        let Some(webview) = webview else {
            eprintln!("[panorama] no webview to hold still");
            return;
        };

        let mut views = 0;
        let mut next = Some(webview.clone());
        while let Some(view) = next {
            view.setLayerContentsPlacement(NSViewLayerContentsPlacement::TopLeft);
            views += 1;
            next = unsafe { view.superview() };
        }

        let Some(pane) = webview.window() else {
            eprintln!("[panorama] anchored {views} view(s), but found no window");
            return;
        };
        pane.setPreservesContentDuringLiveResize(false);

        // Read back rather than assume: a property that did not take is a warp
        // that comes back, and this is the only evidence there is until somebody
        // drags the window.
        eprintln!(
            "[panorama] live resize: {views} view(s) anchored top-left ({}), content preserved {}",
            webview.layerContentsPlacement().0,
            pane.preservesContentDuringLiveResize()
        );
    });
    if let Err(problem) = asked {
        eprintln!("[panorama] could not reach the webview: {problem}");
    }
}
