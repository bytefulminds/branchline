//! Main window creation.
//!
//! On macOS the window uses an overlay title bar: the native close, minimize and zoom buttons
//! sit on top of Branchline's own 44 px title bar. Tauri places them with a fixed offset from
//! the top, but where that offset puts them depends on AppKit's button layout, which differs
//! between macOS versions (macOS 26 lays them out differently from earlier versions). So the
//! offset is worked out at startup from the real button geometry, keeping the buttons
//! vertically centered in the title bar on every version.

use tauri::{App, WebviewWindowBuilder};

/// Label of the main window in `tauri.conf.json`.
const MAIN: &str = "main";

/// Height of the frontend title bar (`--titlebar-height` in `src/styles/tokens.css`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const TITLEBAR_HEIGHT: f64 = 44.0;

/// Horizontal inset of the window buttons, matching `--mac-traffic-light-inset`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const TRAFFIC_LIGHT_X: f64 = 16.0;

/// Offset used when the button geometry cannot be read (centered on macOS 15 and earlier).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const FALLBACK_Y: f64 = 20.0;

/// The vertical offset to give Tauri so the buttons' centers land on `center` (from the top).
///
/// Tauri sizes the buttons' title bar container to `button_height + y` and leaves each button
/// at its distance from the container's bottom (`bottom_offset`), so a button's center ends up
/// at `y + button_height / 2 - bottom_offset` from the top of the window.
pub fn traffic_light_y(center: f64, button_height: f64, bottom_offset: f64) -> f64 {
    center - button_height / 2.0 + bottom_offset
}

/// Create the main window. On macOS it is not created from the config automatically
/// (`"create": false` in `tauri.macos.conf.json`) so the button offset can be set first.
pub fn create_main(app: &App) -> tauri::Result<()> {
    if app
        .config()
        .app
        .windows
        .iter()
        .any(|w| w.label == MAIN && w.create)
    {
        // Created by Tauri from the config (Windows and Linux).
        return Ok(());
    }
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN)
        .cloned()
    else {
        return Ok(());
    };
    let builder = WebviewWindowBuilder::from_config(app.handle(), &config)?;
    #[cfg(target_os = "macos")]
    let builder = {
        let y = macos::centered_y(TITLEBAR_HEIGHT / 2.0).unwrap_or(FALLBACK_Y);
        builder.traffic_light_position(tauri::LogicalPosition::new(TRAFFIC_LIGHT_X, y))
    };
    builder.build()?;
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSBackingStoreType, NSWindow, NSWindowButton, NSWindowStyleMask, NSWindowTitleVisibility,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    /// Read the standard button layout from a throwaway window with the same style as the main
    /// window (never shown), and return the offset that centers the buttons on `center`.
    pub fn centered_y(center: f64) -> Option<f64> {
        let mtm = MainThreadMarker::new()?;
        let style = NSWindowStyleMask::Titled
            | NSWindowStyleMask::Closable
            | NSWindowStyleMask::Miniaturizable
            | NSWindowStyleMask::Resizable
            | NSWindowStyleMask::FullSizeContentView;
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(800.0, 600.0));
        // SAFETY: called on the main thread with a valid style mask and backing type; the
        // window is never shown and is released when `probe` goes out of scope.
        let probe = unsafe {
            let w = NSWindow::initWithContentRect_styleMask_backing_defer(
                mtm.alloc(),
                rect,
                style,
                NSBackingStoreType::Buffered,
                true,
            );
            w.setReleasedWhenClosed(false);
            w
        };
        probe.setTitlebarAppearsTransparent(true);
        probe.setTitleVisibility(NSWindowTitleVisibility::Hidden);

        let close = probe.standardWindowButton(NSWindowButton::CloseButton)?;
        // The same container Tauri resizes: the button's superview's superview.
        // SAFETY: the views are owned by `probe`, which outlives this use.
        let container = unsafe { close.superview()?.superview()? };
        if container.isFlipped() {
            return None;
        }
        let frame = close.convertRect_toView(close.bounds(), Some(&container));
        let y = super::traffic_light_y(center, frame.size.height, frame.origin.y);
        if cfg!(debug_assertions) {
            eprintln!(
                "branchline: window buttons {}x{} at {} from the title bar bottom; using y = {y}",
                frame.size.width, frame.size.height, frame.origin.y
            );
        }
        // Guard against an unexpected layout putting the buttons outside the title bar.
        (4.0..=center * 2.0 - 4.0).contains(&y).then_some(y)
    }
}

#[cfg(test)]
mod tests {
    use super::traffic_light_y;

    #[test]
    fn centers_the_buttons_in_the_title_bar() {
        // macOS 15: 16 px tall buttons, 6 px above the bottom of a 28 px title bar.
        assert_eq!(traffic_light_y(22.0, 16.0, 6.0), 20.0);
        // A layout with the buttons further from the bottom needs a larger offset.
        assert_eq!(traffic_light_y(22.0, 14.0, 9.0), 24.0);
        // Resulting center: y + h/2 - bottom offset.
        let y = traffic_light_y(22.0, 18.0, 7.0);
        assert_eq!(y + 9.0 - 7.0, 22.0);
    }
}
