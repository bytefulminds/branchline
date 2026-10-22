//! Startup and interaction timing (`branchline --measure-startup=<file.json> <repository>`).
//!
//! The frontend records how long the first frame, opening the repository, History, a diff
//! and the command palette take, then hands the report here. It is written as JSON and the
//! app quits, so CI and people can compare builds on every platform the same way.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

static STARTED: OnceLock<Instant> = OnceLock::new();
static WINDOW_CREATED_MS: OnceLock<f64> = OnceLock::new();

const FLAG: &str = "--measure-startup=";

/// Call first thing in `main`, so times count from process start.
pub fn mark_process_start() {
    let _ = STARTED.get_or_init(Instant::now);
}

/// Record when the main window was created (before the web view has loaded).
pub fn mark_window_created() {
    let _ = WINDOW_CREATED_MS.set(elapsed_ms());
}

/// Milliseconds since the process started.
pub fn elapsed_ms() -> f64 {
    STARTED.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// The report file when started with `--measure-startup=<file>`.
pub fn output_from_args<I: IntoIterator<Item = std::ffi::OsString>>(args: I) -> Option<PathBuf> {
    args.into_iter()
        .map(|a| a.to_string_lossy().into_owned())
        .find_map(|a| a.strip_prefix(FLAG).map(PathBuf::from))
        .filter(|p| !p.as_os_str().is_empty())
}

pub fn output() -> Option<PathBuf> {
    output_from_args(std::env::args_os().skip(1))
}

/// Write the report with platform details added.
pub fn write_report(path: &std::path::Path, mut report: serde_json::Value) -> std::io::Result<()> {
    if let Some(obj) = report.as_object_mut() {
        if let Some(ms) = WINDOW_CREATED_MS.get() {
            obj.insert("windowCreatedMs".into(), (*ms).into());
        }
        obj.insert("os".into(), std::env::consts::OS.into());
        obj.insert("arch".into(), std::env::consts::ARCH.into());
        obj.insert("version".into(), env!("CARGO_PKG_VERSION").into());
        obj.insert(
            "build".into(),
            if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }
            .into(),
        );
    }
    let text = serde_json::to_string_pretty(&report).map_err(std::io::Error::other)?;
    std::fs::write(path, text + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_flag_only_with_a_file() {
        let args = |v: &[&str]| v.iter().map(std::ffi::OsString::from).collect::<Vec<_>>();
        assert_eq!(
            output_from_args(args(&["/repo", "--measure-startup=out.json"])),
            Some(PathBuf::from("out.json"))
        );
        assert_eq!(output_from_args(args(&["--measure-startup="])), None);
        assert_eq!(output_from_args(args(&["/repo"])), None);
    }

    #[test]
    fn writes_platform_details() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("r.json");
        write_report(&file, serde_json::json!({ "repoReadyMs": 12.5 })).unwrap();
        let back: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
        assert_eq!(back["repoReadyMs"], 12.5);
        assert_eq!(back["os"], std::env::consts::OS);
    }
}
